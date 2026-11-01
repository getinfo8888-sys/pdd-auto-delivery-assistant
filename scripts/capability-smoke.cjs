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
  // A user navigated the same visible merchant view into a product editor.
  // Re-reading/refreshing that route cannot load the order API. Preserve edits,
  // then return to the order entry automatically without restarting reception.
  const entry='https://mms.pinduoduo.com/orders/list',restoredPages=[];
  platform.pageUrls={orders:'https://mms.pinduoduo.com/goods/goods_edit'};
  platform.pageStatus={orders:{loaded:true,hasDraft:true}};
  platform.reload=async(kind,url)=>{restoredPages.push({kind,url});platform.pageUrls[kind]=url;};
  platform.bridge=async(kind,action,payload)=>kind==='orders'&&platform.pageUrls.orders!==entry?{ready:false,status:'rejected',reason:'请打开官方客服或订单页面并登录'}:normal(kind,action,payload);
  const stranded={...order,orderId:'stranded-after-merchant-navigation',buyerId:'stranded-buyer',shipped:false,eligible:true};platform.data.orders.set(stranded.orderId,stranded);
  capabilityRecovery.rows.orders.retryAt=0;await pollCapability('orders');
  capabilityRecovery.rows.orders.retryAt=0;await pollCapability('orders');
  assert.equal(restoredPages.length,0);assert.equal(engine.snapshot().config.running,true);
  assert.equal(platform.data.actions.some(row=>row.orderId===stranded.orderId),false);
  const duringEditor=incoming('reply-during-merchant-editor');platform.data.unreplied.push(duringEditor);engine.ingestMessage(duringEditor);
  await until(()=>engine.snapshot().jobs.some(j=>j.messageId===duringEditor.messageId&&j.status==='sent'),'chat works while merchant draft is preserved');
  // A manual refresh (or leaving the saved editor) removes the document draft.
  platform.pageStatus.orders.hasDraft=false;capabilityRecovery.rows.orders.retryAt=0;
  await pollCapability('orders');
  await until(()=>platform.data.orders.get(stranded.orderId).shipped,'wrong merchant route automatically restores delivery without restart');
  assert.deepEqual(restoredPages,[{kind:'orders',url:entry}]);
  assert.deepEqual(platform.data.actions.filter(row=>row.orderId===stranded.orderId).map(row=>row.action),['send','ship']);
  const stableReloads=restoredPages.length;await wait(350);assert.equal(restoredPages.length,stableReloads);
  // The same recovery queue must survive a failed navigation and obey its
  // cooldown rather than depending on a second application launch.
  platform.pageUrls.orders='https://mms.pinduoduo.com/home';let failedReloads=0;
  platform.reload=async(kind,url)=>{failedReloads++;if(failedReloads===1)throw Error('net::ERR_CONNECTION_RESET');platform.pageUrls[kind]=url;};
  capabilityRecovery.rows.orders.retryAt=0;await pollCapability('orders');
  capabilityRecovery.rows.orders.retryAt=0;await pollCapability('orders');assert.equal(failedReloads,1);
  capabilityRecovery.rows.orders.retryAt=0;await pollCapability('orders');assert.equal(failedReloads,1);assert.equal(engine.snapshot().config.running,true);
  await wait(300);capabilityRecovery.rows.orders.retryAt=0;await pollCapability('orders');
  assert.equal(failedReloads,2);assert.equal(bridgeDiagnostics.orders.ready,true);
  // A real CAPTCHA on a wrong route is not dismissed by the recovery path.
  platform.pageUrls.orders='https://mms.pinduoduo.com/home';platform.pageStatus.orders={loaded:true,verification:true};
  capabilityRecovery.rows.orders.retryAt=0;await pollCapability('orders');await wait(300);
  capabilityRecovery.rows.orders.retryAt=0;await pollCapability('orders');assert.equal(failedReloads,2);
  platform.pageStatus.orders.verification=false;capabilityRecovery.rows.orders.retryAt=0;await pollCapability('orders');
  assert.equal(bridgeDiagnostics.orders.ready,true);assert.equal(failedReloads,3);
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
  pause();const result={ok:true,actualPlatformWrites:0,fixtureWrites:platform.data.actions.length,assertions:['startup survives order verification','queued delivery preserved during verification','chat replies during order verification','known-buyer refund independent from order page','slow order reads do not hold chat polling or reply dispatch','retained delivery resumes after recovery','one content send and one shipment confirmation','refund failure leaves replies working','merchant editor draft is preserved while chat continues','wrong merchant route returns to order entry without restart','stranded order receives exactly one delivery and one confirmation','healthy order page is not repeatedly refreshed','failed recovery navigation is throttled and retried without restart','CAPTCHA on a wrong route is preserved until user completion','visible CAPTCHA preserved across network recovery','refund-only startup does not load waiting-order list','missing refund UID resolved with targeted order lookup']};
  fs.writeFileSync(path.resolve(__dirname,'../work/capability-smoke-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));app.quit();
}
module.exports={run};
