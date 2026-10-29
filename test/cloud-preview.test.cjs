'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PreviewController}=require('../scripts/cloud-watchdog/preview-controller.cjs');
function fixture(){
  let now=1000000;const sends=[];
  const state={enabled:true,configured:true,ownsMobile:true,status:'idle',lastAcceptedAt:null,cloudIncident:null,lastNotification:{id:'previous-notice',status:'accepted'}};
  const client={busy:false,snapshot:()=>({...state}),observe:async sample=>{sends.push(sample);state.status=sample.wanted?'connected':'paused';state.lastAcceptedAt=now;},peek:async()=>{},disable:async()=>{state.enabled=false;}};
  const controller=new PreviewController({client,now:()=>now});
  return {client,state,sends,controller,advance:ms=>{now+=ms;}};
}
test('direct simulate-offline click from paused obtains armed acknowledgement before stopping heartbeats',async()=>{
  const f=fixture();await f.controller.select('offline');assert.deepEqual(f.sends,[{wanted:true,healthy:true,online:true}]);assert.equal(f.controller.mode,'offline');assert.equal(f.controller.snapshot().phase,'waiting');assert.equal(f.controller.snapshot().remainingSeconds,60);assert.equal(f.controller.snapshot().currentNotice,null,'old accepted notification must not appear as current test success');
  f.advance(61000);assert.equal(f.controller.snapshot().remainingSeconds,0);assert.equal(f.controller.snapshot().phase,'waiting','elapsed time alone never fabricates success');
});
test('simulated offline queries status without heartbeats, repeated clicks do not restart countdown',async()=>{
  const f=fixture();await f.controller.select('offline');let reads=0;f.client.peek=async()=>{reads++;f.state.cloudIncident={id:'current-notice',status:'accepted'};};f.advance(20000);await f.controller.select('offline');assert.equal(f.controller.snapshot().remainingSeconds,40);
  await f.controller.pulse();await f.controller.pulse();assert.equal(f.sends.length,1);assert.equal(reads,2);assert.equal(f.controller.snapshot().phase,'notified');
});
test('failed armed acknowledgement preserves paused state and gives an actionable error',async()=>{
  const f=fixture();f.client.observe=async()=>{f.state.status='error';};await assert.rejects(f.controller.select('offline'),/模拟断网没有开始/);assert.equal(f.controller.mode,'paused');assert.equal(f.controller.snapshot().remainingSeconds,null);assert.match(f.controller.snapshot().controllerError,/尚未确认/);
});
test('an unfinished previous incident requires stable normal operation instead of silently resetting deduplication',async()=>{
  const f=fixture();f.state.cloudIncident={id:'previous-notice',status:'accepted'};await assert.rejects(f.controller.select('offline'),/上一轮异常尚未结束/);assert.equal(f.controller.mode,'healthy');await f.controller.pulse();assert.ok(f.sends.every(row=>row.wanted&&row.healthy));
});
test('arming is not raced by timer heartbeats or another button action',async()=>{
  const f=fixture();let release,entered;const gate=new Promise(resolve=>{release=resolve;});f.client.observe=async()=>{entered=true;await gate;f.state.status='connected';f.state.lastAcceptedAt=1000000;};
  const pending=f.controller.select('offline');await new Promise(resolve=>setImmediate(resolve));assert.equal(entered,true);assert.equal(f.controller.mode,'arming');await f.controller.pulse();await assert.rejects(f.controller.select('paused'),/正在切换/);release();await pending;assert.equal(f.controller.mode,'offline');
});
test('disabled test monitor cannot display simulated outage as started',async()=>{
  const f=fixture();f.state.enabled=false;await assert.rejects(f.controller.select('offline'),/启用测试监护/);assert.equal(f.controller.mode,'paused');assert.equal(f.sends.length,0);
});
test('button transitions wait for in-flight status reads before obtaining a fresh armed acknowledgement',async()=>{
  const f=fixture();f.client.inspecting=true;f.controller.wait=async()=>{f.client.inspecting=false;};const observe=f.client.observe;f.client.observe=async sample=>{assert.equal(f.client.inspecting,false);await observe(sample);};await f.controller.select('offline');assert.equal(f.controller.mode,'offline');assert.equal(f.sends.length,1);
});
