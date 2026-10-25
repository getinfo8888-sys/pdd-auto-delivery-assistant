'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Engine,defaults,validateConfig}=require('../src/core/engine.cjs');
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pdd-delivery-default-'));
  t.after(()=>{if(path.dirname(dir)!==path.resolve(os.tmpdir())||!path.basename(dir).startsWith('pdd-delivery-default-'))throw Error('Unsafe cleanup');fs.rmSync(dir,{recursive:true,force:true});});
  const filePath=path.join(dir,'state.json'),calls=[];const response={status:'confirmed',messageId:'delivery-receipt'};
  const engine=new Engine({filePath,sendMessage:async job=>{calls.push({action:'send',job});return response;},markShipped:async job=>{calls.push({action:'ship',job});return {status:'confirmed'};}});
  engine.updateConfig({...defaults,running:true,autoDeliveryEnabled:true,autoConfirmShipmentEnabled:true,deliveryFallbackEnabled:true,deliveryFallback:'通用领取链接',suffix:'统一领取说明',
    products:[{id:'game',name:'游戏内容',keywords:['示例商品'],matchTarget:'either',content:'指定游戏链接',enabled:true}]});
  const order=(id,extra={})=>({shopId:'shop',buyerId:'buyer',orderId:id,itemId:'one',title:'未命中的商品',sku:'普通规格',paid:true,...extra});
  return {engine,calls,order,response,filePath};
}
test('either a title or a SKU keyword selects the configured content before the default',t=>{
  const f=fixture(t);for(const [id,fields] of [['title',{title:'示例商品 BT版'}],['sku',{sku:'示例商品 豪华版'}]]){
    const job=f.engine.ingestOrder(f.order(id,fields));assert.equal(job.content,'指定游戏链接\n\n统一领取说明');assert.equal(job.productId,'game');assert.equal(job.deliveryFallback,undefined);
  }
});
test('an unmatched paid order uses the default once and shipment waits for the send receipt',async t=>{
  const f=fixture(t),job=f.engine.ingestOrder(f.order('default'));assert.equal(job.status,'queued');assert.equal(job.deliveryFallback,true);assert.equal(job.content,'通用领取链接\n\n统一领取说明');
  assert.equal(f.engine.snapshot().jobs.some(j=>j.type==='shipment'),false);await f.engine.dispatch(job.id);
  const shipment=f.engine.snapshot().jobs.find(j=>j.type==='shipment');assert.ok(shipment);await f.engine.dispatch(shipment.id);
  assert.deepEqual(f.calls.map(c=>c.action),['send','ship']);assert.equal(f.engine.ingestOrder(f.order('default')),null);assert.equal(f.calls.length,2);
});
test('unpaid, refunded and conflicting matches cannot use default content',t=>{
  const f=fixture(t);assert.equal(f.engine.ingestOrder(f.order('unpaid',{paid:false})).reason,'unpaid');assert.equal(f.engine.ingestOrder(f.order('refunded',{refunded:true})).reason,'refunded');
  const config=f.engine.snapshot().config;config.products.push({...config.products[0],id:'other',name:'另一内容'});f.engine.updateConfig(config);
  const ambiguous=f.engine.ingestOrder(f.order('ambiguous',{title:'示例商品'}));assert.equal(ambiguous.reason,'ambiguous_match');assert.equal(ambiguous.content,'');
});
test('default content stays disabled when unconfigured and cannot be enabled empty',t=>{
  const f=fixture(t);f.engine.updateConfig({...f.engine.snapshot().config,deliveryFallbackEnabled:false});assert.equal(f.engine.ingestOrder(f.order('disabled')).reason,'no_match');
  assert.throws(()=>validateConfig({...defaults,deliveryFallbackEnabled:true}),/默认发货内容/);
});
test('editing default content cancels an unsent payload and replans the pending order',t=>{
  const f=fixture(t),old=f.engine.ingestOrder(f.order('edited'));f.engine.updateConfig({...f.engine.snapshot().config,deliveryFallback:'更新后的默认领取链接'});
  assert.equal(f.engine.snapshot().jobs.find(j=>j.id===old.id).status,'cancelled');const replacement=f.engine.ingestOrder(f.order('edited'));
  assert.equal(replacement.content,'更新后的默认领取链接\n\n统一领取说明');assert.equal(replacement.deliveryFallback,true);
});
test('a previously unmatched order becomes deliverable after the default is configured',t=>{
  const f=fixture(t);f.engine.updateConfig({...f.engine.snapshot().config,deliveryFallbackEnabled:false});const blocked=f.engine.ingestOrder(f.order('waiting'));
  f.engine.updateConfig({...f.engine.snapshot().config,deliveryFallbackEnabled:true});const replacement=f.engine.ingestOrder(f.order('waiting'));
  assert.equal(blocked.reason,'no_match');assert.equal(replacement.status,'queued');assert.equal(replacement.deliveryFallback,true);
});
test('a rejected default send cannot manufacture shipment confirmation',async t=>{
  const f=fixture(t);f.response.status='rejected';f.response.reason='发送失败';const job=f.engine.ingestOrder(f.order('failed'));await f.engine.dispatch(job.id);
  assert.equal(f.engine.snapshot().jobs.some(j=>j.type==='shipment'),false);assert.deepEqual(f.calls.map(c=>c.action),['send']);
});
