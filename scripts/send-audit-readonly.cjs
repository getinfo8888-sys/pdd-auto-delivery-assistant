'use strict';
const fs=require('node:fs');const path=require('node:path');const {app}=require('electron');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Developer-only source inspection. main.cjs must already be in its locked
// read-only mode. This reads cached functions and never calls a send function.
async function run({window,ensureView,engine}) {
  const out=path.resolve(__dirname,'..','work','send-audit');fs.mkdirSync(out,{recursive:true});
  const report={ok:false,actualPlatformWrites:0,sendFunctionsInvoked:0};
  try {
    const snapshot=await window.webContents.executeJavaScript(`window.workbench.call('snapshot')`);
    if(snapshot.readOnly!==true)throw Error('Send audit requires read-only mode');
    const wc=ensureView('chat').webContents;const deadline=Date.now()+45000;let result;
    while(Date.now()<deadline) {
      try {
        result=await wc.executeJavaScript(`(()=>{
          if(location.origin!=='https://mms.pinduoduo.com'||!location.pathname.startsWith('/chat-merchant/'))throw Error('Official chat is not ready');
          const chunks=globalThis.webpackJsonp;if(!Array.isArray(chunks))throw Error('Modules not ready');
          let output;const key='local_send_audit_'+Date.now();
          chunks.push([[],{[key]:(_module,_exports,require)=>{
            const api=require.c?.[325]?.exports?.default;if(typeof api?.sendMsg!=='function')throw Error('Message module not ready');
            const app=document.querySelector('#app')?.__vue__;const store=app?.$store;
            if(!store?.state?.userInfo?.mall_id)throw Error('Official logged-in store is still initializing');
            const sdk=store.state.IMSDK,implementation=sdk?.service || sdk?.c;
            output={sendFunction:Function.prototype.toString.call(api.sendMsg),sendDelegate:Function.prototype.toString.call(api.send),factory:Function.prototype.toString.call(require.m[325]),methodNames:Object.keys(api).filter(key=>typeof api[key]==='function'),browserType:window.browserType,sdkSend:typeof sdk?.sendCmdMsg==='function'?Function.prototype.toString.call(sdk.sendCmdMsg):null,sdkImplementation:typeof implementation?.sendCmdMsg==='function'?Function.prototype.toString.call(implementation.sendCmdMsg):null};
          }},[[key]]]);return output;
        })()`);
        if(result)break;
      }catch(error){report.lastIssue=error.message;}
      await wait(400);
    }
    if(!result)throw Error(report.lastIssue||'Official module did not load');
    fs.writeFileSync(path.join(out,'official-send-function.js'),result.sendFunction);
    fs.writeFileSync(path.join(out,'official-message-module.js'),result.factory);
    if(result.sdkSend)fs.writeFileSync(path.join(out,'official-sdk-send-function.js'),result.sdkSend);
    if(result.sdkImplementation)fs.writeFileSync(path.join(out,'official-sdk-send-implementation.js'),result.sdkImplementation);
    fs.writeFileSync(path.join(out,'official-send-delegate.js'),result.sendDelegate);
    report.browserType=result.browserType;report.sdkSendLength=result.sdkSend?.length;
    const routes=[],pending=new Set();
    const listener=(_event,method,params)=>{
      if(method==='Network.requestWillBeSent'&&params.request?.postData?.includes('latest_conversations')){
        const url=new URL(params.request.url),route={host:url.hostname,path:url.pathname.replace(/[0-9]{5,}|[a-f0-9]{24,}/gi,'[id]')};routes.push(route);pending.add(params.requestId);route.requestId=params.requestId;
      }
      if(method==='Network.responseReceived'&&pending.has(params.requestId)){const row=routes.find(row=>row.requestId===params.requestId);if(row)row.status=params.response.status;}
    };
    wc.debugger.attach('1.3');wc.debugger.on('message',listener);await wc.debugger.sendCommand('Network.enable');
    try {
      const evaluated=await wc.debugger.sendCommand('Runtime.evaluate',{expression:`(()=>{let fn;const key='local_send_bound_inspection_'+Date.now();webpackJsonp.push([[],{[key]:(_m,_e,require)=>{fn=require.c[325].exports.default.sendMsg;}},[[key]]]);return fn;})()`});
      let reference=evaluated.result?.objectId;
      for(let depth=0;reference&&depth<4;depth++){
        const properties=await wc.debugger.sendCommand('Runtime.getProperties',{objectId:reference,ownProperties:true});
        const target=properties.internalProperties?.find(property=>property.name==='[[TargetFunction]]')?.value?.objectId;
        if(!target)break;
        const inspected=await wc.debugger.sendCommand('Runtime.callFunctionOn',{objectId:target,functionDeclaration:'function(){return Function.prototype.toString.call(this);}',returnByValue:true});
        if(typeof inspected.result?.value==='string'){fs.writeFileSync(path.join(out,'official-send-unbound.js'),inspected.result.value);report.unboundSendFunctionLength=inspected.result.value.length;}
        reference=target;
      }
      report.readProbe=await wc.executeJavaScript(`new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Read probe timeout')),15000);const key='local_read_probe_'+Date.now();webpackJsonp.push([[],{[key]:(_m,_e,require)=>{const api=require.c[325].exports.default;api.getLatestConversation({page:1,size:1,startTime:Math.floor(Date.now()/1000)-7*86400,cb:response=>{clearTimeout(timer);resolve({result:response.result,conversationCount:response.conversations?.length});}});}},[[key]]]);})`);
      await wait(2000);
    }finally{wc.debugger.removeListener('message',listener);wc.debugger.detach();}
    report.readCommandRoutes=routes.map(({requestId,...rest})=>rest);
    report.ok=true;report.sendFunctionLength=result.sendFunction.length;report.moduleFactoryLength=result.factory.length;report.methodNames=result.methodNames;
    report.running=engine.snapshot().config.running;
  }catch(error){report.error=error.message;}
  fs.writeFileSync(path.join(out,'readonly-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.quit();
}
module.exports={run};
