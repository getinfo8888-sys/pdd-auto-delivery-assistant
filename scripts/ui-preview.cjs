'use strict';
// Local UI preview with its own identity, files and browser session. No merchant
// login, platform transport, notification service or system startup changes.
const {app,BrowserWindow,ipcMain,session}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const {Engine}=require('../src/core/engine.cjs');
const {defaults:alertDefaults,validateSettings}=require('../src/core/alert-monitor.cjs');
const {defaultProfile}=require('../src/platform/page-adapter.cjs');
const root=path.resolve(__dirname,'..'),directory=path.join(root,'work','ui-preview');
fs.mkdirSync(directory,{recursive:true});
app.setName('pdd-assistant-ui-preview');
app.setAppUserModelId('local.linkfulfillment.workbench.ui-preview');
app.setPath('userData',path.join(directory,'browser-data'));
if(!app.requestSingleInstanceLock())app.quit();
else {
  let window,engine,revision=0,startup=false,alertConfig={...alertDefaults};
  const snapshot=()=>({...engine.snapshot(),revision,readOnly:true,version:require('../package.json').version+' · 界面测试版',startup,dataDir:directory,
    autoStart:{phase:'idle',pending:false},catchUp:{phase:'disabled'},
    phoneAlerts:{config:alertConfig,credentials:{serverchan:false,pushplus:false},encryptionAvailable:false,monitor:{incident:null,lastNotification:null},test:null},
    connection:{profile:defaultProfile(),diagnostics:{chat:{ready:false,message:'界面测试版使用本地虚构数据，正式助手继续接待。'},notes:[]},bridge:{chat:{ready:false},orders:{ready:false},refunds:{ready:false}},urls:{},pages:{},network:{phase:'online'},coverage:'界面预览不连接真实店铺。'}});
  const changed=()=>{revision++;window.webContents.send('state:changed');return snapshot();};
  const unsupported=()=>{throw Error('界面测试版仅使用本地样本，此操作请在正式版中执行。');};
  app.on('second-instance',()=>{window?.show();window?.focus();});
  app.whenReady().then(async()=>{
    session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(_details,done)=>done({cancel:true}));
    engine=new Engine({filePath:path.join(directory,'state.json'),sendMessage:unsupported,markShipped:unsupported,agreeRefund:unsupported});
    if(!engine.snapshot().config.products.length)engine.updateConfig({...engine.snapshot().config,products:[{id:'preview-product',name:'示例商品甲',keywords:['示例商品甲'],excludeKeywords:[],content:'领取地址：https://example.test/resource',enabled:true,matchTarget:'either'}]});
    window=new BrowserWindow({width:1440,height:920,minWidth:1120,minHeight:740,show:false,title:'拼多多自动发货助手 · 界面测试版',icon:path.join(root,'src/renderer/icon.ico'),autoHideMenuBar:true,webPreferences:{preload:path.join(root,'src/preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',event=>event.preventDefault());
    const handle=(name,action)=>ipcMain.handle(name,(event,value)=>{if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw Error('无效的预览请求');return action(value);});
    handle('snapshot',snapshot);
    handle('settings:update',value=>{const {startup:nextStartup,...patch}=value;if(nextStartup!==undefined)startup=nextStartup===true;engine.updateConfig({...engine.snapshot().config,...patch});return changed();});
    handle('config:update',value=>{engine.updateConfig(value);return changed();});
    handle('phone-alerts:save',value=>{if(value.token)throw Error('界面测试版不保存密钥，请勿填写真实密钥。');alertConfig=validateSettings(value.config);return changed();});
    handle('media:preview',()=>({preview:null}));
    handle('browser:show',()=>true);handle('browser:bounds',()=>true);
    handle('app:background',()=>{window.minimize();return true;});
    for(const name of ['running:set','phone-alerts:test','phone-alerts:setup','desktop-alert:test','media:add','platform:check','browser:reload','browser:home','profile:save','profile:probe','profile:pick','official:inspect','jobs:resolve','data:export','data:import','content:export','content:preview','content:repreview','content:apply','app:data-folder'])handle(name,unsupported);
    handle('content:cancel',()=>({cancelled:true}));
    handle('simulate:order',value=>{engine.ingestOrder({...value,shopId:'preview-shop',buyerId:'preview-buyer',buyerName:'示例买家',orderId:'preview-'+Date.now(),itemId:'preview-item',paid:value.paid===true},{simulation:true});return changed();});
    handle('simulate:message',value=>{engine.ingestMessage({text:value.text,direction:'incoming',shopId:'preview-shop',buyerId:'preview-buyer-'+Date.now(),messageId:'preview-'+Date.now()},{simulation:true});return changed();});
    handle('simulate:refund',value=>{engine.ingestRefund({shopId:'preview-shop',orderId:value.orderId||'preview-order',refundId:'preview-'+Date.now(),status:'pending'},{simulation:true});return changed();});
    await window.loadFile(path.join(root,'src/renderer/index.html'));
    await window.webContents.executeJavaScript(`document.title='拼多多自动发货助手 · 界面测试版';document.querySelector('.brand span').textContent='界面测试版';document.querySelector('.top-caption').textContent='仅使用本地虚构数据，不连接店铺；正式版继续接待。';void 0;`);
    if(process.argv.includes('--capture')){
      const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      for(const [owner,key]of [['settings','runtime'],['products','delivery'],['replies','strategy'],['settings','alerts']]){
        await window.webContents.executeJavaScript(`document.querySelector('[data-nav="${owner}"]').click();void 0;`);await wait(100);
        await window.webContents.executeJavaScript(`document.querySelector('[data-section="${key}"]').click();void 0;`);await wait(150);
        fs.writeFileSync(path.join(directory,`${owner}-${key}.png`),(await window.webContents.capturePage()).toPNG());
      }
      await window.webContents.executeJavaScript(`document.querySelector('[data-nav="settings"]').click();void 0;`);
    }
    window.show();
    console.log(JSON.stringify({ok:true,mode:'ui-preview',directory,actualPlatformWrites:0,externalRequestsAllowed:false}));
  }).catch(error=>{console.error(error);app.exit(1);});
  app.on('window-all-closed',()=>app.quit());
}
