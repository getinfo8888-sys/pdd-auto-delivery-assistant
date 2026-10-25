'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Engine,defaults}=require('../src/core/engine.cjs');
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pdd-reply-cooldown-'));
  t.after(()=>{if(path.dirname(dir)!==path.resolve(os.tmpdir())||!path.basename(dir).startsWith('pdd-reply-cooldown-'))throw Error('Unsafe cleanup');fs.rmSync(dir,{recursive:true,force:true});});
  let now=1800000000000;const filePath=path.join(dir,'state.json'),calls=[];
  let responder=async()=>({status:'confirmed',messageId:'receipt-'+calls.length});
  const sendMessage=async job=>{calls.push(job);return responder(job);};
  const create=()=>new Engine({filePath,now:()=>now,sendMessage});const engine=create();
  engine.updateConfig({...defaults,running:true,autoReplyEnabled:true,greetingEnabled:false,catchUpUnrepliedEnabled:true,cooldownSeconds:10,
    fallback:'本店按规则回复',replyRules:[{id:'trial',name:'试玩',keywords:['试玩'],content:'试玩领取说明',enabled:true}]});
  return {engine,create,calls,now:()=>now,advance:ms=>{now+=ms;},respond:fn=>{responder=fn;},message:(id,extra={})=>({shopId:'shop',buyerId:'buyer',messageId:id,text:'试玩',direction:'incoming',sentAt:now,...extra})};
}
test('an inquiry at 7.528 seconds is sent at the ten-second deadline without a pending scan',async t=>{
  const f=fixture(t),first=f.engine.ingestMessage(f.message('first'));await f.engine.dispatch(first.id);
  f.advance(7528);const waiting=f.engine.ingestMessage(f.message('fifth'));
  assert.equal(waiting.status,'queued');assert.equal(waiting.reason,'cooldown');assert.equal(waiting.notBefore-f.now(),2472);
  assert.equal(waiting.needsReplyVerification,true);assert.equal(f.engine.nextJob(),null);
  await f.engine.dispatch(waiting.id);assert.equal(f.calls.length,1);
  f.advance(2471);assert.equal(f.engine.nextJob(),null);f.advance(1);
  assert.equal(f.engine.nextJob().id,waiting.id);const sent=await f.engine.dispatch(waiting.id);
  assert.equal(sent.status,'sent');assert.ok(sent.sentMessageId);assert.equal(f.calls.length,2);assert.equal(sent.content,'试玩领取说明');
});
test('a burst keeps the original cooldown deadline and only the latest unattempted inquiry active',async t=>{
  const f=fixture(t),first=f.engine.ingestMessage(f.message('first'));await f.engine.dispatch(first.id);
  const waiting=[];
  for(let index=0;index<5;index++){f.advance(1000);waiting.push(f.engine.ingestMessage(f.message('burst-'+index)));}
  const jobs=f.engine.snapshot().jobs;assert.equal(jobs.filter(j=>j.status==='queued').length,1);
  assert.equal(jobs.filter(j=>j.status==='cancelled').length,4);
  assert.ok(waiting.every(j=>j.notBefore===first.createdAt+10000));
  f.advance(5000);assert.equal(f.engine.nextJob().messageId,'burst-4');await f.engine.dispatch(f.engine.nextJob().id);
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].messageId,'burst-4');
});
test('an unattempted cooldown reply survives reopening and still waits only until its deadline',async t=>{
  const f=fixture(t),first=f.engine.ingestMessage(f.message('first'));await f.engine.dispatch(first.id);f.advance(7528);
  const waiting=f.engine.ingestMessage(f.message('after-reopen'));const restarted=f.create();restarted.setRunning(true);
  assert.equal(restarted.snapshot().jobs.at(-1).notBefore,waiting.notBefore);assert.equal(restarted.nextJob(),null);
  f.advance(2472);assert.equal(restarted.nextJob().id,waiting.id);assert.equal((await restarted.dispatch(waiting.id)).status,'sent');
});
test('a genuine manual reply cancels a cooldown task before it can be sent',async t=>{
  const f=fixture(t),first=f.engine.ingestMessage(f.message('first'));await f.engine.dispatch(first.id);f.advance(1000);
  const waiting=f.engine.ingestMessage(f.message('pending'));f.advance(1);
  f.engine.ingestMessage(f.message('manual',{direction:'outgoing',text:'人工已处理'}));f.advance(10000);
  assert.equal(f.engine.snapshot().jobs.find(j=>j.id===waiting.id).status,'cancelled');assert.equal(f.engine.nextJob(),null);assert.equal(f.calls.length,1);
});
test('identical welcome and keyword contents produce a single reply for one source',t=>{
  const f=fixture(t);f.engine.updateConfig({...f.engine.snapshot().config,greetingEnabled:true,greeting:'试玩领取说明'});
  f.engine.ingestMessage(f.message('single-source'));assert.equal(f.engine.snapshot().jobs.length,1);
});

test('same-body cooldown starts at the successful receipt rather than creation or attempt time',async t=>{
  const f=fixture(t);
  f.respond(async()=>{f.advance(8000);return {status:'confirmed',messageId:'slow-receipt'};});
  const first=f.engine.ingestMessage(f.message('slow-first'));await f.engine.dispatch(first.id);
  const confirmedAt=f.now();f.advance(500);
  const second=f.engine.ingestMessage(f.message('after-slow-receipt'));
  assert.equal(second.notBefore,confirmedAt+10000);
  assert.equal(second.notBefore-f.now(),9500);
  assert.equal(f.engine.nextJob(),null);
});

test('a duplicate-rejected message starts its cooldown only after a later confirmed retry',async t=>{
  const f=fixture(t);let attempts=0;
  f.respond(async()=>++attempts===1?{status:'rejected',reason:'请勿重复发送相同消息'}:{status:'confirmed',messageId:'retry-receipt'});
  const first=f.engine.ingestMessage(f.message('retried-first'));
  const rejected=await f.engine.dispatch(first.id);
  f.advance(rejected.nextAttemptAt-f.now());await f.engine.dispatch(first.id);
  const confirmedAt=f.now();f.advance(1000);
  const second=f.engine.ingestMessage(f.message('after-retry'));
  assert.equal(second.notBefore,confirmedAt+10000);
});

test('dispatch rechecks a queued repeat when an earlier reply has just succeeded',async t=>{
  const f=fixture(t);const first=f.engine.ingestMessage(f.message('queued-first'));
  f.advance(1000);const second=f.engine.ingestMessage(f.message('queued-second'));
  f.advance(10000);await f.engine.dispatch(first.id);const confirmedAt=f.now();
  const waiting=await f.engine.dispatch(second.id);
  assert.equal(waiting.status,'queued');assert.equal(waiting.reason,'cooldown');
  assert.equal(waiting.notBefore,confirmedAt+10000);assert.equal(f.calls.length,1);
  f.advance(9999);assert.equal(f.engine.nextJob(),null);f.advance(1);
  await f.engine.dispatch(second.id);assert.equal(f.calls.length,2);
});

test('a saved successful reply still cools the original body after restart despite changed suffix settings',async t=>{
  const f=fixture(t);f.engine.updateConfig({...f.engine.snapshot().config,replySuffixEnabled:true,replySuffixMode:'invisible'});
  f.respond(async()=>{f.advance(8000);return {status:'confirmed',messageId:'suffix-receipt'};});
  const first=f.engine.ingestMessage(f.message('suffixed'));await f.engine.dispatch(first.id);const confirmedAt=f.now();
  assert.notEqual(f.engine.snapshot().jobs[0].wireContent,f.engine.snapshot().jobs[0].content);
  f.advance(1000);const reopened=f.create();reopened.updateConfig({...reopened.snapshot().config,replySuffixMode:'time'});reopened.setRunning(true);
  const second=reopened.ingestMessage(f.message('after-restart'));
  assert.equal(second.content,first.content);assert.equal(second.notBefore,confirmedAt+10000);
});

test('a fast welcome is followed by a twenty-second human intervention window',async t=>{
  const f=fixture(t);f.engine.updateConfig({...f.engine.snapshot().config,greetingEnabled:true,greeting:'欢迎咨询',firstReplyDelaySeconds:0,replyDelaySeconds:20});
  const welcome=f.engine.ingestMessage(f.message('welcome',{text:'您好'}));
  assert.equal(welcome.strategy,'greeting');assert.equal(welcome.notBefore,f.now());await f.engine.dispatch(welcome.id);
  f.advance(1000);const reply=f.engine.ingestMessage(f.message('followup'));
  assert.equal(reply.notBefore,f.now()+20000);assert.equal(f.engine.nextJob(),null);
  f.advance(10000);f.engine.ingestMessage(f.message('phone-reply',{direction:'outgoing',text:'正在为您解答'}));
  f.advance(20000);assert.equal(f.engine.nextJob(),null);assert.equal(f.calls.length,1);
  assert.equal(f.engine.snapshot().jobs.find(job=>job.id===reply.id).reason,'manual_intervention');
});

test('the general reply delay also applies when the same-body cooldown has already elapsed',async t=>{
  const f=fixture(t),first=f.engine.ingestMessage(f.message('first'));await f.engine.dispatch(first.id);
  f.advance(60000);f.engine.updateConfig({...f.engine.snapshot().config,replyDelaySeconds:20});
  const second=f.engine.ingestMessage(f.message('later-repeat'));
  f.advance(19999);assert.equal(f.engine.nextJob(),null);assert.equal(f.calls.length,1);
  f.advance(1);assert.equal(f.engine.nextJob().id,second.id);await f.engine.dispatch(second.id);assert.equal(f.calls.length,2);
});
