'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run({app,window,engine,startupListener,pause,poll,pollCapability,capabilityRecovery,bridgeDiagnostics,observeNetwork,networkRefresh,configureTestPlatform}) {
  const platform=require('./fixture-platform.cjs').createPlatform();configureTestPlatform(platform);
  const until=async(check,label)=>{const end=Date.now()+18000;while(Date.now()<end){if(await check())return;await wait(100);}throw Error('Timeout: '+label);};
  const normal=platform.bridge;let blocked=true,hold=false,entered=false,release,orderReads=0;
  platform.bridge=async(kind,action,payload)=>{
    if(kind==='orders') {
      orderReads++;
      if(hold){entered=true;await new Promise(resolve=>{release=resolve;});}
      if(blocked)throw Error('官方订单页需要完成滑块安全验证');
    }
    return normal(kind,action,payload);
  };
  const order={shopId:platform.data.shopId,buyerId:'order-buyer',orderId:'queued-order',title:'资源商品',sku:'标准版',paid:true,eligible:true};
  platform.data.orders.set(order.orderId,order);
  engine.updateConfig({...engine.snapshot().config,autoReplyEnabled:true,autoDeliveryEnabled:true,autoRefundEnabled:true,autoConfirmShipmentEnabled:true,autoListenOnLaunch:true,greetingEnabled:false,replyDelaySeconds:0,cooldownSeconds:0,maxPerMinute:120,catchUpUnrepliedEnabled:false,
    products:[{id:'resource',name:'资源内容',keywords:['资源商品'],content:'已购资源领取说明',enabled:true}],fallback:'这是配置的默认答复'});
  await until(()=>window.webContents.executeJavaScript("!!document.querySelector('#running-button')"),'UI loaded');
  startupListener.arm(engine.snapshot().config);
  await until(()=>engine.snapshot().config.running&&bridgeDiagnostics.orders.verification,'startup continues while order verification is blocked');
  const queued=engine.ingestOrder(order);assert.equal(queued.status,'queued');
  const incoming=id=>({shopId:platform.data.shopId,buyerId:id,messageId:id,text:'咨询',type:'0',subType:'0',direction:'incoming',pending:true,sentAt:Date.now()});
  const first=incoming('reply-during-verification');platform.data.unreplied.push(first);engine.ingestMessage(first);
  platform.data.refunds.push({buyerId:'refund-buyer',orderId:'other-order',refundId:'independent-refund',refundVersion:'1',status:'pending'});
  await until(()=>engine.snapshot().jobs.some(j=>j.messageId===first.messageId&&j.status==='sent'),'chat replies while orders await verification');
  await until(()=>engine.snapshot().stats.refundSent===1,'known-buyer refund completes independently');
  assert.equal(engine.snapshot().jobs.find(j=>j.id===queued.id).status,'queued');
  assert.equal(platform.data.actions.some(a=>a.orderId===order.orderId),false);
  // A hanging order request must not occupy the chat poll/dispatch loop.
  hold=true;blocked=false;capabilityRecovery.rows.orders.retryAt=0;
  const pending=pollCapability('orders');await until(()=>entered,'order read is in flight');
  const second=incoming('reply-during-slow-order');platform.data.messages.push(second);
  await poll();
  await until(()=>engine.snapshot().jobs.some(j=>j.messageId===second.messageId&&j.status==='sent'),'reply dispatch is independent of slow order request');
  hold=false;release();await pending;
  await until(()=>platform.data.orders.get(order.orderId).shipped,'verification recovery resumes retained delivery and confirmation');
  assert.deepEqual(platform.data.actions.filter(a=>a.orderId===order.orderId).map(a=>a.action),['send','ship']);
  // A refund-list failure similarly cannot disable healthy replies or orders.
  platform.bridge=async(kind,action,payload)=>{if(action==='refunds')throw Error('售后列表读取失败');return normal(kind,action,payload);};
  capabilityRecovery.rows.refunds.retryAt=0;await pollCapability('refunds');
  assert.equal(bridgeDiagnostics.refunds.ready,false);assert.equal(engine.snapshot().config.running,true);
  const third=incoming('reply-during-refund-failure');platform.data.unreplied.push(third);engine.ingestMessage(third);
  await until(()=>engine.snapshot().jobs.some(j=>j.messageId===third.messageId&&j.status==='sent'),'reply works while refunds are unavailable');
  platform.bridge=normal;
  // Visible order validation is preserved even on an actual recovery wave.
  const reloads=[];platform.pageKinds=['chat','orders'];platform.visibleKind='orders';platform.pageStatus={orders:{verification:true}};
  platform.reload=async kind=>{reloads.push(kind);};
  observeNetwork(true);observeNetwork(false);observeNetwork(true);
  await until(()=>networkRefresh.state.phase==='complete'&&engine.snapshot().config.running,'network recovery with visible order verification');
  assert.equal(reloads.includes('orders'),false);
  assert.equal(networkRefresh.state.pages.some(p=>p.kind==='orders'&&p.outcome==='verification_preserved'),true);
  // Refund-only startup never requires an order-list page. A missing UID may
  // still use a targeted official order-detail read.
  pause();engine.updateConfig({...engine.snapshot().config,autoDeliveryEnabled:false,autoRefundEnabled:true});
  const before=orderReads;platform.bridge=async(kind,action,payload)=>{if(kind==='orders'&&action==='waiting')throw Error('refund-only must not load order lists');return normal(kind,action,payload);};
  startupListener.arm(engine.snapshot().config);await until(()=>engine.snapshot().config.running,'refund-only startup');
  const lookupOrder={...order,orderId:'lookup-refund-order',buyerId:'lookup-buyer'};platform.data.orders.set(lookupOrder.orderId,lookupOrder);
  platform.data.refunds.push({orderId:lookupOrder.orderId,refundId:'lookup-refund',refundVersion:'1',status:'pending'});
  await until(()=>engine.snapshot().stats.refundSent===2,'refund missing UID uses targeted order lookup');
  assert.equal(orderReads,before);
  pause();const result={ok:true,actualPlatformWrites:0,fixtureWrites:platform.data.actions.length,assertions:['startup survives order verification','queued delivery preserved during verification','chat replies during order verification','known-buyer refund independent from order page','slow order reads do not hold chat polling or reply dispatch','retained delivery resumes after recovery','one content send and one shipment confirmation','refund failure leaves replies working','visible CAPTCHA preserved across network recovery','refund-only startup does not load waiting-order list','missing refund UID resolved with targeted order lookup']};
  fs.writeFileSync(path.resolve(__dirname,'../work/capability-smoke-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));app.quit();
}
module.exports={run};
