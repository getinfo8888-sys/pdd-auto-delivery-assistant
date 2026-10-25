'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function run({app,engine,ensureView,bridge,startupListener,networkRefresh,observeNetwork,productionStateFile}){
  const report={ok:false,version:app.getVersion(),startedAt:new Date().toISOString(),actualPlatformWrites:0,businessWritesLocked:true,networkScope:'this application merchant partition only',phases:[]};
  const before=sha(productionStateFile);let partition;
  const restoreNetwork=()=>{if(partition){partition.webRequest.onBeforeRequest(null);partition.enableNetworkEmulation({offline:false});}};
  const until=async(check,timeout,label)=>{const end=Date.now()+timeout;while(Date.now()<end){
    const phase=startupListener.state.phase;if(report.phases.at(-1)?.phase!==phase)report.phases.push({phase,at:new Date().toISOString()});
    if(await check())return;await wait(250);
  }throw Error('Timeout: '+label+'; '+(startupListener.state.message||''));};
  try{
    observeNetwork(true);
    startupListener.arm(engine.snapshot().config);
    await until(()=>engine.snapshot().config.running,90000,'initial official connection');
    const health=await bridge('chat','health');report.before={ready:health.ready,canSendViaSocket:health.canSendViaSocket,socketState:health.socketState};
    if(!health.ready||!health.canSendViaSocket)throw Error('Official sending connection is not ready');
    const wc=ensureView('chat').webContents;partition=wc.session;
    report.pageEvents=[];
    for(const kind of ['chat','orders'])for(const name of ['did-start-loading','did-stop-loading','did-finish-load','will-prevent-unload'])ensureView(kind).webContents.on(name,()=>{if(report.pageEvents.length<80)report.pageEvents.push({kind,event:name,at:new Date().toISOString()});});
    wc.on('did-fail-load',(_event,code,description,_url,mainFrame)=>{if(mainFrame&&report.pageEvents.length<20)report.pageEvents.push({code,description,at:new Date().toISOString()});});
    // Also reject requests in this partition: Chromium's native emulation did
    // not reliably fail this cached merchant page in the initial diagnostic.
    // The explicit gate makes the simulated transport failure observable.
    report.blockedRequests=0;
    partition.webRequest.onBeforeRequest({urls:['<all_urls>']},(_details,callback)=>{report.blockedRequests++;callback({cancel:true});});
    partition.enableNetworkEmulation({offline:true});await partition.closeAllConnections();wc.reloadIgnoringCache();
    observeNetwork(false);
    await wait(2500);
    report.offlinePage={loading:wc.isLoading(),path:new URL(wc.getURL()).pathname};
    report.offlinePageSignals=await Promise.race([wc.executeJavaScript(`({online:navigator.onLine,readyState:document.readyState,hasUnloadHandler:typeof window.onbeforeunload==='function'})`),wait(2000).then(()=>({readTimedOut:true}))]);
    console.log(JSON.stringify({diagnostic:'offline-applied',page:report.offlinePage,signals:report.offlinePageSignals,events:report.pageEvents}));
    await until(()=>!engine.snapshot().config.running&&startupListener.state.pending,55000,'failed page triggers automatic recovery');
    report.offlineObserved=report.blockedRequests>0&&report.pageEvents.some(row=>row.code&&row.code!==-3);if(!report.offlineObserved)throw Error('No failed network request was observed');await wait(2000);
    const restoredAt=Date.now();restoreNetwork();observeNetwork(true);
    await until(()=>networkRefresh.state.phase==='complete'&&engine.snapshot().config.running,75000,'network recovery refreshes both pages and resumes listening without Start');
    const after=await bridge('chat','health');report.after={ready:after.ready,canSendViaSocket:after.canSendViaSocket,socketState:after.socketState};
    report.networkRestoreToListeningMs=Date.now()-restoredAt;
    report.pageRefresh=networkRefresh.state;
    report.pagesLoadedAfterRestoration=['chat','orders'].filter(kind=>report.pageEvents.some(row=>row.kind===kind&&row.event==='did-finish-load'&&Date.parse(row.at)>=restoredAt));
    report.productionStateUnchanged=sha(productionStateFile)===before;
    report.ok=!!after.ready&&!!after.canSendViaSocket&&report.productionStateUnchanged&&report.pagesLoadedAfterRestoration.length===2;
  }catch(error){report.error=error.message;report.productionStateUnchanged=sha(productionStateFile)===before;}
  finally{
    restoreNetwork();networkRefresh.dispose();startupListener.stop();
    const out=path.resolve(__dirname,'..','work');fs.writeFileSync(path.join(out,'network-readonly-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(!report.ok)process.exitCode=1;app.quit();
  }
}
module.exports={run};
