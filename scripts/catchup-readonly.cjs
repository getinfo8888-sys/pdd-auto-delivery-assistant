'use strict';
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');const {createHash}=require('node:crypto');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run({app,window,engine,ensureView,bridge,startListening,shadowFile}) {
  const out=path.resolve(__dirname,'..','work');const file=path.join(app.getPath('appData'),'LinkDeliveryWorkbench','state.json');
  const hash=()=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');const before=hash();
  const report={ok:false,readOnly:true,actualPlatformWrites:0,originalStateUnchanged:false,shadowStateUsed:path.resolve(file)!==path.resolve(shadowFile)};
  const evaluate=code=>window.webContents.executeJavaScript(code);
  try {
    assert.equal(report.shadowStateUsed,true);
    engine.updateConfig({...engine.snapshot().config,autoReplyEnabled:true,catchUpUnrepliedEnabled:true});
    const jobsBefore=engine.snapshot().jobs.length;
    await startListening();
    const deadline=Date.now()+60000;
    let state;
    while(Date.now()<deadline){state=await evaluate(`window.workbench.call('snapshot')`);if(state.catchUp.phase==='complete')break;if(state.catchUp.phase==='retrying')throw Error(state.catchUp.message);await wait(300);}
    assert.equal(state.catchUp.phase,'complete');report.scan=state.catchUp;
    const pending=await bridge('chat','unreplied',{page:1});
    report.firstPage={ready:pending.ready,scanned:pending.scanned,eligible:pending.messages?.length,hasMore:pending.hasMore};
    const history=await bridge('chat','unreplied-history',{page:1});assert.equal(history.ready,true,history.reason);
    report.historyPage={ready:history.ready,scanned:history.scanned,eligible:history.messages.length,hasMore:history.hasMore};
    const samples=[...new Map([...(pending.messages||[]),...history.messages].map(message=>[message.buyerId,message])).values()].slice(0,5);
    const {Engine}=require('../src/core/engine.cjs');const previewFile=path.join(path.dirname(shadowFile),'catchup-preview.json');
    fs.copyFileSync(shadowFile,previewFile);
    const previewEngine=new Engine({filePath:previewFile,sendMessage:async()=>{throw Error('Preview cannot send');}});
    previewEngine.setRunning(true);report.previewStatuses={};
    for(const message of samples){const result=previewEngine.recoverUnrepliedMessage(message);report.previewStatuses[result.status]=(report.previewStatuses[result.status]||0)+1;}
    report.preflight=[];
    for(const message of samples) {
      const check=await bridge('chat','reply-check',{buyerId:message.buyerId});
      assert.equal(check.ready,true,check.reason);report.preflight.push({ready:check.ready,stillPending:check.pending,sameSource:check.message?.messageId===message.messageId});
    }
    report.oldRejectedStillPending=(pending.messages||[]).filter(message=>engine.snapshot().jobs.some(job=>job.type==='reply'&&job.status==='blocked'&&job.reason==='operation_rejected'&&job.shopId===message.shopId&&job.buyerId===message.buyerId&&job.messageId===message.messageId)).length;
    assert.equal(engine.snapshot().jobs.length,jobsBefore);report.noNewJobs=true;
    await assert.rejects(bridge('chat','send',{allowWrite:true}),/只读联调/);
    report.writeGuardVerified=true;report.ok=true;
  } catch(error) {
    report.error=error.message;
    try {const view=ensureView('chat');report.page=await view.webContents.executeJavaScript(`(()=>{const text=document.body?.innerText||'';return {pathname:location.pathname,title:document.title,signals:['滑块','安全验证','账户在别处登录','扫码登录'].filter(word=>text.includes(word))};})()`);}catch{}
  } finally {
    report.originalStateUnchanged=hash()===before;
    fs.writeFileSync(path.join(out,'catchup-readonly-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.quit();
  }
}
module.exports={run};
