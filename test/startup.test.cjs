'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { StartupListener } = require('../src/core/startup-listener.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(start) {
  const timers = new Map(); let id = 0;
  const listener = new StartupListener({ start, schedule:fn=>{timers.set(++id,fn);return id;}, cancel:key=>timers.delete(key) });
  const retry=async()=>{const [key,fn]=timers.entries().next().value;timers.delete(key);fn();await tick();};
  return { listener, timers, retry };
}
const config = { autoListenOnLaunch:true, autoReplyEnabled:true };
test('opening automatically starts the saved enabled functions once',async()=>{
  let calls=0;const {listener,timers}=fixture(async()=>{calls++;});
  listener.arm(config);await tick();assert.equal(calls,1);assert.equal(listener.state.phase,'listening');assert.equal(timers.size,0);
});
test('authentication and verification retry automatically after the user finishes them',async()=>{
  let calls=0;const {listener,retry}=fixture(async()=>{if(++calls===1)throw Error('请在官方页面扫码登录');if(calls===2)throw Error('官方订单页需要滑块验证');});
  listener.arm(config);await tick();assert.equal(listener.state.phase,'login');
  await retry();assert.equal(listener.state.phase,'verification');assert.equal(listener.state.kind,'orders');
  await retry();assert.equal(listener.state.phase,'listening');assert.equal(calls,3);
});
test('manual pause cancels a pending retry and an in-flight connection result',async()=>{
  const failed=fixture(async()=>{throw Error('网络异常');});failed.listener.arm(config);await tick();
  failed.listener.stop();assert.equal(failed.timers.size,0);assert.equal(failed.listener.state.pending,false);
  let finish;const pending=fixture(()=>new Promise(resolve=>{finish=resolve;}));pending.listener.arm(config);pending.listener.stop();finish();await tick();assert.equal(pending.listener.state.phase,'paused');
});
test('disabled auto launch or no enabled functions never starts platform work',async()=>{
  let calls=0;const {listener}=fixture(async()=>{calls++;});listener.arm({...config,autoListenOnLaunch:false});listener.arm({autoListenOnLaunch:true});await tick();assert.equal(calls,0);assert.equal(listener.state.phase,'disabled');
});
test('a previously running session recovers even when automatic launch is disabled',async()=>{
  let calls=0;const f=fixture(async()=>{if(++calls===1)throw Error('电脑离线，等待网络恢复');});
  f.listener.recover({...config,autoListenOnLaunch:false});await tick();assert.equal(f.listener.state.phase,'offline');assert.equal(f.timers.size,1);
  f.listener.recover(config);assert.equal(f.timers.size,1);assert.equal(calls,1,'repeated failures must not reset the recovery timer');
  await f.retry();assert.equal(f.listener.state.phase,'listening');assert.equal(calls,2);
});
test('manual pause prevents a pending mid-session recovery from restarting work',async()=>{
  const f=fixture(async()=>{throw Error('网络未连接');});f.listener.recover(config);await tick();assert.equal(f.listener.state.phase,'offline');
  f.listener.stop();assert.equal(f.timers.size,0);assert.equal(f.listener.state.pending,false);
});
