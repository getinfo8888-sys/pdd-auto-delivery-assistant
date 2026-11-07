'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run({app,window,engine,dataDir,dispatchRecovery,phoneAlerts,configureTestPlatform}){
  const platform=require('./fixture-platform.cjs').createPlatform();configureTestPlatform(platform);
  const until=async(check,label)=>{const end=Date.now()+45000;while(Date.now()<end){if(await check())return;await wait(100);}throw Error('Dispatch recovery timeout: '+label);};
  engine.updateConfig({...engine.snapshot().config,autoReplyEnabled:true,autoDeliveryEnabled:true,autoConfirmShipmentEnabled:true,greetingEnabled:false,replyDelaySeconds:0,cooldownSeconds:0,maxPerMinute:120,separateLinksEnabled:true,products:[{id:'fixture',name:'示例内容',keywords:['示例商品'],content:'领取说明 https://example.test/resource',enabled:true}],fallback:'示例默认答复'});
  await window.webContents.executeJavaScript(`window.workbench.call('running:set',true)`);
  const rename=fs.renameSync,send=engine.sendMessage;let locked=false,injected=false;
  fs.renameSync=(from,to)=>{if(locked&&to===engine.filePath)throw Object.assign(Error('fixture locked file'),{code:'EBUSY'});return rename(from,to);};
  engine.sendMessage=async job=>{const result=await send(job);if(job.orderId==='fixture-order'&&job.partKind==='link'&&!injected){injected=true;locked=true;}return result;};
  const normal=platform.bridge;
  platform.bridge=async(kind,action,payload)=>{
    if(action==='attachment-check'&&platform.data.actions.some(a=>a.jobId===payload.job.id&&a.action==='send'))return {ready:true,status:'confirmed',messageId:'77777'};
    return normal(kind,action,payload);
  };
  try{
    const order={shopId:platform.data.shopId,buyerId:'fixture-buyer',orderId:'fixture-order',itemId:'item',title:'示例商品',paid:true,eligible:true};platform.data.orders.set(order.orderId,order);
    await until(()=>dispatchRecovery.snapshot().active,'post-send failure is observed');
    assert.equal(engine.snapshot().config.running,true);assert.equal(platform.data.orders.get(order.orderId).shipped,undefined);
    const child=engine.snapshot().jobs.find(j=>j.orderId===order.orderId&&j.partKind==='link');assert.equal(child.status,'uncertain');
    await wait(6500);assert.equal(dispatchRecovery.snapshot().active,true);assert.equal(phoneAlerts.monitor.sample.wanted,true);assert.equal(phoneAlerts.monitor.sample.reason,'stalled');
    assert.equal(platform.data.actions.filter(a=>a.jobId===child.id&&a.action==='send').length,1);
    locked=false;await until(()=>!dispatchRecovery.snapshot().active,'durable checkpoint succeeds without restart');
    const msg={shopId:platform.data.shopId,buyerId:'another-buyer',messageId:'another-inquiry',text:'咨询',type:'0',subType:'0',direction:'incoming',pending:true,sentAt:Date.now()};platform.data.unreplied.push(msg);engine.ingestMessage(msg);
    await until(()=>engine.snapshot().jobs.some(j=>j.messageId===msg.messageId&&j.status==='sent'),'independent reply continues');
    await until(()=>platform.data.orders.get(order.orderId).shipped,'platform lookup confirms the uncertain link before shipment');
    assert.equal(platform.data.actions.filter(a=>a.jobId===child.id&&a.action==='send').length,1);assert.equal(platform.data.actions.filter(a=>a.action==='ship'&&a.orderId===order.orderId).length,1);
    assert.equal(engine.snapshot().config.running,true);assert.equal(engine.snapshot().logs.some(l=>l.code==='paused'),false);
    dispatchRecovery.fail(Error('fixture failure'));await window.webContents.executeJavaScript(`window.workbench.call('running:set',false)`);await wait(3500);assert.equal(engine.snapshot().config.running,false);assert.equal(dispatchRecovery.snapshot().active,true);
    const result={ok:true,actualPlatformWrites:0,externalRequests:0,assertions:['result-save failure retains listening intent','unknown link is not resent','persistent storage faults remain armed for alerts','durable checkpoint resumes work without restarting','independent reply resumes','official fixture receipt precedes one shipment','manual pause is never automatically overridden']};fs.writeFileSync(path.join(dataDir,'dispatch-recovery-smoke-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }finally{locked=false;fs.renameSync=rename;engine.sendMessage=send;app.quit();}
}
module.exports={run};
