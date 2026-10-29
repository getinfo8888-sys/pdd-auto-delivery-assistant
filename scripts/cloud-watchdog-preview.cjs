'use strict';
// Independent sample runner: no merchant pages, production state or phone keys.
const {app,BrowserWindow,ipcMain,net,safeStorage,session}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const {CloudWatchdog}=require('../src/core/cloud-watchdog.cjs');
const root=path.resolve(__dirname,'..'),directory=path.join(root,'work','cloud-watchdog-preview');
app.setName('pdd-assistant-cloud-preview');
app.setAppUserModelId('local.linkfulfillment.workbench.cloud-preview');
app.setPath('userData',path.join(directory,'browser-data'));
if(!app.requestSingleInstanceLock())app.quit();
else{
  let window,client,timer,mode='paused';
  const sample=()=>({wanted:mode!=='paused',healthy:mode==='healthy',online:mode!=='offline',reason:mode==='login'?'login':'offline'});
  const snapshot=()=>({sampleMode:mode,...client.snapshot()});
  const changed=()=>{if(window&&!window.isDestroyed())window.webContents.send('preview:changed');};
  const tick=async force=>{if(mode!=='offline')await client.observe(sample(),force);};
  app.on('second-instance',()=>{window?.show();window?.focus();});
  app.whenReady().then(async()=>{
    fs.mkdirSync(directory,{recursive:true});
    // The renderer itself cannot connect to any remote resource.
    session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(_details,done)=>done({cancel:true}));
    const transportSession=session.fromPath(path.join(directory,'transport'),{cache:false});
    client=new CloudWatchdog({directory,crypto:safeStorage,changed,fetchImpl:(...args)=>transportSession.fetch(...args)});
    if(process.argv.includes('--provision-test')&&!client.snapshot().configured){
      const manifest=JSON.parse(fs.readFileSync(path.join(root,'work/cloud-watchdog-deployment.json'),'utf8'));
      const testSecrets=JSON.parse(fs.readFileSync(path.join(root,'work/cloud-watchdog-secrets.json'),'utf8'));
      client.update({enabled:true,url:manifest.url,token:testSecrets.HEARTBEAT_TOKEN});
    }
    window=new BrowserWindow({width:960,height:840,minWidth:800,minHeight:650,title:'拼多多助手 · 云端监护测试版',icon:path.join(root,'src/renderer/icon.ico'),autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'cloud-watchdog/preview-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());
    const handle=(name,action)=>ipcMain.handle('cloud-preview:'+name,async(event,value)=>{if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw Error('无效的测试请求');return action(value);});
    handle('snapshot',snapshot);
    handle('save',value=>{client.update({...value,enabled:true});changed();return snapshot();});
    handle('mode',async value=>{if(!['healthy','login','offline','paused'].includes(value))throw Error('无效的样本');if(client.busy)throw Error('上一条心跳尚未结束，请稍后再试');mode=value;await tick(true);changed();return snapshot();});
    handle('disable',async()=>{mode='paused';await client.disable();changed();return snapshot();});
    await window.loadFile(path.join(__dirname,'cloud-watchdog/preview.html'));
    timer=setInterval(()=>{void tick(false);},5000);
    console.log(JSON.stringify({ok:true,mode:'cloud-watchdog-preview',directory,actualPlatformWrites:0,productionDataAccess:false}));
    if(process.argv.includes('--capture')){await tick(true);await new Promise(resolve=>setTimeout(resolve,250));fs.writeFileSync(path.join(directory,'preview.png'),(await window.webContents.capturePage()).toPNG());}
    if(process.argv.includes('--test-loss')){
      const assert=require('node:assert/strict'),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      const manifest=JSON.parse(fs.readFileSync(path.join(root,'work/cloud-watchdog-deployment.json'),'utf8'));
      const secrets=JSON.parse(fs.readFileSync(path.join(root,'work/cloud-watchdog-secrets.json'),'utf8'));
      const readRemote=async()=>{const response=await transportSession.fetch(manifest.url+'/v1/status',{headers:{authorization:'Bearer '+secrets.ADMIN_TOKEN},signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error('无法核验云端状态');return response.json();};
      const choose=async value=>{await window.webContents.executeJavaScript(`document.querySelector('[data-mode="${value}"]').click();void 0;`);const deadline=Date.now()+15000;while(client.busy||mode!==value){if(Date.now()>deadline)throw Error('样本切换超时');await wait(100);}await wait(100);};
      await choose('healthy');assert.equal(client.snapshot().status,'connected','the real Electron transport must obtain a cloud receipt');
      await choose('offline');const began=Date.now();console.log('Cloud loss simulation started; real PC networking and production assistant remain untouched.');
      let remote;
      try{
        const deadline=Date.now()+150000;
        while(Date.now()<deadline){await wait(10000);remote=await readRemote();if(remote.incident?.status==='accepted')break;if(['failed','uncertain'].includes(remote.incident?.status)){fs.writeFileSync(path.join(directory,'loss-test-failure.json'),JSON.stringify({at:Date.now(),incident:remote.incident},null,2));throw Error('云端通知未取得服务受理回执');}}
        assert.equal(remote?.incident?.status,'accepted');assert.ok(remote.incident.receiptId);assert.equal(remote.incident.attempts,1);
        const result={ok:true,kind:'independent-cloud-loss-test',observedAfterMs:Date.now()-began,notificationStatus:'accepted',receiptId:remote.incident.receiptId,attempts:remote.incident.attempts,actualPlatformWrites:0,productionDataAccess:false,realNetworkDisabled:false};
        fs.writeFileSync(path.join(directory,'loss-test-result.json'),JSON.stringify(result,null,2));
        console.log(JSON.stringify(result));
        await window.webContents.executeJavaScript(`document.getElementById('incident').textContent='本次失联测试：推送服务已受理一次，请核对手机微信';void 0;`);
      }finally{
        mode='paused';await tick(true);assert.equal(client.snapshot().status,'paused','cloud must acknowledge disarm after testing');
        const final=await readRemote();assert.equal(final.armed,false);
        console.log('Test cloud monitor disarmed with receipt; no further test notifications scheduled.');
      }
    }
  }).catch(error=>{console.error(error.message);app.exit(1);});
  app.on('before-quit',()=>{clearInterval(timer);client?.dispose();});
  app.on('window-all-closed',()=>app.quit());
}
