'use strict';
const fs=require('node:fs');const path=require('node:path');const {readConversation}=require('./pending-reply-readonly.cjs');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Developer-only repair of one proven misclassified, never-submitted reply.
// It does not replay duplicate rejections, uncertain sends or manual closures.
async function run({app,engine,ensureView,startupListener,bridge}) {
  const startedAt=Date.now(),folder=path.resolve(__dirname,'..','work','pending-audit');fs.mkdirSync(folder,{recursive:true});
  const report={ok:false,startedAt,rawFramesStored:false,headersRead:false,recoveredAttempts:0,matchingPayloads:[]};
  const initial=engine.snapshot(),candidate=initial.jobs.findLast(job=>job.reason==='manual_intervention'&&job.status==='cancelled'&&!job.attemptedAt&&job.wireContent===undefined);
  const wc=ensureView('chat').webContents;let recoveryId;
  const listener=(_event,method,params)=>{
    if(method!=='Network.webSocketFrameSent'||typeof params.response?.payloadData!=='string')return;
    const job=engine.snapshot().jobs.find(job=>job.id===recoveryId&&job.status==='sending');if(!job?.wireContent)return;
    const frame=params.response.opcode===2?Buffer.from(params.response.payloadData,'base64'):Buffer.from(params.response.payloadData),plain=Buffer.from(job.wireContent),escaped=Buffer.from(JSON.stringify(job.wireContent).slice(1,-1));
    if((frame.includes(plain)||frame.includes(escaped))&&!report.matchingPayloads.length)report.matchingPayloads.push({transport:'websocket',sha256:job.wireContentSha256,length:job.wireContent.length,suffixLength:job.wireContent.length-job.content.length,exactPersistedPayloadFound:true});
  };
  try {
    if(!candidate)throw Error('No eligible misclassified reply');
    wc.debugger.attach('1.3');wc.debugger.on('message',listener);await wc.debugger.sendCommand('Network.enable');
    report.observerAttachedBeforeAutomaticStart=true;startupListener.arm(initial.config);
    const readyDeadline=Date.now()+45000;
    while(!engine.snapshot().config.running&&Date.now()<readyDeadline)await wait(250);
    if(!engine.snapshot().config.running)throw Error('Automatic listening did not connect');
    const check=await bridge('chat','reply-check',{buyerId:candidate.buyerId});
    if(!check.ready||!check.pending||check.message?.messageId!==candidate.messageId)throw Error('The same source is no longer officially pending');
    const evidence=await readConversation(wc,{buyerId:candidate.buyerId,messageId:candidate.messageId,ownMessageIds:initial.jobs.filter(job=>job.sentMessageId).map(job=>job.sentMessageId),replyTexts:[initial.config.greeting,initial.config.fallback]});
    if(evidence.history?.result!=='ok'||!evidence.latest?.message?.sameAsCancelledSource||!(evidence.latest.lastUnreplyTime>0))throw Error('Official read evidence is insufficient');
    const sourceTime=check.message.sentAt,rows=evidence.history.rows;
    if(evidence.history.hasMore&&(!rows.length||Math.min(...rows.map(row=>row.sentAt))>sourceTime))throw Error('History does not cover the source');
    const isNotice=row=>row.scalarFlags.no_unreply_hint===1||row.scalarFlags.no_unreply_hint===true||row.scalarFlags.is_system_hint_mall===1||row.scalarFlags.is_system_hint_mall===true||[31,56].includes(Number(row.type));
    const after=rows.filter(row=>row.direction==='outgoing'&&row.sentAt>=sourceTime);
    if(after.some(row=>!isNotice(row)))throw Error('A real merchant reply may already answer the source');
    if(!rows.some(row=>row.direction==='outgoing'&&Math.abs(row.sentAt-sourceTime)<5000&&isNotice(row)))throw Error('No matching platform notice to substantiate misclassification');
    report.review={sameSourceStillPending:true,neverSubmittedBefore:true,subsequentMerchantMessagesAreNotices:true,nearbyNoticeTypes:[...new Set(rows.filter(row=>row.direction==='outgoing'&&Math.abs(row.sentAt-sourceTime)<5000&&isNotice(row)).map(row=>row.type))]};
    const recovered=engine.recoverUnrepliedMessage(check.message,{reviewedCancellationJobId:candidate.id});
    if(recovered.status!=='created')throw Error('Reviewed recovery did not create a new reply: '+recovered.status);
    recoveryId=recovered.job.id;report.recoveredAttempts=1;
    const deadline=Date.now()+45000;let job;
    while(Date.now()<deadline){job=engine.snapshot().jobs.find(job=>job.id===recoveryId);if(['sent','blocked','cancelled','uncertain'].includes(job?.status))break;await wait(200);}
    report.result=job?{status:job.status,reason:job.reason,defaultReplyCharacters:job.content.length,wireLength:job.wireContent?.length,wireSha256:job.wireContentSha256,officialArgumentMatches:job.outbound?.sha256===job.wireContentSha256,hasPlatformReceipt:!!job.sentMessageId,rejection:job.detail?.includes('请勿重复发送相同消息')?'duplicate_message':job.detail?'other_error':null}:null;
    report.ok=report.recoveredAttempts===1&&['sent','blocked','cancelled','uncertain'].includes(job?.status);
  }catch(error){report.error=error.message;}
  finally{wc.debugger.removeListener('message',listener);try{wc.debugger.detach();}catch{}fs.writeFileSync(path.join(folder,'live-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.quit();}
}
module.exports={run};
