'use strict';
const assert=require('node:assert/strict');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run({app,window,engine,platform,configureTestPlatform}){
  const standalone=!platform;
  if(standalone){platform=require('./fixture-platform.cjs').createPlatform();configureTestPlatform(platform);await window.webContents.executeJavaScript(`window.workbench.call('running:set',true)`);}
  const ui=code=>window.webContents.executeJavaScript(code);
  const until=async(check,label)=>{const deadline=Date.now()+10000;while(Date.now()<deadline){if(await check())return;await wait(75);}throw Error('Live settings timeout: '+label);};
  const save=patch=>ui(`(async()=>{const latest=await window.workbench.call('snapshot');return window.workbench.call('config:update',{...latest.config,...${JSON.stringify(patch)}});})()`);
  const original=engine.snapshot().config,originalBridge=platform.bridge;
  const pausedBefore=()=>engine.snapshot().logs.filter(row=>row.code==='paused').length;
  const pausedCount=pausedBefore();
  const incoming=id=>({shopId:platform.data.shopId,messageId:id,buyerId:'buyer-'+id,text:'咨询说明',direction:'incoming',type:'0',subType:'0',history:false,pending:true,sentAt:Date.now()});
  const addMessage=id=>{const event=incoming(id);platform.data.messages.push(event);return engine.ingestMessage(event);};
  const order=id=>({shopId:platform.data.shopId,orderId:id,itemId:'item-'+id,buyerId:'buyer-'+id,title:'隔离样本商品',sku:'标准规格',paid:true,eligible:true,shipped:false,refunded:false,cancelled:false});
  const job=id=>engine.snapshot().jobs.find(row=>row.id===id);
  let releaseGate;
  try{
    assert.equal(original.running,true);
    await save({autoReplyEnabled:true,autoDeliveryEnabled:true,autoConfirmShipmentEnabled:true,autoRefundEnabled:true,greetingEnabled:false,fallback:'旧的隔离答复',replyDelaySeconds:0,firstReplyDelaySeconds:0,cooldownSeconds:0,replySuffixEnabled:false,separateLinksEnabled:false,fallbackImages:[],maxPerMinute:120,deliveryFallbackEnabled:true,deliveryFallback:'隔离样本领取说明',deliveryFallbackImages:[]});
    // Hold the real transport preflight, then change the text through the real
    // IPC handler. No old text may cross the write boundary after that change.
    let entered=false;
    const gate=new Promise(resolve=>{releaseGate=resolve;});
    platform.bridge=async(kind,action,payload)=>{if(action==='reply-check'&&payload.buyerId==='buyer-live-preflight'&&!entered){entered=true;await gate;}return originalBridge(kind,action,payload);};
    const pending=addMessage('live-preflight');
    await until(()=>entered,'transport reached reply verification');
    await save({fallback:'新的隔离答复'});assert.equal(engine.snapshot().config.running,true);
    releaseGate();
    await until(()=>job(pending.id)?.status==='sent','updated reply receives fixture receipt');
    assert.equal(job(pending.id).content,'新的隔离答复');
    assert.deepEqual(platform.data.actions.filter(row=>row.jobId===pending.id).map(row=>row.content),['新的隔离答复']);
    platform.bridge=originalBridge;

    await save({replyDelaySeconds:30});
    const waiting=addMessage('live-reply-off');
    await ui(`document.querySelector('[data-nav="replies"]').click();void 0;`);
    await until(()=>ui(`!!document.querySelector('[data-section="strategy"]')`),'reply navigation');
    await ui(`document.querySelector('[data-section="strategy"]').click();void 0;`);
    await until(()=>ui(`!!document.getElementById('autoReplyEnabled')`),'reply switch');
    await ui(`document.getElementById('autoReplyEnabled').click();void 0;`);
    await until(()=>!engine.snapshot().config.autoReplyEnabled,'reply switch auto-saves');
    assert.equal(engine.snapshot().config.running,true);
    assert.equal(engine.snapshot().config.autoDeliveryEnabled,true);assert.equal(engine.snapshot().config.autoRefundEnabled,true);
    await save({replyDelaySeconds:0});
    // The disabled reply remains queued while delivery, confirmation and refund
    // continue through the same isolated main-process transport.
    const sale=order('live-sale');platform.data.orders.set(sale.orderId,sale);engine.ingestOrder(sale);
    const missed=incoming('live-disabled-inquiry');platform.data.messages.push(missed);platform.data.unreplied.push(missed);engine.ingestMessage(missed);
    const refund={shopId:platform.data.shopId,orderId:'live-refund-order',refundId:'live-refund',buyerId:'buyer-live-refund',status:'pending',refundVersion:'1'};platform.data.refunds.push(refund);const refundJob=engine.ingestRefund(refund);
    await until(()=>platform.data.orders.get(sale.orderId).shipped&&job(refundJob.id)?.status==='sent','other functions run with replies off');
    assert.equal(job(waiting.id).status,'queued');assert.equal(platform.data.actions.some(row=>row.jobId===waiting.id),false);
    await save({autoReplyEnabled:true,autoConfirmShipmentEnabled:false});
    await until(()=>job(waiting.id)?.status==='sent','reply resumes without restarting the listener');
    await until(()=>engine.snapshot().jobs.some(row=>row.messageId===missed.messageId&&row.status==='sent'),'re-enable catches inquiries received while replies were off');
    const unconfirmed=order('live-confirm-off');platform.data.orders.set(unconfirmed.orderId,unconfirmed);const contentJob=engine.ingestOrder(unconfirmed);
    await until(()=>job(contentJob.id)?.status==='sent','content delivery with confirmation off');
    assert.equal(platform.data.orders.get(unconfirmed.orderId).shipped,false);
    assert.equal(engine.snapshot().config.running,true);
    await save({autoConfirmShipmentEnabled:true,autoRefundEnabled:false});
    const heldRefund={...refund,refundId:'live-refund-off',orderId:'live-refund-off-order',status:'pending'};platform.data.refunds.push(heldRefund);const heldRefundJob=engine.ingestRefund(heldRefund);
    const independentReply=addMessage('live-refund-off-reply');
    await until(()=>job(independentReply.id)?.status==='sent'&&platform.data.orders.get(unconfirmed.orderId).shipped,'reply and shipment with refund off');
    assert.notEqual(job(heldRefundJob.id).status,'sent');
    await save({autoRefundEnabled:true});await until(()=>job(heldRefundJob.id)?.status==='sent','refund resumes independently');
    await save({autoDeliveryEnabled:false});
    const heldSale=order('live-delivery-off');platform.data.orders.set(heldSale.orderId,heldSale);engine.ingestOrder(heldSale);
    const withDeliveryOff=addMessage('live-delivery-off-reply'),independentRefund={...refund,refundId:'live-delivery-off-refund',orderId:'live-delivery-off-refund-order',status:'pending'};platform.data.refunds.push(independentRefund);const independentRefundJob=engine.ingestRefund(independentRefund);
    await until(()=>job(withDeliveryOff.id)?.status==='sent'&&job(independentRefundJob.id)?.status==='sent','reply and refund with delivery off');
    assert.equal(platform.data.actions.some(row=>row.orderId===heldSale.orderId),false);
    await save({autoDeliveryEnabled:true});await until(()=>platform.data.orders.get(heldSale.orderId).shipped,'delivery resumes independently');
    await save({autoReplyEnabled:false,autoDeliveryEnabled:false,autoRefundEnabled:false});
    const count=platform.data.actions.length;await wait(400);assert.equal(platform.data.actions.length,count);assert.equal(engine.snapshot().config.running,true);
    assert.equal(pausedBefore(),pausedCount,'ordinary configuration never pauses the listener');
    await ui(`window.workbench.call('running:set',false)`);
    await save({replyDelaySeconds:2});assert.equal(engine.snapshot().config.running,false,'saving preserves a manual pause too');
    await save(original);
    await ui(`window.workbench.call('running:set',true)`);await until(()=>engine.snapshot().config.running,'restore isolated workflow');
    const result={ok:true,assertions:['latest content replaces a definitely unsubmitted preflight without sending the old text','reply switch auto-saves without pausing','delivery, confirmation and refund continue with replies disabled','enabling replies catches inquiries received while the switch was off','delivery, confirmation and refund switches affect their own operations','all automatic functions can be off while monitoring stays on','saving preserves a manual pause'],actualPlatformWrites:0};
    if(standalone){require('node:fs').writeFileSync(require('node:path').resolve(__dirname,'../work/live-settings-smoke-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));app.quit();}
    return result;
  }finally{releaseGate?.();platform.bridge=originalBridge;}
}
module.exports={run};
