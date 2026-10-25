'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Engine, defaults, matchProduct, validateConfig } = require('../src/core/engine.cjs');
const { parseExpression, expressionMatches, wildcardMatches, selectReply } = require('../src/core/reply-strategies.cjs');
const product = (id, word, extra = {}) => ({ id, name: id, keywords: [word], content: `link-${id}`, enabled: true, ...extra });
const order = (extra = {}) => ({ shopId:'shop', buyerId:'buyer', orderId:'order', itemId:'goods', title:'游戏资源', sku:'示例商品', paid:true, ...extra });
const refund = (extra = {}) => ({ shopId:'shop', orderId:'order', refundId:'refund-1', status:'pending', refundVersion:'1', ...extra });
const message = (id, text, extra = {}) => ({ shopId:'shop', buyerId:'buyer', messageId:id, direction:'incoming', text, ...extra });
function fixture(t, adapters = {}) {
  const root = path.resolve(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(root,'workflows-'));
  t.after(() => { if (path.dirname(path.resolve(dir)) !== root || !path.basename(dir).startsWith('workflows-')) throw Error('unsafe cleanup'); fs.rmSync(dir,{recursive:true,force:true}); });
  let time = 1800000000000;
  const calls = [];
  const confirmed = async job => { calls.push(job); return {status:'confirmed', messageId:'server-'+job.id}; };
  const options = { filePath:path.join(dir,'state.json'), now:()=>time, sendMessage:confirmed, markShipped:confirmed, agreeRefund:confirmed, random:()=>0, ...adapters };
  const engine = new Engine(options);
  engine.updateConfig({...defaults, running:true, autoReplyEnabled:true, autoDeliveryEnabled:true, autoRefundEnabled:true, products:[product('示例商品','示例商品')]});
  return {engine, calls, options, advance:ms=>{time+=ms;}};
}
test('delivery matches title or SKU separately and honors the chosen field', () => {
  assert.equal(matchProduct({title:'网盘资源',sku:'示例商品'},[product('a','示例商品')]).product.id,'a');
  assert.equal(matchProduct({title:'示例',sku:'商品'},[product('a','示例商品')]).status,'unmatched');
  assert.equal(matchProduct({title:'网盘资源',spec:'示例商品'},[product('a','示例商品',{matchTarget:'title'})]).status,'unmatched');
  assert.equal(matchProduct({title:'示例商品',sku:'另一游戏'},[product('a','示例商品'),product('b','另一游戏',{matchTarget:'sku'})]).status,'ambiguous');
});
test('exact, wildcard, contains and boolean expressions use their documented semantics', () => {
  assert.equal(wildcardMatches('试?*','试玩资源'),true);
  assert.equal(wildcardMatches('Ab*','ab资源'),false);
  assert.equal(wildcardMatches('a'.repeat(100)+'*','a'.repeat(100000)),true);
  const tree = parseExpression('(试玩,体验)+链接-不要');
  assert.equal(expressionMatches(tree,'想体验，有链接吗'),true);
  assert.equal(expressionMatches(tree,'试玩链接不要'),false);
  assert.throws(()=>parseExpression('(试玩+'),/缺少|配对/);
  assert.throws(()=>validateConfig({replyRules:[{id:'x',name:'x',keywords:['试玩+'],content:'x',matchType:'expression'}]}),/缺少/);
  const rules = validateConfig({replyRules:[
    {id:'contains',name:'c',keywords:['ABC'],content:'c'},
    {id:'wild',name:'w',keywords:['ABC*'],content:'w',matchType:'wildcard'},
    {id:'exact',name:'e',keywords:['ABC'],content:'e',matchType:'exact',priority:1},
    {id:'system',name:'s',keywords:['paid'],content:'s',matchType:'system'},
  ]}).replyRules;
  assert.equal(selectReply({text:'ABC'},rules,{now:0,random:()=>0}).id,'exact');
  assert.equal(selectReply({text:'abc'},rules,{now:0,random:()=>0}).id,'contains');
  assert.equal(selectReply({text:'ABC',systemCode:'paid'},rules,{now:0,random:()=>0}).id,'system');
  assert.equal(selectReply({text:'ABC'},rules.filter(row=>row.id==='exact').map(row=>({...row,weekSlots:[0]})),{now:0}),null);
});
test('welcome reappears after an inactivity interval; another answer is not suppressed by its cooldown', t => {
  const {engine, advance} = fixture(t);
  engine.updateConfig({...engine.snapshot().config,replyRules:[{id:'trial',name:'试玩',keywords:['试玩'],content:'试玩链接'}]});
  engine.ingestMessage(message('m1','你好'));
  assert.equal(engine.ingestMessage(message('m2','试玩')).content,'试玩链接');
  const waiting=engine.ingestMessage(message('m3','试玩'));assert.equal(waiting.status,'queued');assert.equal(waiting.reason,'cooldown');
  advance(29*60000); engine.ingestMessage(message('m4','你好'));
  advance(29*60000); assert.notEqual(engine.ingestMessage(message('m5','你好')).strategy,'greeting');
  advance(30*60000); assert.equal(engine.ingestMessage(message('m6','你好')).strategy,'greeting');
});
test('same-priority alternatives avoid the previous rule', t => {
  const {engine} = fixture(t);
  engine.updateConfig({...engine.snapshot().config,greetingEnabled:false,cooldownSeconds:0,replyRules:[
    {id:'one',name:'1',keywords:['试玩'],content:'1'}, {id:'two',name:'2',keywords:['试玩'],content:'2'}]});
  assert.equal(engine.ingestMessage(message('1','试玩')).replyRuleId,'one');
  assert.equal(engine.ingestMessage(message('2','试玩')).replyRuleId,'two');
});
test('welcome and keyword delays run independently; manual replies cancel only pending robot replies', async t => {
  const {engine,advance,calls} = fixture(t);
  engine.updateConfig({...engine.snapshot().config,firstReplyDelaySeconds:1,replyDelaySeconds:5,replyRules:[{id:'trial',name:'试玩',keywords:['试玩'],content:'链接'}]});
  const welcome = engine.ingestMessage(message('1','试玩',{sentAt:1800000000000}));
  assert.equal(engine.nextJob(),null);
  assert.equal((await engine.dispatch(welcome.id)).reason,'reply_delay');
  advance(1000); await engine.dispatch(engine.nextJob().id);
  engine.ingestMessage(message('manual','我来处理',{direction:'outgoing',sentAt:1800000001000}));
  advance(10000); assert.equal(engine.nextJob(),null);
  assert.equal(calls.length,1);
  assert.equal(engine.snapshot().jobs.find(job=>job.replyRuleId==='trial').reason,'manual_intervention');
});
test('shipping is a separate durable task created only after confirmed content delivery', async t => {
  const {engine,options,calls} = fixture(t);
  const delivery = engine.ingestOrder(order());
  assert.equal(engine.snapshot().jobs.some(job=>job.type==='shipment'),false);
  await engine.dispatch(delivery.id);
  const ship = engine.snapshot().jobs.find(job=>job.type==='shipment');
  assert.equal(ship.status,'queued');
  const restarted = new Engine(options); assert.equal(restarted.snapshot().config.running,false);
  restarted.setRunning(true); await restarted.dispatch(ship.id); await restarted.dispatch(ship.id);
  assert.deepEqual(calls.map(job=>job.type),['delivery','shipment']);
  assert.equal(restarted.snapshot().stats.shipmentSent,1);
});
test('unknown message outcomes do not confirm shipment', async t => {
  const {engine} = fixture(t,{sendMessage:async()=>({status:'uncertain'})});
  await engine.dispatch(engine.ingestOrder(order()).id);
  assert.equal(engine.snapshot().jobs.some(job=>job.type==='shipment'),false);
});
test('multi-item orders wait until every item has a confirmed delivery', async t => {
  const {engine} = fixture(t);
  await engine.dispatch(engine.ingestOrder(order({itemCount:2})).id);
  assert.equal(engine.snapshot().jobs.some(job=>job.type==='shipment'),false);
  await engine.dispatch(engine.ingestOrder(order({itemCount:2,itemId:'second'})).id);
  assert.equal(engine.snapshot().jobs.filter(job=>job.type==='shipment').length,1);
});
test('pending refunds immediately stop queued delivery and shipment; refund has dispatch priority', async t => {
  const {engine,calls} = fixture(t);
  const delivery = engine.ingestOrder(order());
  engine.ingestOrder(order({orderId:'another-order'}));
  const task = engine.ingestRefund(refund());
  assert.equal(engine.nextJob().id,task.id);
  assert.equal((await engine.dispatch(delivery.id)).reason,'refund_pending');
  await engine.dispatch(task.id);
  assert.equal(calls[0].type,'refund');
  assert.equal(engine.snapshot().stats.refundSent,1);
  assert.equal(engine.ingestRefund(refund()),null);
});
test('refund arriving during a send prevents a subsequent shipping confirmation', async t => {
  let release;
  const {engine} = fixture(t,{sendMessage:()=>new Promise(resolve=>{release=resolve;})});
  const pending=engine.dispatch(engine.ingestOrder(order()).id);
  await new Promise(resolve=>setImmediate(resolve));
  engine.ingestRefund(refund());
  release({status:'confirmed',messageId:'real-id'}); await pending;
  assert.equal(engine.snapshot().jobs.some(job=>job.type==='shipment'),false);
});
test('refunds do not depend on a buyer ID, matching rule, amount limit, or chat rate limit', async t => {
  const {engine,calls,options} = fixture(t);
  engine.updateConfig({...engine.snapshot().config,maxPerMinute:1,products:[]});
  await engine.dispatch(engine.ingestMessage(message('hello','你好')).id);
  const task=engine.ingestRefund(refund({amount:100000})); await engine.dispatch(task.id);
  assert.equal(task.buyerId,'');
  assert.equal(calls.at(-1).type,'refund');
  const restarted=new Engine(options); restarted.setRunning(true);
  assert.equal(restarted.ingestRefund(refund()),null);
  assert.equal(restarted.snapshot().stats.refundSent,1);
});
test('disabled refunds can be picked up after enabling, while previews never stop real orders', t => {
  const {engine} = fixture(t);
  const delivery=engine.ingestOrder(order());
  engine.ingestRefund(refund(),{simulation:true});
  assert.equal(engine.snapshot().jobs.find(job=>job.id===delivery.id).status,'queued');
  engine.updateConfig({...engine.snapshot().config,autoRefundEnabled:false});
  const disabled=engine.ingestRefund(refund()); assert.equal(disabled.reason,'refund_disabled');
  engine.updateConfig({...engine.snapshot().config,autoRefundEnabled:true});
  assert.equal(engine.ingestRefund(refund()).status,'queued');
});
test('a rejected operation and an unknown outcome are distinct; unknown refunds never blindly repeat', async t => {
  let count=0;
  const {engine} = fixture(t,{agreeRefund:async()=>++count===1?{status:'rejected',reason:'platform declined'}:{status:'uncertain'}});
  const first=engine.ingestRefund(refund()); assert.equal((await engine.dispatch(first.id)).status,'blocked');
  const second=engine.ingestRefund(refund({refundId:'refund-2',orderId:'order-2'}));
  assert.equal((await engine.dispatch(second.id)).status,'uncertain');
  await engine.dispatch(second.id); assert.equal(count,2);
  assert.equal(engine.snapshot().stats.refundSent,0);
});
test('version 1 rules migrate without silently enabling shipping or refunds', t => {
  const {engine,options} = fixture(t);
  const state=JSON.parse(fs.readFileSync(options.filePath,'utf8'));
  const oldKeys=['running','autoReplyEnabled','autoDeliveryEnabled','greetingEnabled','greeting','fallback','suffix','cooldownSeconds','maxPerMinute','products','replyRules'];
  state.version=1; state.config=Object.fromEntries(oldKeys.map(key=>[key,state.config[key]]));
  for (const key of ['lastAsk','replyHistory','shipments','refunds']) delete state.ledger[key];
  delete state.counts.shipmentSent; delete state.counts.refundSent;
  fs.writeFileSync(options.filePath,JSON.stringify(state));
  const old=fs.readFileSync(options.filePath,'utf8');
  const migrated=new Engine(options);
  assert.deepEqual(migrated.snapshot().config.products,engine.snapshot().config.products);
  assert.equal(migrated.snapshot().config.autoRefundEnabled,false);
  assert.equal(migrated.snapshot().config.autoConfirmShipmentEnabled,false);
  assert.equal(fs.readFileSync(options.filePath+'.bak','utf8'),old);
});
test('editing a delivery rule cancels an unsent old body; a fresh order observation rematches once', async t=>{
  const {engine,calls}=fixture(t);
  const first=engine.ingestOrder(order());
  engine.updateConfig({...engine.snapshot().config,products:[product('示例商品','示例商品',{content:'新内容'})]});
  assert.equal(engine.snapshot().jobs.find(row=>row.id===first.id).status,'cancelled');
  const next=engine.ingestOrder(order());assert.match(next.content,/新内容/);
  await engine.dispatch(next.id);assert.equal(engine.ingestOrder(order()),null);assert.equal(calls.length,1);
});
test('a previously unmatched order can recover after adding the matching local rule',t=>{
  const {engine}=fixture(t);
  const bad=engine.ingestOrder(order({sku:'未知游戏'}));assert.equal(bad.reason,'no_match');
  engine.updateConfig({...engine.snapshot().config,products:[product('新商品','未知游戏')]});
  assert.equal(engine.ingestOrder(order({sku:'未知游戏'})).status,'queued');
});
test('a later cancellation stops the separate shipping task as well as the delivery task',async t=>{
  const {engine,calls}=fixture(t);
  await engine.dispatch(engine.ingestOrder(order()).id);
  const ship=engine.nextJob();assert.equal(ship.type,'shipment');
  engine.ingestOrder(order({cancelled:true}));
  assert.equal((await engine.dispatch(ship.id)).status,'blocked');assert.equal(calls.length,1);
});
test('unknown financial outcomes can be closed by exact platform status without another write',async t=>{
  let writes=0;
  const {engine}=fixture(t,{agreeRefund:async()=>{writes++;return {status:'uncertain'};}});
  const job=engine.ingestRefund(refund());await engine.dispatch(job.id);
  assert.throws(()=>engine.reconcileOperation(job.id,{status:'confirmed',shopId:'another',orderId:'order',refundId:'refund-1'}),/不能确认/);
  engine.reconcileOperation(job.id,{status:'confirmed',shopId:'shop',orderId:'order',refundId:'refund-1'});
  await engine.dispatch(job.id);assert.equal(writes,1);assert.equal(engine.snapshot().stats.refundSent,1);
});
test('an active platform-handled refund stops delivery without manufacturing an approval task',t=>{
  const {engine}=fixture(t);const delivery=engine.ingestOrder(order());
  assert.equal(engine.ingestRefund(refund({status:'processing'})),null);
  assert.equal(engine.snapshot().jobs.find(row=>row.id===delivery.id).reason,'refund_pending');
  assert.equal(engine.snapshot().jobs.some(row=>row.type==='refund'),false);
});
test('known preflight deferral returns to the queue without consuming the chat rate limit',async t=>{
  let calls=0;
  const {engine,advance}=fixture(t,{sendMessage:async()=>++calls===1?{status:'deferred',reason:'not submitted'}:{status:'confirmed'}});
  const job=engine.ingestOrder(order());
  assert.equal((await engine.dispatch(job.id)).status,'queued');
  assert.equal(engine.nextJob(),null);advance(3000);
  assert.equal((await engine.dispatch(engine.nextJob().id)).status,'sent');assert.equal(calls,2);
});
test('enabling shipping confirmation later handles only a previously confirmed local delivery',async t=>{
  const {engine}=fixture(t);engine.updateConfig({...engine.snapshot().config,autoConfirmShipmentEnabled:false});
  await engine.dispatch(engine.ingestOrder(order()).id);
  engine.updateConfig({...engine.snapshot().config,autoConfirmShipmentEnabled:true});
  assert.equal(engine.ingestOrder(order()),null);
  assert.equal(engine.nextJob().type,'shipment');
});
