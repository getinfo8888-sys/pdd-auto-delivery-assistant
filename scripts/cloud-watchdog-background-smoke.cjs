'use strict';
// Uses a separate Electron profile, fixture credentials and no external network.
const {app,BrowserWindow,session}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {CloudWatchdog}=require('../src/core/cloud-watchdog.cjs');
const directory=path.resolve(__dirname,'../work/cloud-background-smoke-'+Date.now());
app.setName('pdd-cloud-background-smoke');app.setAppUserModelId('local.pdd.cloud.background-smoke');app.setPath('userData',path.join(directory,'browser'));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let timer,client;
app.whenReady().then(async()=>{
  let externalRequests=0;
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(_details,done)=>{externalRequests++;done({cancel:true});});
  const win=new BrowserWindow({width:520,height:240,show:true,title:'云端监护后台隔离验证',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<h2>云端监护后台隔离验证</h2><p>不连接店铺；仅检查最小化和托盘隐藏期间的心跳。</p>'));
  const calls=[];
  client=new CloudWatchdog({directory,crypto:{isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from(s),decryptString:b=>b.toString()},fetchImpl:async(_url,options)=>{
    const beat=JSON.parse(options.body);calls.push({at:Date.now(),minimized:win.isMinimized(),visible:win.isVisible()});
    return Response.json({ok:true,version:1,acceptedSeq:beat.seq,armed:beat.mode!=='paused',pushConfigured:true});
  }});
  client.update({enabled:true,url:'https://fixture.example.workers.dev',token:'fixture-background-heartbeat-00000000'});
  const observe=()=>client.observe({wanted:true,healthy:true});await observe();timer=setInterval(observe,5000);
  win.minimize();await wait(35000);assert.equal(win.isMinimized(),true);assert.ok(calls.filter(c=>c.minimized).length>=2,'Heartbeat did not continue while minimized');
  win.hide();await wait(35000);assert.ok(calls.filter(c=>!c.visible).length>=4,'Heartbeat did not continue while hidden');
  const maximumGap=Math.max(...calls.slice(1).map((c,i)=>c.at-calls[i].at));assert.ok(maximumGap<30000,'Background heartbeat stalled');assert.equal(externalRequests,0);
  const result={ok:true,actualPlatformWrites:0,externalRequests,heartbeats:calls.length,maximumGapMs:maximumGap,minimized:true,hidden:true,productionDataAccess:false};
  fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));clearInterval(timer);client.dispose();app.quit();
}).catch(error=>{clearInterval(timer);client?.dispose();console.error(error);app.exit(1);});
