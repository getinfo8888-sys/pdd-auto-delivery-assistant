'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run({app,window,ensureView,bridge,engine,checkBridge}) {
  const directory=path.resolve(__dirname,'..','work','platform-readonly');fs.mkdirSync(directory,{recursive:true});
  const wc=ensureView('orders').webContents;
  let health;
  for(let i=0;i<6;i++) {await wait(3000);health=await bridge('orders','health');if(health.ready)break;}
  const summary={readOnly:true,chatWebsocketOpened:false,running:engine.snapshot().config.running,health,actualWrites:0};
  if(health.ready) {
    const orders=await bridge('orders','waiting',{page:1});
    summary.orders={ready:orders.ready,reason:orders.reason,total:orders.total,loaded:orders.orders?.length,eligible:orders.orders?.filter(row=>row.eligible).length};
    if(process.argv.includes('--delivery-audit')) {
      summary.projectedWaiting=orders.orders;
      summary.orderVariants=await wc.executeJavaScript(`(async()=>{
        const now=Math.floor(Date.now()/1000),result=[];
        for(const [orderType,afterSaleType] of [[1,1],[1,-1],[0,-1]]){
          const data=await globalThis.__mms.fetch.post('/mangkhut/mms/recentOrderList',{orderType,afterSaleType,pageNumber:1,pageSize:50,groupStartTime:now-90*86400,groupEndTime:now,remarkStatus:-1,sortType:7,urgeShippingStatus:-1});
          result.push({orderType,afterSaleType,total:data.totalItemNum,rows:(data.pageItems||[]).slice(0,8).map(row=>({keys:Object.keys(row),order_sn:row.order_sn,goods_id:row.goods_id,goods_name:row.goods_name,spec:row.spec,order_status:row.order_status,order_status_str:row.order_status_str,pay_status:row.pay_status,group_status:row.group_status,shipping_status:row.shipping_status,after_sales_status:row.after_sales_status,after_sales_id:row.after_sales_id,no_need_ship:row.no_need_ship,virtualDeliverySubType:row.virtualDeliverySubType,hasUid:!!row.uid,pay_time:row.pay_time}))});
        }return result;
      })()`);
    }
    const refunds=await bridge('orders','refunds',{page:1});
    summary.refunds={ready:refunds.ready,reason:refunds.reason,total:refunds.total,loaded:refunds.refunds?.length,pending:refunds.refunds?.filter(row=>row.status==='pending').length};
    const existing=await wc.executeJavaScript(`(async()=>{const now=Math.floor(Date.now()/1000);const data=await globalThis.__mms.fetch.post('/mangkhut/mms/recentOrderList',{orderType:0,afterSaleType:-1,pageNumber:1,pageSize:50,groupStartTime:now-90*86400,groupEndTime:now,remarkStatus:-1,sortType:7,urgeShippingStatus:-1});return Array.isArray(data?.pageItems)?data.pageItems.slice(0,3).map(row=>String(row.order_sn)):[];})()`);
    summary.existingOrderChecks=[];
    for(const orderId of existing) {
      const result=await bridge('orders','order',{orderId});
      summary.existingOrderChecks.push({ready:result.ready===true,reason:result.reason,orderIdentityMatches:result.order?.orderId===orderId,buyerResolved:!!result.order?.buyerId,titlePresent:!!result.order?.title,skuPresent:!!result.order?.sku,shipped:result.order?.shipped,eligible:result.order?.eligible});
    }
    if(process.argv.includes('--delivery-audit')){
      const delivered=engine.snapshot().jobs.findLast(job=>job.type==='delivery'&&job.status==='sent'&&!job.simulation);
      if(delivered){
        await checkBridge();summary.chatWebsocketOpened=true;
        const current=await bridge('orders','order',{orderId:delivered.orderId});
        const claimedMessageIds=engine.snapshot().jobs.filter(job=>job.id!==delivered.id&&job.shopId===delivered.shopId&&job.buyerId===delivered.buyerId&&job.sentMessageId).map(job=>job.sentMessageId).slice(-500);
        const message=await bridge('chat','delivery-check',{job:delivered,claimedMessageIds});
        summary.deliveredOrderReadBack={orderId:delivered.orderId,ready:current.ready,shipped:current.order?.shipped,eligible:current.order?.eligible,refunded:current.order?.refunded,buyerMatches:current.order?.buyerId===delivered.buyerId,officialMessageConfirmed:message.status==='confirmed',sameMessageId:message.messageId===delivered.sentMessageId,messageStatus:message.status,messageReason:message.reason};
      }
    }
    // Fetch the HTML/static source of the official aftersales page through the
    // existing session. No page script executes and no business write is made.
    if (process.argv.includes('--capture-official-sources')) {
    const response=await wc.session.fetch('https://mms.pinduoduo.com/aftersales-ssr/list');
    const html=await response.text();
    fs.writeFileSync(path.join(directory,'aftersales.html'),html);
    summary.aftersalesHtml={status:response.status,path:response.url ? new URL(response.url).pathname : null,sha256:createHash('sha256').update(html).digest('hex')};
    const sources=[...html.matchAll(/<script[^>]+src=["']([^"']+)/g)].map(match=>new URL(match[1],response.url || 'https://mms.pinduoduo.com/aftersales-ssr/list')).filter(url=>['mms.pinduoduo.com','mms-static.pddpic.com'].includes(url.hostname));
    const manifest=[];
    for (let i=0;i<sources.length && i<30;i++) {
      const url=sources[i];
      if(!/\.js$/.test(url.pathname))continue;
      const result=await wc.session.fetch(url.href);if(!result.ok)continue;
      const bytes=Buffer.from(await result.arrayBuffer());const filename=i+'-'+path.basename(url.pathname);
      fs.writeFileSync(path.join(directory,filename),bytes);
      manifest.push({file:filename,url:url.origin+url.pathname,sha256:createHash('sha256').update(bytes).digest('hex')});
    }
    fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2));
    summary.staticSourceCount=manifest.length;
    }
  }
  fs.writeFileSync(path.join(directory,'summary.json'),JSON.stringify(summary,null,2));
  console.log(JSON.stringify(summary));
  app.quit();
}
module.exports={run};
