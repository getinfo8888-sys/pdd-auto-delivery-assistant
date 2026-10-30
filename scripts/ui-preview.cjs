'use strict';
// Local UI preview with its own identity, files and browser session. No merchant
// login, platform transport, notification service or system startup changes.
const {app,BrowserWindow,ipcMain,session}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const {Engine}=require('../src/core/engine.cjs');
const {defaults:alertDefaults,validateSettings}=require('../src/core/alert-monitor.cjs');
const {defaultProfile}=require('../src/platform/page-adapter.cjs');
const pendingDemo=process.argv.includes('--pending-reply-demo');
const root=path.resolve(__dirname,'..'),directory=path.join(root,'work',pendingDemo?'pending-reply-preview':'ui-preview');
fs.mkdirSync(directory,{recursive:true});
app.setName(pendingDemo?'pdd-assistant-pending-preview':'pdd-assistant-ui-preview');
app.setAppUserModelId(pendingDemo?'local.linkfulfillment.workbench.pending-preview':'local.linkfulfillment.workbench.ui-preview');
app.setPath('userData',path.join(directory,'browser-data'));
if(!app.requestSingleInstanceLock())app.quit();
else {
  let window,engine,revision=0,startup=false,alertConfig={...alertDefaults};
  const snapshot=()=>({...engine.snapshot(),revision,readOnly:true,preview:true,version:require('../package.json').version+' · 界面测试版',startup,dataDir:directory,
    autoStart:{phase:'idle',pending:false},catchUp:{phase:'disabled'},
    cloudWatchdog:{enabled:false,configured:false,url:'',status:'idle',error:null,lastAcceptedAt:null},
    phoneAlerts:{config:alertConfig,credentials:{serverchan:false,pushplus:false},encryptionAvailable:false,monitor:{incident:null,lastNotification:null},test:null},
    connection:{profile:defaultProfile(),diagnostics:{chat:{ready:false,message:'界面测试版使用本地虚构数据，正式助手继续接待。'},notes:[]},bridge:{chat:{ready:false},orders:{ready:false},refunds:{ready:false}},urls:{},pages:{},network:{phase:'online'},coverage:'界面预览不连接真实店铺。'}});
  const changed=()=>{revision++;window.webContents.send('state:changed');return snapshot();};
  const unsupported=()=>{throw Error('界面测试版仅使用本地样本，此操作请在正式版中执行。');};
  app.on('second-instance',()=>{window?.show();window?.focus();});
  app.whenReady().then(async()=>{
    session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(_details,done)=>done({cancel:true}));
    const sampleSend=async job=>{
      if(!pendingDemo||!job.officialPendingFallback||job.shopId!=='preview-shop'||!job.buyerId.startsWith('withdrawn-sample-'))throw Error('隔离样本不允许此发送');
      return {status:'confirmed',messageId:'fixture-receipt-'+Date.now(),outbound:{sha256:require('node:crypto').createHash('sha256').update(job.wireContent).digest('hex'),length:job.wireContent.length}};
    };
    engine=new Engine({filePath:path.join(directory,'state.json'),sendMessage:pendingDemo?sampleSend:unsupported,markShipped:unsupported,agreeRefund:unsupported});
    const runPendingSample=async()=>{
      engine.updateConfig({...engine.snapshot().config,running:true,autoReplyEnabled:true,greetingEnabled:false,replyDelaySeconds:0,cooldownSeconds:0,maxPerMinute:60});
      const now=Date.now(),markerMessageId='fixture-withdrawn-'+now,pendingSince=now-60000;
      const source={shopId:'preview-shop',buyerId:'withdrawn-sample-'+now,buyerName:'撤回后待回复（隔离样本）',messageId:'official-pending:'+JSON.stringify([markerMessageId,pendingSince]),text:'',sentAt:pendingSince,direction:'incoming',pending:true,officialPendingFallback:{markerMessageId,pendingSince,historyVerified:true}};
      const first=engine.recoverUnrepliedMessage(source),second=engine.recoverUnrepliedMessage(source);
      if(first.status!=='created'||second.status!=='queued')throw Error('隔离补答排队或去重验证失败');
      const sent=await engine.dispatch(first.job.id),again=engine.recoverUnrepliedMessage(source);
      if(sent.status!=='sent'||again.status!=='already_handled')throw Error('隔离回执或已答复去重验证失败');
      fs.writeFileSync(path.join(directory,'sample-result.json'),JSON.stringify({ok:true,fixture:true,actualPlatformWrites:0,queued:true,usedConfiguredFallback:sent.content===engine.snapshot().config.fallback,fixtureReceipt:sent.sentMessageId,repeatScan:again.status},null,2));
      return changed();
    };
    if(!engine.snapshot().config.products.length)engine.updateConfig({...engine.snapshot().config,products:[{id:'preview-product',name:'示例商品甲',keywords:['示例商品甲'],excludeKeywords:[],content:'领取地址：https://example.test/resource',enabled:true,matchTarget:'either'}]});
    window=new BrowserWindow({width:1440,height:920,minWidth:1120,minHeight:740,show:false,title:'拼多多自动发货助手 · 界面测试版',icon:path.join(root,'src/renderer/icon.ico'),autoHideMenuBar:true,webPreferences:{preload:path.join(root,'src/preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',event=>event.preventDefault());
    const handle=(name,action)=>ipcMain.handle(name,(event,value)=>{if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw Error('无效的预览请求');return action(value);});
    handle('snapshot',snapshot);
    handle('running:set',value=>{if(typeof value!=='boolean')throw Error('监听状态无效');engine.setRunning(value);return changed();});
    handle('settings:update',value=>{const {startup:nextStartup,...patch}=value;if(nextStartup!==undefined)startup=nextStartup===true;engine.updateConfig({...engine.snapshot().config,...patch});return changed();});
    handle('config:update',value=>{engine.updateConfig({...value,running:engine.snapshot().config.running});return changed();});
    handle('phone-alerts:save',value=>{if(value.token)throw Error('界面测试版不保存密钥，请勿填写真实密钥。');alertConfig=validateSettings(value.config);return changed();});
    handle('media:preview',()=>({preview:null}));
    handle('browser:show',()=>true);handle('browser:bounds',()=>true);
    handle('app:background',()=>{window.minimize();return true;});
    for(const name of ['cloud-watchdog:save','cloud-watchdog:disable','phone-alerts:test','phone-alerts:setup','desktop-alert:test','media:add','platform:check','browser:reload','browser:home','profile:save','profile:probe','profile:pick','official:inspect','jobs:resolve','data:export','data:import','content:export','content:preview','content:repreview','content:apply','app:data-folder'])handle(name,unsupported);
    handle('content:cancel',()=>({cancelled:true}));
    handle('simulate:order',value=>{engine.ingestOrder({...value,shopId:'preview-shop',buyerId:'preview-buyer',buyerName:'示例买家',orderId:'preview-'+Date.now(),itemId:'preview-item',paid:value.paid===true},{simulation:true});return changed();});
    handle('simulate:message',value=>{if(pendingDemo)return runPendingSample();engine.ingestMessage({text:value.text,direction:'incoming',shopId:'preview-shop',buyerId:'preview-buyer-'+Date.now(),messageId:'preview-'+Date.now()},{simulation:true});return changed();});
    handle('simulate:refund',value=>{engine.ingestRefund({shopId:'preview-shop',orderId:value.orderId||'preview-order',refundId:'preview-'+Date.now(),status:'pending'},{simulation:true});return changed();});
    await window.loadFile(path.join(root,'src/renderer/index.html'));
    await window.webContents.executeJavaScript(`document.title='拼多多自动发货助手 · 界面测试版';document.querySelector('.brand span').textContent='界面测试版';document.querySelector('.top-caption').textContent='仅使用本地虚构数据，不连接店铺；正式版继续接待。';void 0;`);
    if(pendingDemo){
      await runPendingSample();
      await window.webContents.executeJavaScript(`(()=>{document.title='拼多多助手 · 待回复保障测试版';statusText.sent='样本回执已确认';document.querySelector('.brand span').textContent='待回复保障测试版';document.querySelector('.top-caption').textContent='撤回后仍待回复 → 当前默认答复 → 样本回执。只使用隔离数据，正式版继续接待。';const button=document.createElement('button');button.className='button primary';button.textContent='测试撤回后补答';button.addEventListener('click',async()=>{await window.workbench.call('simulate:message',{});page='records';await refresh(true);});document.getElementById('running-button').before(button);page='records';void refresh(true);})()`);
      await new Promise(resolve=>setTimeout(resolve,350));
      fs.writeFileSync(path.join(directory,'pending-reply-preview.png'),(await window.webContents.capturePage()).toPNG());
    }
    if(process.argv.includes('--capture')){
      const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      for(const [owner,key]of [['settings','runtime'],['products','delivery'],['replies','strategy'],['settings','alerts']]){
        await window.webContents.executeJavaScript(`document.querySelector('[data-nav="${owner}"]').click();void 0;`);await wait(100);
        await window.webContents.executeJavaScript(`document.querySelector('[data-section="${key}"]').click();void 0;`);await wait(150);
        fs.writeFileSync(path.join(directory,`${owner}-${key}.png`),(await window.webContents.capturePage()).toPNG());
      }
      await window.webContents.executeJavaScript(`document.querySelector('[data-nav="shop"]').click();void 0;`);
    }
    window.show();
    console.log(JSON.stringify({ok:true,mode:'ui-preview',directory,actualPlatformWrites:0,externalRequestsAllowed:false}));
  }).catch(error=>{console.error(error);app.exit(1);});
  app.on('window-all-closed',()=>app.quit());
}
