'use strict';
const fs=require('node:fs');const path=require('node:path');const {app}=require('electron');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function readConversation(wc,seed) {
    const expression=`(async function(seed){
      const root=document.querySelector('#app')?.__vue__;const store=root?.$store;
      if(!store?.state?.userInfo?.uid)throw Error('Official session initializing');
      let api;const probe='local_pending_audit_'+Date.now();webpackJsonp.push([[],{[probe]:(_m,_e,require)=>{api=require.c?.[325]?.exports?.default;}},[[probe]]]);
      if(typeof api?.getLatestUserConversation!=='function')throw Error('Official read API unavailable');
      const entries=[...store.state.chatList,store.state.currentUserInfo].filter(row=>String(row?.userInfo?.uid)===seed.buyerId);
      const raw=[...new Map(entries.flatMap(row=>[...(row.messageList||[]),row.lastMessage].filter(Boolean)).map(row=>[String(row.msg_id),row])).values()];
      const projection=row=>({sameAsCancelledSource:String(row.msg_id)===seed.messageId,
        direction:row.from?.role==='user'?'incoming':row.from?.role==='mall_cs'?'outgoing':String(row.from?.role),
        merchantMatches:String(row.from?.uid)===String(store.state.userInfo.uid),sentAt:Number(row.ts)*1000,
        contentLength:typeof row.content==='string'?row.content.length:null,type:row.type,subType:row.sub_type,
        history:row.is_history===true,hasOwnReceipt:seed.ownMessageIds.includes(String(row.msg_id)),
        sameAsConfiguredReply:seed.replyTexts.includes(row.content),keys:Object.keys(row),
        scalarFlags:Object.fromEntries(Object.keys(row).filter(key=>/aut|robot|reply|status|type|hint|result/i.test(key)&&['boolean','number','string'].includes(typeof row[key])).map(key=>[key,typeof row[key]==='string'?row[key].slice(0,120):row[key]])),
        fromMetadata:row.from?{role:row.from.role,user_type:row.from.user_type,keys:Object.keys(row.from)}:null,
        infoFlags:row.info&&typeof row.info==='object'?Object.fromEntries(Object.entries(row.info).filter(([key,value])=>/aut|robot|reply|status|type|hint/i.test(key)&&['boolean','number','string'].includes(typeof value))):{},
        infoKeys:row.info&&typeof row.info==='object'?Object.keys(row.info):[]});
      const latest=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Latest conversation read timeout')),12000);api.getLatestUserConversation(seed.buyerId,value=>{clearTimeout(timeout);resolve(value);});});
      const history=await new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(Error('History read timeout')),12000),original=api.send;
        api.send=function(packet,callback,...rest){if(packet.cmd==='list')return original.call(this,packet,value=>{clearTimeout(timeout);resolve(value);},...rest);return original.call(this,packet,callback,...rest);};
        try{api.list({user_sn:seed.buyerId,size:30,notUpdateUnreplyTs:true});}catch(error){clearTimeout(timeout);reject(error);}finally{api.send=original;}
      });
      const historyRows=Array.isArray(history.messages)?history.messages:Array.isArray(history.conversations)?history.conversations:Array.isArray(history.list)?history.list:[];
      const axios=root.$axios;let pending;
      if(typeof axios?.post==='function')try{const value=await axios.post('/plateau/chat/unreply_conversations',{page:1,size:100});const rows=value.conversations||[];pending={scanned:rows.length,hasMore:value.has_more,target:rows.filter(row=>String(row.from?.uid)===seed.buyerId||String(row.to?.uid)===seed.buyerId).map(row=>({...projection(row),lastUnreplyTime:row.last_unreply_time}))};}catch(error){pending={error:error.message};}
      return {ready:true,conversationCopies:entries.length,userInfoKeys:entries[0]?.userInfo?Object.keys(entries[0].userInfo):[],loadedMessageMetadata:raw.map(projection).sort((a,b)=>a.sentAt-b.sentAt),history:{keys:Object.keys(history),result:history.result,hasMore:!!history.has_more,rows:historyRows.map(projection).sort((a,b)=>a.sentAt-b.sentAt)},pending,latest:{result:latest.result,hasConversation:!!latest.conversation,lastUnreplyTime:latest.conversation?.last_unreply_time,message:latest.conversation?projection(latest.conversation):null},officialSocket:globalThis.__localWorkbenchPddSocket?.status(String(store.state.userInfo.uid))};
    })(${JSON.stringify(seed)})`;
    return wc.executeJavaScript(expression);
}
async function run({window,ensureView,engine}) {
  const report={ok:false,actualPlatformWrites:0,sendFunctionsInvoked:0};
  const rejectedAudit=process.argv.includes('--audit-rejected');
  try {
    const snapshot=await window.webContents.executeJavaScript("window.workbench.call('snapshot')");
    if(snapshot.readOnly!==true)throw Error('Read-only mode required');
    const targetArg=process.argv.find(value=>value.startsWith('--audit-job='));
    const state=engine.snapshot(),job=state.jobs.findLast(job=>targetArg?job.id===targetArg.slice('--audit-job='.length):rejectedAudit?job.reason==='operation_rejected'&&job.detail?.includes('请勿重复发送相同消息'):job.reason==='manual_intervention');
    if(!job)throw Error('No cancelled reply to inspect');
    const wc=ensureView('chat').webContents;
    const seed={buyerId:job.buyerId,messageId:job.messageId,createdAt:job.createdAt,
      ownMessageIds:state.jobs.filter(job=>job.sentMessageId).map(job=>job.sentMessageId),
      replyTexts:[state.config.greeting,state.config.fallback,...state.config.replyRules.map(rule=>rule.content),...state.jobs.filter(row=>row.buyerId===job.buyerId).map(row=>row.content)]};
    const deadline=Date.now()+40000;let result;
    while(Date.now()<deadline){try{result=await readConversation(wc,seed);break;}catch(error){report.lastIssue=error.message;await wait(500);}}
    if(!result)throw Error(report.lastIssue||'Official page did not become ready');
    Object.assign(report,result,{ok:true,cancelledJobCreatedAt:job.createdAt,targetJobId:job.id,cancelledReason:job.reason});
    if(process.argv.includes('--audit-robot-fix')){
      const {makeBridgeScript}=require('../src/platform/pdd-bridge.cjs');
      const check=await wc.executeJavaScript(makeBridgeScript('reply-check',{expectedShopId:job.shopId,buyerId:job.buyerId}));
      const pending=await wc.executeJavaScript(makeBridgeScript('unreplied',{expectedShopId:job.shopId,page:1}));
      report.fixedBridge={ready:check.ready,pending:check.pending,sameSource:check.message?.messageId===job.messageId,robotEvidenceVerified:check.message?.officialAutoReplyPending?.historyVerified===true,pendingListContainsSource:pending.messages?.some(row=>row.messageId===job.messageId),reason:check.reason};
      if(check.ready&&check.pending&&check.message?.messageId===job.messageId){
        const folder=path.resolve(__dirname,'..','work','pending-audit');fs.mkdirSync(folder,{recursive:true});
        const previewFile=path.join(folder,'robot-preview-state.json');fs.writeFileSync(previewFile,JSON.stringify(state));
        // snapshot excludes private ledgers; use the shadow engine's own file.
        const original=path.join(app.getPath('appData'),'LinkDeliveryWorkbench','state.json');fs.copyFileSync(original,previewFile);
        const {Engine}=require('../src/core/engine.cjs');const preview=new Engine({filePath:previewFile,sendMessage:async()=>{throw Error('Read-only preview cannot send');}});preview.setRunning(true);
        const recovery=preview.recoverUnrepliedMessage(check.message);
        report.fixedRecovery={status:recovery.status,originalCancellationLinked:recovery.job?.officialAutoReplyRecoveryJobId===job.id,requiresFinalVerification:recovery.job?.needsReplyVerification===true};
      }
    }
  }catch(error){report.error=error.message;}
  finally{const folder=path.resolve(__dirname,'..','work',rejectedAudit?'rejected-audit':'pending-audit');fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'readonly-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,error:report.error,targetJobId:report.targetJobId,loaded:report.loadedMessageMetadata?.length,history:report.history?.rows?.length,pendingTarget:report.pending?.target?.length}));app.quit();}
}
module.exports={run,readConversation};
