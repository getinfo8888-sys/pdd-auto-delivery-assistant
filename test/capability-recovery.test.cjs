'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {CapabilityRecovery,pageRefreshDecision,orderPageRecoveryNeeded,orderPageRecoveryDecision}=require('../src/core/capability-recovery.cjs');
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

test('order context failures schedule real page recovery while business errors do not cause reload storms',()=>{
  for(const message of ['请打开官方客服或订单页面并登录','官方页面尚未加载，请先登录','官方订单请求组件尚未加载','官方订单读取超时，请检查官方页面后重试','net::ERR_INTERNET_DISCONNECTED','Network Error'])assert.equal(orderPageRecoveryNeeded(Error(message)),true,message);
  assert.equal(orderPageRecoveryNeeded({code:'read_timeout',message:'请求超时'}),true);
  for(const message of ['官方订单列表结构已变化','订单暂时缺少可核验的买家编号','拼多多未接受发货操作','当前店铺与任务店铺不一致','官方订单页需要完成滑块验证'])assert.equal(orderPageRecoveryNeeded(Error(message)),false,message);
});

test('refreshing a merchant editor is not order recovery; a failed order context must return to its entry',()=>{
  for(const url of ['https://mms.pinduoduo.com/home','https://mms.pinduoduo.com/goods/goods_edit?id=fixture','about:blank','chrome-error://chromewebdata/'])assert.equal(orderPageRecoveryDecision({url,status:{loaded:true},reason:'请打开官方客服或订单页面并登录'}),'restore_entry');
  const url='https://mms.pinduoduo.com/orders/list';
  assert.equal(orderPageRecoveryDecision({url,reason:'官方订单请求组件尚未加载'}),'refresh');
  assert.equal(orderPageRecoveryDecision({url,status:{loaded:true,crashed:true},reason:'商家页面进程退出，正在自动恢复'}),'refresh');
  assert.equal(orderPageRecoveryDecision({url,reason:'官方订单页需要完成滑块验证'}),'read_again');
  assert.equal(orderPageRecoveryDecision({url,reason:'官方订单列表结构已变化'}),'read_again');
});

test('order recovery preserves actual login, CAPTCHA, drafts and unfinished loads before any navigation',()=>{
  const url='https://mms.pinduoduo.com/goods/goods_edit';
  for(const [status,outcome]of [[{login:true},'login_preserved'],[{verification:true},'verification_preserved'],[{hasDraft:true},'draft_preserved'],[{loaded:false},'loading']])assert.equal(orderPageRecoveryDecision({url,status}),outcome);
  assert.equal(orderPageRecoveryDecision({url:'https://mms.pinduoduo.com/login/'}),'login_preserved');
  assert.equal(orderPageRecoveryDecision({url,loading:true}),'loading');
});
