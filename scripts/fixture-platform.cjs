'use strict';
function createPlatform() {
  const data={shopId:'fixture-shop',messages:[],unreplied:[],orders:new Map(),refunds:[],actions:[]};let messageNumber=10000;
  const answeredSources=new Set(),ownReceipts=new Map();
  return {
    data,
    chat:()=>({ready:true,shopId:data.shopId,conversations:[{buyerId:'fixture-buyer',messages:structuredClone(data.messages)}]}),
    bridge:async(kind,action,payload)=>{
      if(action==='health')return {ready:true,shopId:data.shopId,kind};
      if(action==='unreplied'){const page=payload.page||1;return {ready:true,messages:structuredClone(data.unreplied.slice((page-1)*100,page*100)),scanned:Math.min(100,Math.max(0,data.unreplied.length-(page-1)*100)),hasMore:page*100<data.unreplied.length};}
      if(action==='unreplied-history')return {ready:true,messages:[],scanned:0,hasMore:false};
      if(action==='reply-check'){
        let message=data.unreplied.find(row=>row.buyerId===payload.buyerId);
        if(!message)message=data.messages.filter(row=>row.buyerId===payload.buyerId&&row.direction==='incoming'&&!row.systemHint&&!row.noUnreplyHint).sort((a,b)=>a.sentAt-b.sentAt).at(-1);
        if(message&&answeredSources.has(message.messageId))message=null;
        return {ready:true,pending:!!message,message:structuredClone(message||null)};
      }
      if(action==='reply-followup-check')return {ready:true,allowFollowup:payload.ownReplyMessageIds.some(id=>ownReceipts.get(id)?.messageId===payload.sourceMessageId&&ownReceipts.get(id)?.buyerId===payload.buyerId)};
      if(action==='waiting')return {ready:true,orders:[...data.orders.values()].filter(row=>row.eligible),total:[...data.orders.values()].filter(row=>row.eligible).length,hasMore:false};
      if(action==='order')return {ready:true,order:structuredClone(data.orders.get(payload.orderId))};
      if(action==='refunds')return {ready:true,refunds:structuredClone(data.refunds),total:data.refunds.length,hasMore:false};
      if(action==='refund-status')return {ready:true,refund:structuredClone(data.refunds.find(row=>row.refundId===payload.job.refundId))};
      const job=payload.job;
      data.actions.push({action,jobId:job.id,orderId:job.orderId,...(job.partKind?{partKind:job.partKind}:{}),content:job.type==='reply'?job.wireContent ?? job.content:job.content});
      if(action==='send'){data.unreplied=data.unreplied.filter(row=>row.buyerId!==job.buyerId);const messageId=String(++messageNumber);if(job.type==='reply'){answeredSources.add(job.messageId);ownReceipts.set(messageId,{messageId:job.messageId,buyerId:job.buyerId});}return {status:'confirmed',messageId,...(job.type==='reply'?{outbound:{sha256:require('node:crypto').createHash('sha256').update(job.wireContent).digest('hex'),length:job.wireContent.length}}:{})};}
      if(action==='ship'){Object.assign(data.orders.get(job.orderId),{shipped:true,eligible:false});return {status:'confirmed'};}
      if(action==='refund'){data.refunds.find(row=>row.refundId===job.refundId).status='approved';return {status:'confirmed'};}
      throw Error('Unexpected fixture operation: '+action);
    },
  };
}
module.exports={createPlatform};
