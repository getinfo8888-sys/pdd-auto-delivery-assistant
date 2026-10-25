'use strict';
const fs=require('node:fs');const path=require('node:path');const {app}=require('electron');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run({window,ensureView}){
  const snapshot=await window.webContents.executeJavaScript(`window.workbench.call('snapshot')`);if(!snapshot.readOnly)throw Error('Read-only mode required');
  const wc=ensureView('chat').webContents,report={ok:false,actualPlatformWrites:0,connections:[],frames:[]};
  const listener=(_e,method,params)=>{
    if(method==='Network.webSocketCreated'){const url=new URL(params.url);report.connections.push({host:url.hostname,path:url.pathname.replace(/[0-9]{5,}|[a-f0-9]{24,}/gi,'[id]')});}
    if(['Network.webSocketFrameSent','Network.webSocketFrameReceived'].includes(method)&&report.frames.length<10){const frame=params.response,row={direction:method.endsWith('Sent')?'outgoing':'incoming',opcode:frame.opcode,length:frame.payloadData?.length};if(frame.opcode===1){try{const value=JSON.parse(frame.payloadData);row.json=true;row.keys=Object.keys(value).slice(0,15);if(value.response==='auth')row.authentication={fieldType:typeof value.auth,authenticated:value.auth===true,resultOk:value.result==='ok'};if(['heartbeat','ping','pong','send_message','latest_conversations'].includes(value.cmd))row.command=value.cmd;if(['heartbeat','ping','pong','send_message','latest_conversations'].includes(value.response))row.response=value.response;}catch{row.json=false;}}report.frames.push(row);}
  };
  try{wc.debugger.attach('1.3');wc.debugger.on('message',listener);await wc.debugger.sendCommand('Network.enable');const deadline=Date.now()+20000;while(Date.now()<deadline){if(report.connections.length&&report.frames.length>=2)break;await wait(300);}report.ok=true;}
  catch(error){report.error=error.message;}
  finally{wc.debugger.removeListener('message',listener);try{wc.debugger.detach();}catch{}fs.writeFileSync(path.resolve(__dirname,'..','work','send-audit','socket-metadata.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.quit();}
}
module.exports={run};
