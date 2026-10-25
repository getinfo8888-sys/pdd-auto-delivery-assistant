'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Engine,defaults}=require('../src/core/engine.cjs');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pdd-delivery-retry-'));
 t.after(()=>{if(path.dirname(dir)!==path.resolve(os.tmpdir())||!path.basename(dir).startsWith('pdd-delivery-retry-'))throw Error('Unsafe cleanup');fs.rmSync(dir,{recursive:true,force:true});});
 let now=1792152000000,response={status:'rejected',reason:'平台暂不可用'};const calls=[],filePath=path.join(dir,'state.json');
 const create=()=>new Engine({filePath,now:()=>now,sendMessage:async job=>{calls.push({type:'delivery',job});return response;},markShipped:async job=>{calls.push({type:'shipment',job});return response;}});
 const engine=create();engine.updateConfig({...defaults,running:true,autoDeliveryEnabled:true,autoConfirmShipmentEnabled:true,suffix:'',products:[{id:'game',name:'游戏',keywords:['游戏'],content:'领取链接 https://pan.example/game',enabled:true}]});
 const event={shopId:'shop',buyerId:'buyer',orderId:'order',itemId:'goods',title:'游戏',paid:true};
 return {engine,event,create,calls,advance:value=>{now=value;},respond:value=>{response=value;},now:()=>now};
}
test('explicit delivery failures persist and retry with bounded backoff without consuming another order',async t=>{
 const f=fixture(t),job=f.engine.ingestOrder(f.event);
 for(const delay of [5000,15000,30000,60000,120000,300000,300000]){
  const before=f.now(),result=await f.engine.dispatch(job.id);assert.equal(result.status,'queued');assert.equal(result.reason,'delivery_retry_wait');assert.equal(result.nextAttemptAt-before,delay);
  assert.equal(f.engine.nextJob(),null);assert.equal(f.engine.ingestOrder(f.event),null);f.advance(result.nextAttemptAt);
 }
 const reopened=f.create();reopened.setRunning(true);assert.equal(reopened.prepareDeliveriesForResume(),1);
 f.respond({status:'confirmed',messageId:'901'});assert.equal((await reopened.dispatch(job.id)).status,'sent');assert.equal(reopened.snapshot().jobs.filter(row=>row.type==='shipment').length,1);
});
test('shipment rejection retries the shipment only and a restart makes its retry immediately eligible',async t=>{
 const f=fixture(t);f.respond({status:'confirmed',messageId:'902'});await f.engine.dispatch(f.engine.ingestOrder(f.event).id);
 const shipment=f.engine.snapshot().jobs.find(row=>row.type==='shipment');f.respond({status:'rejected',reason:'发货接口繁忙'});
 assert.equal((await f.engine.dispatch(shipment.id)).status,'queued');const reopened=f.create();reopened.setRunning(true);reopened.prepareDeliveriesForResume();
 f.respond({status:'confirmed'});await reopened.dispatch(shipment.id);assert.equal(reopened.snapshot().stats.shipmentSent,1);assert.equal(f.calls.filter(row=>row.type==='delivery').length,1);
});
test('an obsolete order is cancelled instead of entering an endless delivery retry',async t=>{
 const f=fixture(t),job=f.engine.ingestOrder(f.event);f.respond({status:'skipped',reason:'订单已退款'});
 const result=await f.engine.dispatch(job.id);assert.equal(result.status,'cancelled');assert.equal(result.reason,'order_changed');assert.equal(f.engine.nextJob(),null);
});
test('an uncertain delivery is not blindly resent, and an official matching receipt continues shipment',async t=>{
 const f=fixture(t),job=f.engine.ingestOrder(f.event);f.respond({status:'uncertain',reason:'回执丢失'});await f.engine.dispatch(job.id);
 const reopened=f.create();reopened.setRunning(true);assert.equal(reopened.prepareDeliveriesForResume(),0);assert.equal(reopened.nextJob(),null);assert.equal(f.calls.length,1);
 assert.throws(()=>reopened.reconcileDelivery(job.id,{status:'confirmed',shopId:'other',orderId:'order',buyerId:'buyer',messageId:'903'}),/不能确认/);
 const confirmed=reopened.reconcileDelivery(job.id,{status:'confirmed',shopId:'shop',orderId:'order',buyerId:'buyer',messageId:'903'});
 assert.equal(confirmed.status,'sent');assert.equal(confirmed.sentMessageId,'903');assert.equal(reopened.snapshot().jobs.filter(row=>row.type==='shipment').length,1);assert.equal(f.calls.length,1);
});
test('authoritative non-delivery requeues the same persisted wire content',async t=>{
 const f=fixture(t),job=f.engine.ingestOrder(f.event);f.respond({status:'uncertain'});const uncertain=await f.engine.dispatch(job.id);
 const queued=f.engine.reconcileDelivery(job.id,{status:'not_sent',shopId:'shop',orderId:'order',buyerId:'buyer'});assert.equal(queued.status,'queued');assert.equal(queued.deliveryWireContent,uncertain.deliveryWireContent);
 f.advance(queued.nextAttemptAt);f.respond({status:'confirmed',messageId:'904'});assert.equal((await f.engine.dispatch(job.id)).status,'sent');assert.equal(f.calls.length,2);
});
test('duplicate rejection adds a persisted time tag without changing the configured delivery or URL',async t=>{
 const f=fixture(t),job=f.engine.ingestOrder(f.event);f.respond({status:'rejected',reason:'请勿重复发送相同消息'});const rejected=await f.engine.dispatch(job.id);
 f.advance(rejected.nextAttemptAt);f.respond({status:'uncertain'});const uncertain=await f.engine.dispatch(job.id);
 assert.equal(uncertain.content,job.content);assert.ok(uncertain.deliveryWireContent.startsWith(job.content+'\n'));assert.ok(uncertain.deliveryWireContent.includes('https://pan.example/game'));
 const reopened=f.create();assert.equal(reopened.snapshot().jobs[0].deliveryWireContent,uncertain.deliveryWireContent);assert.equal(f.calls[1].job.deliveryWireContent,uncertain.deliveryWireContent);
});
test('a refund received while a delivery retry waits prevents any further send',async t=>{
 const f=fixture(t),job=f.engine.ingestOrder(f.event),retry=await f.engine.dispatch(job.id);f.engine.ingestRefund({shopId:'shop',orderId:'order',refundId:'refund',status:'pending'});
 f.advance(retry.nextAttemptAt);assert.equal((await f.engine.dispatch(job.id)).status,'blocked');assert.equal(f.calls.length,1);
});
test('an uncertain shipment can retry after an eligible unshipped order is verified without resending content',async t=>{
 const f=fixture(t);f.respond({status:'confirmed',messageId:'905'});await f.engine.dispatch(f.engine.ingestOrder(f.event).id);
 const shipment=f.engine.snapshot().jobs.find(row=>row.type==='shipment');f.respond({status:'uncertain'});await f.engine.dispatch(shipment.id);
 const retry=f.engine.reconcileOperation(shipment.id,{status:'not_sent',eligible:true,shopId:'shop',orderId:'order'});assert.equal(retry.status,'queued');f.advance(retry.nextAttemptAt);
 f.respond({status:'confirmed'});await f.engine.dispatch(shipment.id);assert.equal(f.calls.filter(row=>row.type==='delivery').length,1);assert.equal(f.engine.snapshot().stats.shipmentSent,1);
});
