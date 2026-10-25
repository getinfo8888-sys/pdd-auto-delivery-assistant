'use strict';
const fs=require('node:fs');const path=require('node:path');const {createHash}=require('node:crypto');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Developer-only passive observation of our own official WebContents. Keep no
// frames, request bodies, headers, URLs, buyer IDs or credentials in the report.
async function run({app,engine,ensureView,startupListener,bridge}) {
  const startedAt=Date.now();const report={ok:false,startedAt,rawFramesStored:false,headersRead:false,webSocketFramesObserved:0,httpBodiesObserved:0,matchingPayloads:[]};
  const view=ensureView('chat'),wc=view.webContents;
  const check=(payload,transport,opcode)=>{
    if(typeof payload!=='string'||payload.length>4*1024*1024)return;
    let bytes;
    try{bytes=transport==='websocket'&&opcode===2?Buffer.from(payload,'base64'):Buffer.from(payload);}catch{return;}
    for(const job of engine.snapshot().jobs.filter(job=>job.type==='reply'&&job.status==='sending'&&job.createdAt>=startedAt&&typeof job.wireContent==='string')) {
      const plain=Buffer.from(job.wireContent,'utf8'),escaped=Buffer.from(JSON.stringify(job.wireContent).slice(1,-1),'utf8');
      const match=bytes.includes(plain)||bytes.includes(escaped);
      if(match&&!report.matchingPayloads.some(row=>row.sha256===job.wireContentSha256))report.matchingPayloads.push({transport,sha256:createHash('sha256').update(job.wireContent).digest('hex'),length:job.wireContent.length,suffixLength:job.wireContent.length-job.content.length,exactPersistedPayloadFound:true});
    }
  };
  const listener=(_event,method,params)=>{
    if(method==='Network.webSocketFrameSent'){report.webSocketFramesObserved++;check(params.response?.payloadData,'websocket',params.response?.opcode);}
    if(method==='Network.requestWillBeSent'&&typeof params.request?.postData==='string'){report.httpBodiesObserved++;check(params.request.postData,'http');}
  };
  try {
    wc.debugger.attach('1.3');wc.debugger.on('message',listener);await wc.debugger.sendCommand('Network.enable');
    report.observerAttachedBeforeAutomaticStart=true;
    startupListener.arm(engine.snapshot().config);
    if(process.argv.includes('--retry-rejected')) {
      const readyUntil=Date.now()+45000;while(!engine.snapshot().config.running&&Date.now()<readyUntil)await wait(250);
      if(!engine.snapshot().config.running)throw Error('Automatic listening did not connect');
      const old=engine.snapshot().jobs.findLast(job=>job.status==='blocked'&&job.reason==='operation_rejected'&&job.detail?.includes('请勿重复发送相同消息'));
      if(!old)throw Error('No explicitly rejected reply');
      const check=await bridge('chat','reply-check',{buyerId:old.buyerId});
      if(!check.ready||!check.pending||check.message?.messageId!==old.messageId)throw Error('The same inquiry is no longer officially pending');
      const retry=engine.recoverUnrepliedMessage(check.message,{retryRejectedJobId:old.id});
      if(retry.status!=='created'&&retry.status!=='queued')throw Error('Retry not created: '+retry.status);
      report.explicitlyAuthorizedRetry=true;
    }
    const deadline=Date.now()+55000;let jobs=[];
    while(Date.now()<deadline){jobs=engine.snapshot().jobs.filter(job=>job.catchUp&&job.createdAt>=startedAt);if(jobs.length&&jobs.every(job=>['sent','blocked','cancelled','uncertain'].includes(job.status)))break;await wait(250);}
    report.jobs=jobs.map(job=>({status:job.status,reason:job.reason,suffixMode:job.replySuffixApplied,wireLength:job.wireContent?.length,wireSha256:job.wireContentSha256,officialArgumentSha256:job.outbound?.sha256,officialArgumentMatches:job.outbound?.sha256===job.wireContentSha256,hasPlatformReceipt:!!job.sentMessageId,rejection:job.detail?.includes('请勿重复发送相同消息')?'duplicate_message':job.detail?'other_error':null}));
    report.automaticListeningStarted=engine.snapshot().config.running;report.newCatchUpAttempts=jobs.length;report.ok=jobs.length===1&&report.jobs[0].officialArgumentMatches;
  }catch(error){report.error=error.message;}
  finally {
    wc.debugger.removeListener('message',listener);try{wc.debugger.detach();}catch{}
    const out=path.resolve(__dirname,'..','work','send-audit');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'live-wire-proof.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.quit();
  }
}
module.exports={run};
