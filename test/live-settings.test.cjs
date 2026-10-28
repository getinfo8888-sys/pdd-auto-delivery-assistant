'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Engine,defaults,validateConfig}=require('../src/core/engine.cjs');
function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pdd-live-settings-'));
  t.after(()=>{if(path.dirname(directory)!==path.resolve(os.tmpdir())||!path.basename(directory).startsWith('pdd-live-settings-'))throw Error('Unsafe cleanup');fs.rmSync(directory,{recursive:true,force:true});});
  let now=1800000000000,respond=async()=>({status:'confirmed',messageId:'10001'});const calls=[],filePath=path.join(directory,'state.json');
  const create=()=>new Engine({filePath,now:()=>now,sendMessage:async job=>{calls.push(job);return respond(job);},markShipped:async()=>({status:'confirmed'}),agreeRefund:async()=>({status:'confirmed'})});
  const engine=create();engine.updateConfig({...defaults,running:true,autoReplyEnabled:true,autoDeliveryEnabled:true,autoRefundEnabled:true,greetingEnabled:false,cooldownSeconds:0,maxPerMinute:120,fallback:'旧答复',products:[{id:'sample',name:'示例商品',keywords:['示例商品'],content:'https://example.test/old',enabled:true}]});
  const message=id=>({shopId:'shop',buyerId:'buyer-'+id,messageId:id,text:'咨询',direction:'incoming',pending:true,sentAt:now-10000});
  return {engine,create,filePath,calls,message,now:()=>now,advance:ms=>{now+=ms;},respond:fn=>{respond=fn;}};
}
test('recovery is built in while existing automation choices, rules and task history survive loading',t=>{
  const f=fixture(t);const job=f.engine.ingestMessage(f.message('legacy'));const raw=JSON.parse(fs.readFileSync(f.filePath));raw.config.catchUpUnrepliedEnabled=false;raw.config.replyBodySpaceRetryEnabled=false;raw.config.autoRefundEnabled=false;fs.writeFileSync(f.filePath,JSON.stringify(raw));
  const loaded=f.create().snapshot();assert.equal(loaded.config.catchUpUnrepliedEnabled,true);assert.equal(loaded.config.replyBodySpaceRetryEnabled,true);assert.equal(loaded.config.autoRefundEnabled,false);assert.deepEqual(loaded.config.products,raw.config.products);assert.equal(loaded.jobs[0].id,job.id);
  assert.equal(validateConfig({...raw.config,catchUpUnrepliedEnabled:false}).catchUpUnrepliedEnabled,true);
});
test('turning reply automation off keeps listening and other features enabled, and its queued reply remains resumable',async t=>{
  const f=fixture(t),job=f.engine.ingestMessage(f.message('reply'));f.engine.updateConfig({...f.engine.snapshot().config,autoReplyEnabled:false});
  assert.equal((await f.engine.dispatch(job.id)).reason,'reply_disabled');assert.equal(f.calls.length,0);assert.equal(f.engine.snapshot().config.running,true);assert.equal(f.engine.snapshot().config.autoDeliveryEnabled,true);assert.equal(f.engine.snapshot().config.autoRefundEnabled,true);
  f.engine.updateConfig({...f.engine.snapshot().config,autoReplyEnabled:true});assert.equal((await f.engine.dispatch(job.id)).status,'sent');assert.equal(f.calls.length,1);
});
test('all automatic features can be off while the listener remains running',t=>{
  const f=fixture(t);f.engine.ingestMessage(f.message('off'));f.engine.updateConfig({...f.engine.snapshot().config,autoReplyEnabled:false,autoDeliveryEnabled:false,autoRefundEnabled:false});assert.equal(f.engine.nextJob(),null);assert.equal(f.engine.snapshot().config.running,true);
});
test('a changed reply delay uses the existing inquiry time and does not require another start',async t=>{
  const f=fixture(t);f.engine.updateConfig({...f.engine.snapshot().config,replyDelaySeconds:20});const job=f.engine.ingestMessage(f.message('delay'));f.advance(1000);f.engine.updateConfig({...f.engine.snapshot().config,replyDelaySeconds:2});
  assert.equal(f.engine.snapshot().jobs[0].notBefore,job.createdAt+2000);assert.equal(f.engine.nextJob(),null);f.advance(1000);assert.equal(f.engine.nextJob().id,job.id);await f.engine.dispatch(job.id);assert.equal(f.calls.length,1);assert.equal(f.engine.snapshot().config.running,true);
});
test('a waiting reply rematches its saved source and sends only the newly configured content',async t=>{
  const f=fixture(t),job=f.engine.ingestMessage({...f.message('rematch'),text:'请问试玩'});f.engine.updateConfig({...f.engine.snapshot().config,replyRules:[{id:'trial',name:'试玩',keywords:['试玩'],content:'新的试玩说明',enabled:true}]});
  const changed=f.engine.snapshot().jobs[0];assert.equal(changed.id,job.id);assert.equal(changed.content,'新的试玩说明');assert.equal(changed.needsReplyVerification,true);await f.engine.dispatch(job.id);assert.equal(f.calls[0].content,'新的试玩说明');assert.equal(f.engine.snapshot().jobs.length,1);
});
test('changing settings during a definitely unsubmitted preflight refreshes the same queued reply',async t=>{
  const f=fixture(t);let release,entered;const entry=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});f.respond(async()=>{entered();await gate;return {status:'deferred',reason:'尚未提交平台'};});const job=f.engine.ingestMessage(f.message('preflight')),pending=f.engine.dispatch(job.id);await entry;
  f.engine.updateConfig({...f.engine.snapshot().config,fallback:'新答复'});assert.equal(f.engine.snapshot().config.running,true);release();const deferred=await pending;assert.equal(deferred.status,'queued');assert.equal(deferred.content,'新答复');assert.equal(deferred.wireContent,undefined);
  f.advance(3000);f.respond(async()=>({status:'confirmed',messageId:'10002'}));assert.equal((await f.engine.dispatch(job.id)).status,'sent');assert.equal(f.calls[1].content,'新答复');
});
test('an already submitted reply keeps its original receipt and is never rewritten as the new content',async t=>{
  for(const status of ['confirmed','uncertain']){
    const f=fixture(t);let release,entered;const entry=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});f.respond(async()=>{entered();await gate;return {status,messageId:status==='confirmed'?'10003':undefined};});const job=f.engine.ingestMessage(f.message(status)),pending=f.engine.dispatch(job.id);await entry;f.engine.updateConfig({...f.engine.snapshot().config,fallback:'下一条的新内容'});release();const result=await pending;
    assert.equal(result.content,'旧答复');assert.equal(result.wireContent,'旧答复');assert.equal(result.status,status==='confirmed'?'sent':'uncertain');assert.equal(f.engine.snapshot().config.running,true);await f.engine.dispatch(job.id);assert.equal(f.calls.length,1);
  }
});
test('a rejected configuration leaves active listening and the saved rules intact',t=>{
  const f=fixture(t),before=fs.readFileSync(f.filePath,'utf8');assert.throws(()=>f.engine.updateConfig({...f.engine.snapshot().config,replyDelaySeconds:-1}),/必须/);assert.equal(f.engine.snapshot().config.running,true);assert.equal(fs.readFileSync(f.filePath,'utf8'),before);
});
