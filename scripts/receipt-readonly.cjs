'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run({app,engine,ensureView,bridge}){
  assert.equal(engine.snapshot().config.running,false);
  const wc=ensureView('chat').webContents;let health;
  for(let i=0;i<25;i++){await wait(1000);try{health=await bridge('chat','health');}catch{}if(health?.ready&&health.canSendViaSocket&&health.canUseOfficialReceiptPipeline)break;}
  const samples=[];
  for(const job of engine.snapshot().jobs.filter(job=>!job.simulation&&!job.parentJobId&&job.status==='sent'&&['reply','delivery'].includes(job.type)&&job.sentMessageId).slice(-6)){
    const pending=await bridge('chat','reply-check',{buyerId:job.buyerId,expectedShopId:health.shopId});
    const ui=await wc.executeJavaScript(`(()=>{const roots=Array.from(document.querySelectorAll('#app,body>*')).map(el=>el.__vue__).filter(Boolean),queue=[...roots],seen=new Set();while(queue.length&&seen.size<1200){const vm=queue.shift();if(!vm||seen.has(vm))continue;seen.add(vm);const rows=vm.$store?.state?.chatList;if(Array.isArray(rows)){const row=rows.find(row=>String(row.userInfo?.uid)===${JSON.stringify(job.buyerId)});return {visibleRow:!!row,waiting:!!row?.unReplyTs,hasReceipt:!!row?.messageList?.some(message=>String(message.msg_id)===${JSON.stringify(job.sentMessageId)})};}queue.push(...(vm.$children||[]));}return {visibleRow:false,waiting:false,hasReceipt:false};})()`);
    samples.push({type:job.type,readReady:pending.ready===true,serverPending:pending.pending===true,sameSource:pending.ready===true&&pending.pending===true&&!!job.messageId&&pending.message?.messageId===job.messageId,ui});
  }
  const report={ok:!!health?.ready&&!!health.canSendViaSocket&&!!health.canUseOfficialReceiptPipeline&&samples.every(row=>row.readReady),version:app.getVersion(),at:new Date().toISOString(),actualPlatformWrites:0,businessWritesLocked:true,officialSocketReady:health?.canSendViaSocket===true,officialReceiptPipelineReady:health?.canUseOfficialReceiptPipeline===true,samples};
  fs.writeFileSync(path.resolve(__dirname,'../work/receipt-readonly-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));app.quit();
}
module.exports={run};
