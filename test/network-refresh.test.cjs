'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { NetworkRefresh } = require('../src/core/network-refresh.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(refresh = async () => ({ pages: [{ kind: 'chat', outcome: 'refreshed' }] })) {
  let at = 1000, id = 0; const timers = new Map(), calls = [], states = [];
  const monitor = new NetworkRefresh({ refresh: async context => { calls.push(context); return refresh(context); }, update: state => states.push(state), now: () => at, schedule: (fn, delay) => { timers.set(++id, { fn, delay }); return id; }, cancel: key => timers.delete(key) });
  const fire = async () => { const [key, timer] = timers.entries().next().value; timers.delete(key); at += timer.delay; timer.fn(); await tick(); };
  return { monitor, timers, calls, states, fire };
}
test('initial online status and repeated healthy observations never reload pages', async () => {
  const f = fixture(); f.monitor.observe(true); f.monitor.observe(true); await tick();
  assert.equal(f.timers.size, 0); assert.equal(f.calls.length, 0); assert.equal(f.monitor.state.phase, 'online');
});
test('offline to online schedules one refresh even if business connections already recovered', async () => {
  const f = fixture(); f.monitor.observe(true); f.monitor.observe(false); f.monitor.observe(false);
  assert.equal(f.monitor.state.phase, 'offline'); assert.equal(f.timers.size, 0);
  f.monitor.observe(true); f.monitor.observe(true); assert.equal(f.timers.size, 1); assert.equal(f.calls.length, 0);
  await f.fire(); assert.equal(f.calls.length, 1); assert.equal(f.monitor.state.phase, 'complete');
  f.monitor.observe(true); await tick(); assert.equal(f.timers.size, 0); assert.equal(f.calls.length, 1);
});
test('network flapping cancels the old debounce and waits for a stable restoration', async () => {
  const f = fixture(); f.monitor.observe(false); f.monitor.observe(true); f.monitor.observe(false);
  assert.equal(f.timers.size, 0); f.monitor.observe(true); await f.fire();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].cycle, 2);
});
test('a second genuine outage receives a new refresh cycle', async () => {
  const f = fixture(); f.monitor.observe(false); f.monitor.observe(true); await f.fire();
  f.monitor.observe(false); f.monitor.observe(true); await f.fire();
  assert.deepEqual(f.calls.map(c => c.cycle), [1, 2]);
});
test('a failed page refresh is reported without an endless refresh loop', async () => {
  const f = fixture(async () => { throw Error('network unavailable'); });
  f.monitor.observe(false); f.monitor.observe(true); await f.fire();
  assert.equal(f.monitor.state.phase, 'failed'); assert.equal(f.timers.size, 0);
  f.monitor.observe(true); await tick(); assert.equal(f.calls.length, 1);
});
test('in-flight operations may defer a refresh, with bounded retries', async () => {
  const f = fixture(async () => ({ deferred: true }));
  f.monitor.observe(false); f.monitor.observe(true);
  await f.fire(); assert.equal(f.monitor.state.phase, 'waiting');
  await f.fire(); await f.fire(); assert.equal(f.calls.length, 3); assert.equal(f.timers.size, 0); assert.equal(f.monitor.state.phase, 'failed');
});
test('an old refresh completion cannot overwrite a newer offline state', async () => {
  let finish; const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  f.monitor.observe(false); f.monitor.observe(true); await f.fire(); assert.equal(f.monitor.state.phase, 'refreshing');
  const old = f.calls[0]; f.monitor.observe(false); assert.equal(old.isCurrent(), false);
  finish({ pages: [] }); await tick(); assert.equal(f.monitor.state.phase, 'offline');
});
test('exiting cancels scheduled and in-flight refresh callbacks', async () => {
  const pending = fixture(); pending.monitor.observe(false); pending.monitor.observe(true); pending.monitor.dispose();
  assert.equal(pending.timers.size, 0); pending.monitor.observe(false); assert.equal(pending.calls.length, 0);
  let finish; const running = fixture(() => new Promise(resolve => { finish = resolve; }));
  running.monitor.observe(false); running.monitor.observe(true); await running.fire();
  running.monitor.dispose(); const published = running.states.length; finish({}); await tick(); assert.equal(running.states.length, published);
});
