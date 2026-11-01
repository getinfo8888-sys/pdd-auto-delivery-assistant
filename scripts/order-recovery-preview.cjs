'use strict';
// Uses the actual main-process poll/recovery/receipt pipeline with local
// fixtures. Main gives this preview its own identity, data and blocked network.
const {ipcMain}=require('electron');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run({window,engine,dataDir,startupListener,pollCapability,capabilityRecovery,configureTestPlatform}){
  const platform=require('./fixture-platform.cjs').createPlatform();configureTestPlatform(platform);
  const entry='https://mms.pinduoduo.com/orders/list',normal=platform.bridge;
  platform.pageUrls={orders:entry};platform.pageStatus={orders:{loaded:true,hasDraft:false}};
  platform.reload=async(kind,url)=>{await wait(400);platform.pageUrls[kind]=url;};
  platform.bridge=(kind,action,payload)=>kind==='orders'&&platform.pageUrls.orders!==entry?Promise.resolve({ready:false,status:'rejected',reason:'请打开官方客服或订单页面并登录'}):normal(kind,action,payload);
  engine.updateConfig({...engine.snapshot().config,autoReplyEnabled:true,autoDeliveryEnabled:true,autoRefundEnabled:false,autoConfirmShipmentEnabled:true,autoListenOnLaunch:true,greetingEnabled:false,replyDelaySeconds:0,cooldownSeconds:0,maxPerMinute:120,catchUpUnrepliedEnabled:false,separateLinksEnabled:false,suffix:'',products:[{id:'recovery-sample',name:'示例资源商品',keywords:['示例资源商品'],content:'隔离发货样本：https://example.test/resource',enabled:true}],fallback:'隔离样本默认答复'});
  let busy=false;
  const scenario=async action=>{
    if(busy)throw Error('样本正在准备，请稍候');busy=true;
    try{
      if(action==='release')platform.pageStatus.orders.hasDraft=false;
      else if(['recover','draft'].includes(action)){
        platform.pageUrls.orders='https://mms.pinduoduo.com/goods/goods_edit';platform.pageStatus.orders.hasDraft=action==='draft';
        const id='fixture-order-'+Date.now();platform.data.orders.set(id,{shopId:platform.data.shopId,orderId:id,buyerId:'fixture-buyer-'+Date.now(),title:'示例资源商品',sku:'标准版',paid:true,eligible:true,shipped:false});
      }else throw Error('未知隔离样本');
      capabilityRecovery.rows.orders={...capabilityRecovery.state('orders'),retryAt:0};await pollCapability('orders');
      return {fixture:true,actualPlatformWrites:0,hasDraft:platform.pageStatus.orders.hasDraft};
    }finally{busy=false;}
  };
  ipcMain.handle('order-recovery-preview:scenario',(event,action)=>{
    if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw Error('无效的隔离样本请求');return scenario(action);
  });
  startupListener.arm(engine.snapshot().config);
  const deadline=Date.now()+8000;while(!engine.snapshot().config.running){if(Date.now()>deadline)throw Error('隔离样本启动失败');await wait(100);}
  await window.webContents.executeJavaScript(`(()=>{document.title='拼多多助手 · 发货恢复测试版';statusText.sent='样本回执已确认';document.querySelector('.brand span').textContent='发货恢复测试版';document.querySelector('.top-caption').textContent='本地虚构订单与回执；不连接店铺，正式版继续接待。';for(const [action,label] of [['recover','测试自动恢复'],['draft','测试保护编辑'],['release','模拟保存并刷新']]){const button=document.createElement('button');button.className='button';button.textContent=label;button.addEventListener('click',async()=>{try{await window.workbench.call('order-recovery-preview:scenario',action);page='records';await refresh(true);}catch(error){alert(error.message);}});document.getElementById('running-button').before(button);}page='records';void refresh(true);})()`);
  await scenario('recover');window.show();
  const verifiedBy=Date.now()+12000;while(![...platform.data.orders.values()].every(row=>row.shipped)){if(Date.now()>verifiedBy)throw Error('隔离恢复样本未取得完整回执');await wait(100);}
  const jobs=engine.snapshot().jobs;
  require('node:fs').writeFileSync(require('node:path').join(dataDir,'preview-result.json'),JSON.stringify({ok:true,actualPlatformWrites:0,externalRequestsAllowed:false,orderRouteRestored:platform.pageUrls.orders===entry,sampleDeliveryReceipts:jobs.filter(row=>row.type==='delivery'&&row.status==='sent'&&row.sentMessageId).length,sampleShipmentConfirmations:jobs.filter(row=>row.type==='shipment'&&row.status==='sent').length},null,2));
  console.log(JSON.stringify({mode:'order-recovery-preview',dataDir,actualPlatformWrites:0,externalRequestsAllowed:false}));
}
module.exports={run};
