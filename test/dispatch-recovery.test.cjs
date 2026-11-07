'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Engine,defaults}=require('../src/core/engine.cjs');
const {DispatchRecovery}=require('../src/core/dispatch-recovery.cjs');
const {connectionSample}=require('../src/core/alert-health.cjs');
const {AlertMonitor}=require('../src/core/alert-monitor.cjs');
test('failed checkpoints back off and repeated observations cannot postpone recovery',()=>{
  let now=1000,calls=0;const recovery=new DispatchRecovery({now:()=>now});recovery.fail(Error());const id=recovery.snapshot().id;
  now=3999;assert.equal(recovery.recover(()=>calls++),false);assert.equal(calls,0);
  recovery.fail(Error());now=4000;assert.equal(recovery.recover(()=>{calls++;throw Object.assign(Error(),{code:'EBUSY'});}),false);
  assert.equal(recovery.snapshot().retryAt,10000);assert.equal(recovery.snapshot().id,id);
  now=10000;assert.equal(recovery.recover(()=>calls++),true);assert.equal(calls,2);assert.equal(recovery.snapshot().active,false);
});
test('notification sampling keeps a processing fault armed even with healthy platform connections',()=>{
  let now=100000;const shown=[],sent=[];const recovery=new DispatchRecovery({now:()=>now});recovery.fail(Error());
  const config={...defaults,running:true,autoReplyEnabled:true};
  const sample=()=>connectionSample({now,config,bridgeAvailable:true,processingRecovery:recovery.snapshot(),diagnostics:{chat:{ready:true,checkedAt:now}}});
  const monitor=new AlertMonitor({now:()=>now,previouslyWorked:true,config:{enabled:true},desktop:n=>shown.push(n),send:async m=>{sent.push(m);return {accepted:true};}});
  for(let i=0;i<=4;i++){monitor.observe(sample());now+=15000;}
  assert.equal(sample().reason,'stalled');assert.equal(sample().wanted,true);assert.equal(shown.filter(Boolean).length,1);assert.equal(sent.length,1);
  assert.equal(connectionSample({now,config:{...config,running:false},processingRecovery:recovery.snapshot(),diagnostics:{}}).wanted,false);
});
test('post-send save failure stays uncertain through a durable checkpoint and cannot be resent',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pdd-dispatch-recovery-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const filePath=path.join(directory,'state.json');let calls=0,mock,now=1000;const rename=fs.renameSync;
  const engine=new Engine({filePath,now:()=>now,sendMessage:async()=>{calls++;mock=t.mock.method(fs,'renameSync',(from,to)=>{if(to===filePath)throw Object.assign(Error('fixture locked file'),{code:'EPERM'});return rename(from,to);});return {status:'confirmed',messageId:'12345'};}});
  engine.updateConfig({...defaults,running:true,autoDeliveryEnabled:true,products:[{id:'fixture',name:'示例内容',keywords:['示例商品'],content:'https://example.test/resource',enabled:true}]});
  const job=engine.ingestOrder({shopId:'shop',buyerId:'buyer',orderId:'order',itemId:'item',title:'示例商品',paid:true});let failure;
  await assert.rejects(engine.dispatch(job.id),e=>{failure=e;return e.code==='RESULT_COMMIT_FAILED'&&e.cause.code==='EPERM'&&e.cause.persistenceStage==='replace-state';});
  assert.equal(engine.snapshot().config.running,true);assert.equal(engine.snapshot().jobs[0].status,'uncertain');assert.equal(JSON.parse(fs.readFileSync(filePath)).jobs[0].status,'sending');
  const events=[],recovery=new DispatchRecovery({now:()=>now,record:e=>events.push(e)});recovery.fail(failure);now+=3000;
  assert.equal(recovery.recover(()=>engine.checkpoint()),false);assert.equal(calls,1);
  mock.mock.restore();now+=6000;assert.equal(recovery.recover(()=>engine.checkpoint()),true);
  assert.equal(JSON.parse(fs.readFileSync(filePath)).jobs[0].status,'uncertain');assert.equal((await engine.dispatch(job.id)).status,'uncertain');assert.equal(calls,1);
  assert.equal(events[0].causeCode,'EPERM');assert.doesNotMatch(JSON.stringify(events),/example\.test|fixture locked file/);
  engine.reconcileDelivery(job.id,{status:'confirmed',shopId:'shop',buyerId:'buyer',orderId:'order',messageId:'12345'});assert.equal(engine.snapshot().jobs[0].status,'sent');assert.equal(calls,1);
});
