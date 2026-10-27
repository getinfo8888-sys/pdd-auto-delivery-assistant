'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const {Engine,defaults}=require('../src/core/engine.cjs');
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pdd-catchup-'));
  t.after(()=>{if(path.dirname(dir)!==path.resolve(os.tmpdir())||!path.basename(dir).startsWith('pdd-catchup-'))throw Error('Unsafe cleanup');fs.rmSync(dir,{recursive:true,force:true});});
  let now=Date.now();const filePath=path.join(dir,'state.json');let response={status:'rejected',reason:'duplicate'};const calls=[];
  const sendMessage=async job=>{calls.push(job);return response;};
  const create=()=>new Engine({filePath,sendMessage,now:()=>now});const engine=create();
  engine.updateConfig({...defaults,running:true,autoReplyEnabled:true,catchUpUnrepliedEnabled:true,greetingEnabled:false,fallback:'默认说明',cooldownSeconds:10,
    replyRules:[{id:'trial',name:'试玩',keywords:['试玩'],content:'试玩内容',enabled:true}]});
  const message=(extra={})=>({shopId:'shop',buyerId:'buyer',messageId:'message',text:'我要试玩',direction:'incoming',pending:true,sentAt:now-60000,...extra});
  return {engine,create,filePath,message,calls,advance:ms=>{now+=ms;},response:value=>{response=value;}};
}
test('a verified previously rejected message is recovered by current rules and only once across launches',async t=>{
  const f=fixture(t);const old=f.engine.ingestMessage(f.message());await f.engine.dispatch(old.id);assert.equal(f.engine.snapshot().jobs.at(-1).status,'blocked');
  f.engine.updateConfig({...f.engine.snapshot().config,replySuffixEnabled:true});
  const recovery=f.engine.recoverUnrepliedMessage(f.message());assert.equal(recovery.status,'created');assert.equal(recovery.job.content,'试玩内容');assert.equal(recovery.job.catchUp,true);
  assert.equal(f.engine.nextJob(),null,'cooldown is queued, not discarded');f.advance(11000);await f.engine.dispatch(recovery.job.id);
  assert.equal(f.engine.recoverUnrepliedMessage(f.message()).status,'already_attempted');
  const reopened=f.create();reopened.setRunning(true);assert.equal(reopened.recoverUnrepliedMessage(f.message()).status,'already_attempted');assert.equal(f.calls.length,2);
});
test('successful, uncertain, queued and cancelled replies are not duplicated by catch-up',async t=>{
  for(const status of ['sent','uncertain','queued','cancelled']) {
    const f=fixture(t);const first=f.engine.ingestMessage(f.message());
    if(status==='sent'){f.response({status:'confirmed',messageId:'server'});await f.engine.dispatch(first.id);}
    if(status==='uncertain'){f.response({status:'uncertain'});await f.engine.dispatch(first.id);}
    if(status==='cancelled')f.engine.ingestMessage(f.message({messageId:'manual',direction:'outgoing',text:'已回复',sentAt:f.message().sentAt+1000}));
    const count=f.engine.snapshot().jobs.length;assert.notEqual(f.engine.recoverUnrepliedMessage(f.message()).status,'created');assert.equal(f.engine.snapshot().jobs.length,count);
  }
});
test('catch-up chooses a keyword or fallback without resending the welcome',t=>{
  const f=fixture(t);f.engine.updateConfig({...f.engine.snapshot().config,greetingEnabled:true,greeting:'欢迎'});
  assert.equal(f.engine.recoverUnrepliedMessage(f.message()).job.content,'试玩内容');
  assert.equal(f.engine.recoverUnrepliedMessage(f.message({buyerId:'b2',messageId:'m2',text:'你好'})).job.content,'默认说明');assert.equal(f.engine.snapshot().jobs.length,2);
});
test('changed contents may recover an explicitly rejected attempt, with a fresh durable claim',async t=>{
  const f=fixture(t);const first=f.engine.recoverUnrepliedMessage(f.message());await f.engine.dispatch(first.job.id);
  const config=f.engine.snapshot().config;config.replyRules[0].content='新的试玩说明';f.engine.updateConfig(config);
  assert.equal(f.engine.recoverUnrepliedMessage(f.message()).job.content,'新的试玩说明');
});
test('an answered or changed conversation cancels a queued recovery without counting a send',async t=>{
  const f=fixture(t);const recovered=f.engine.recoverUnrepliedMessage(f.message());f.response({status:'skipped',reason:'买家已收到人工回复'});
  const result=await f.engine.dispatch(recovered.job.id);assert.equal(result.status,'cancelled');assert.equal(result.reason,'conversation_changed');assert.equal(f.engine.snapshot().stats.sent,0);assert.equal(f.engine.snapshot().stats.cancelled,1);
});

test('verified official-robot pending evidence recovers a preflight cancellation across restarts',async t=>{
  const f=fixture(t),source=f.message();f.response({status:'skipped',reason:'会话已有回复'});
  const original=f.engine.ingestMessage(source);await f.engine.dispatch(original.id);
  const evidence={automaticMessageId:'robot-message',sourceMessageId:source.messageId,pendingSince:source.sentAt,historyVerified:true};
  assert.equal(f.engine.recoverUnrepliedMessage(source).status,'needs_review');
  const reopened=f.create();reopened.setRunning(true);
  const recovery=reopened.recoverUnrepliedMessage({...source,officialAutoReplyPending:evidence});
  assert.equal(recovery.status,'created');assert.equal(recovery.job.content,'试玩内容');
  assert.equal(recovery.job.officialAutoReplyRecoveryJobId,original.id);assert.equal(recovery.job.needsReplyVerification,true);
  assert.equal(reopened.recoverUnrepliedMessage({...source,officialAutoReplyPending:evidence}).status,'queued');
  const stored=reopened.snapshot().jobs.find(row=>row.id===original.id);assert.equal(stored.status,'cancelled');assert.equal(stored.recoveryJobId,recovery.job.id);
});

test('robot evidence cannot override a different human reply or a sent or uncertain answer',async t=>{
  for(const status of ['human','sent','uncertain']){
    const f=fixture(t),source=f.message(),job=f.engine.ingestMessage(source);
    if(status==='human')f.engine.ingestMessage({...source,messageId:'human-message',direction:'outgoing',text:'已手动答复',sentAt:source.sentAt+1000});
    else {f.response(status==='sent'?{status:'confirmed',messageId:'server-receipt'}:{status:'uncertain'});await f.engine.dispatch(job.id);}
    const result=f.engine.recoverUnrepliedMessage({...source,officialAutoReplyPending:{automaticMessageId:'robot-message',sourceMessageId:source.messageId,pendingSince:source.sentAt,historyVerified:true}});
    assert.notEqual(result.status,'created');
  }
});

test('verified platform-notice history recovers an unsent preflight cancellation across restarts',async t=>{
  const f=fixture(t),source=f.message();f.response({status:'skipped',reason:'会话已有回复'});
  const original=f.engine.recoverUnrepliedMessage(source);await f.engine.dispatch(original.job.id);
  const loaded=f.create();loaded.setRunning(true);
  const proof={hintMessageId:'wait-notice',sourceMessageId:source.messageId,pendingSince:source.sentAt,historyVerified:true};
  const recovery=loaded.recoverUnrepliedMessage({...source,platformHintPending:proof});
  assert.equal(recovery.status,'created');assert.equal(recovery.job.platformHintRecoveryJobId,original.job.id);
  assert.equal(recovery.job.needsReplyVerification,true);assert.equal(recovery.job.content,'试玩内容');
  assert.equal(loaded.recoverUnrepliedMessage({...source,platformHintPending:proof}).status,'queued');
  assert.ok(loaded.snapshot().logs.some(row=>row.code==='platform_hint_pending_queued'));
});

test('platform-notice evidence never overrides genuine human intervention or a confirmed or uncertain send',async t=>{
  for(const status of ['human','sent','uncertain']){
    const f=fixture(t),source=f.message(),job=f.engine.ingestMessage(source);
    if(status==='human')f.engine.ingestMessage({...source,messageId:'human-answer',direction:'outgoing',text:'人工答复',sentAt:source.sentAt+1000});
    else{f.response(status==='sent'?{status:'confirmed',messageId:'server-receipt'}:{status:'uncertain'});await f.engine.dispatch(job.id);}
    const proof={hintMessageId:'wait-notice',sourceMessageId:source.messageId,pendingSince:source.sentAt,historyVerified:true};
    assert.notEqual(f.engine.recoverUnrepliedMessage({...source,platformHintPending:proof}).status,'created');
  }
  const f=fixture(t),source=f.message();
  for(const patch of [{sourceMessageId:'other'},{historyVerified:false},{hintMessageId:source.messageId},{pendingSince:source.sentAt+1000}]){
    assert.throws(()=>f.engine.recoverUnrepliedMessage({...source,platformHintPending:{hintMessageId:'wait-notice',sourceMessageId:source.messageId,pendingSince:source.sentAt,historyVerified:true,...patch}}),/证据/);
  }
});

test('only the exact robot cancellation can be recovered and malformed pending evidence is rejected',t=>{
  const f=fixture(t),source=f.message(),job=f.engine.ingestMessage(source);
  f.engine.ingestMessage({...source,messageId:'robot-message',direction:'outgoing',text:'官方自动回复',sentAt:source.sentAt+1000});
  const proof={automaticMessageId:'robot-message',sourceMessageId:source.messageId,pendingSince:source.sentAt,historyVerified:true};
  for(const patch of [{sourceMessageId:'other'},{historyVerified:false},{automaticMessageId:source.messageId},{pendingSince:source.sentAt+1000}]){
    assert.throws(()=>f.engine.recoverUnrepliedMessage({...source,officialAutoReplyPending:{...proof,...patch}}),/证据/);
  }
  const recovered=f.engine.recoverUnrepliedMessage({...source,officialAutoReplyPending:proof});assert.equal(recovered.status,'created');assert.equal(recovered.job.officialAutoReplyRecoveryJobId,job.id);
});
test('recovery requires a current official pending incoming message and its switches',t=>{
  const f=fixture(t);for(const extra of [{pending:false},{direction:'outgoing'},{sentAt:Date.now()-8*86400000},{sentAt:Date.now()+120000}])assert.throws(()=>f.engine.recoverUnrepliedMessage(f.message(extra)),/近七天/);
  f.engine.setRunning(false);assert.equal(f.engine.recoverUnrepliedMessage(f.message()).status,'disabled');
});
test('old v2 data accepts new optional settings and marks persisted queued replies for rechecking',t=>{
  const f=fixture(t);f.engine.ingestMessage(f.message());const raw=JSON.parse(fs.readFileSync(f.filePath));delete raw.config.autoListenOnLaunch;delete raw.config.catchUpUnrepliedEnabled;delete raw.ledger.replyRecovery;fs.writeFileSync(f.filePath,JSON.stringify(raw));
  const loaded=f.create().snapshot();assert.equal(loaded.config.autoListenOnLaunch,false);assert.equal(loaded.config.catchUpUnrepliedEnabled,false);assert.equal(loaded.jobs[0].needsReplyVerification,true);
});
test('resuming rechecks existing queued replies and rule edits cancel stale reply bodies',t=>{
  const f=fixture(t);const old=f.engine.ingestMessage(f.message());f.engine.prepareRepliesForResume();assert.equal(f.engine.snapshot().jobs[0].needsReplyVerification,true);
  const config=f.engine.snapshot().config;config.replyRules[0].content='更新后的内容';f.engine.updateConfig(config);assert.equal(f.engine.snapshot().jobs[0].status,'cancelled');assert.equal(f.engine.snapshot().jobs[0].reason,'rules_changed');
  const recovered=f.engine.recoverUnrepliedMessage(f.message());assert.equal(recovered.status,'created');assert.equal(recovered.job.content,'更新后的内容');assert.notEqual(recovered.job.id,old.id);
});
test('a cooldown-skipped record from an older version can still recover when officially pending',async t=>{
  const f=fixture(t);const first=f.engine.ingestMessage(f.message());f.response({status:'confirmed',messageId:'server'});await f.engine.dispatch(first.id);
  const skipped=f.message({messageId:'next-consultation'}),raw=JSON.parse(fs.readFileSync(f.filePath));
  raw.ledger.messages[JSON.stringify([skipped.shopId,skipped.messageId])]={...Object.values(raw.ledger.messages)[0]};
  fs.writeFileSync(f.filePath,JSON.stringify(raw));const loaded=f.create();loaded.setRunning(true);
  const recovery=loaded.recoverUnrepliedMessage(skipped);assert.equal(recovery.status,'created');assert.equal(recovery.job.needsReplyVerification,true);assert.equal(loaded.nextJob(),null);
});
