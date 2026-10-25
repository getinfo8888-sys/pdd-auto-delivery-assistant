'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {CapabilityRecovery,pageRefreshDecision}=require('../src/core/capability-recovery.cjs');
test('order verification isolates delivery and retains chat/refund availability with bounded retries',()=>{
  let now=1000;const c=new CapabilityRecovery({now:()=>now});
  c.success('refunds');const failed=c.failure('orders',Error('请完成滑块安全验证'));
  assert.equal(failed.retryAt,31000);assert.equal(c.due('orders'),false);
  assert.deepEqual(c.excludedTypes({chatReady:true}),['delivery','shipment']);
  now=31000;assert.equal(c.due('orders'),true);c.success('orders');
  assert.deepEqual(c.excludedTypes({chatReady:true}),[]);
});
test('refund read failure leaves replies and deliveries enabled; socket loss fails closed for all writes',()=>{
  const c=new CapabilityRecovery();c.success('orders');c.failure('refunds',Error('售后接口超时'));
  assert.deepEqual(c.excludedTypes({chatReady:true}),['refund']);
  assert.deepEqual(c.excludedTypes({chatReady:false}),['reply','delivery','shipment','refund']);
});
test('failed reads back off independently and successful pagination remains prompt',()=>{
  let now=1000;const c=new CapabilityRecovery({now:()=>now});
  for(let i=0;i<10;i++){const state=c.failure('orders',Error('接口超时'));assert.ok(state.retryAt-now<=60000);now=state.retryAt;}
  c.success('orders',{hasMore:true});assert.equal(c.state('orders').retryAt,now+3000);assert.equal(c.state('orders').failures,0);
  c.reset();assert.equal(c.state('orders').ready,false);assert.equal(c.due('orders'),true);
});
test('network restore refreshes visible stale pages and broken chat but preserves background order sessions',()=>{
  assert.equal(pageRefreshDecision({kind:'orders',visibleKind:'chat',healthy:false,recoveryRequested:true}),'background_preserved');
  assert.equal(pageRefreshDecision({kind:'orders',visibleKind:'orders',healthy:true}),'refresh');
  assert.equal(pageRefreshDecision({kind:'chat',healthy:false}),'refresh');
  assert.equal(pageRefreshDecision({kind:'chat',healthy:true}),'background_preserved');
});
test('verification, login and unsent drafts survive every automatic network refresh',()=>{
  for(const kind of ['chat','orders']) {
    for(const [status,expected] of [[{verification:true},'verification_preserved'],[{login:true},'login_preserved'],[{hasDraft:true},'draft_preserved']]) {
      assert.equal(pageRefreshDecision({kind,visibleKind:kind,healthy:false,recoveryRequested:true,status}),expected);
    }
  }
});
