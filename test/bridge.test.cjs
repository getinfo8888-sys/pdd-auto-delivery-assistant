'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {makeBridgeScript}=require('../src/platform/pdd-bridge.cjs');

function fixture(options={}) {
  const calls=[];
  let refundState=options.refundState ?? 1;
  const row={order_sn:'order-1',goods_id:'goods-1',goods_name:'示例商品',spec:'网盘版',order_status:1,pay_status:2,group_status:1,shipping_status:0,after_sales_status:0,uid:'123',...options.order};
  const detail=()=>({id:'refund-1',orderSn:'order-1',afterSalesType:1,afterSalesStatus:refundState,version:8,uid:'123',...options.refund});
  const request={post:async(path,body)=>{
    calls.push({path,body});
    if (path==='/plateau/chat/unreply_conversations') return options.pendingList ?? {conversations:[],has_more:false};
    if (path==='/mangkhut/mms/recentOrderList') {calls.push({query:body});return {pageItems:[row],totalItemNum:1};}
    if (path==='/robot/shop/orders/shipping/single') {calls.push({ship:body});return options.shipResult || {orderShipResultList:[{orderSn:'order-1',shippingResultCode:100}]};}
    if (path.endsWith('/queryList')) return options.badList?{success:true}:{list:[{...detail(),goodsName:'游戏'}],total:1};
    if (path.endsWith('/queryDetail')) return detail();
    if (path.endsWith('/agreeRefund')) { if(options.refundError) throw options.refundError; refundState=4; return {success:true}; }
    throw Error('unexpected endpoint');
  },get:async()=>({uid:'123'})};
  const userInfo={mall_id:'shop-1',uid:'merchant-1'};
  Object.defineProperty(userInfo,'access_token',{get(){throw Error('Credentials must not be read');}});
  const waiting={userInfo:{uid:'123'},unReplyTs:1710000000,messageList:[]};
  const root={$store:{state:{userInfo,chatList:[waiting]}},$axios:request,$children:[]};
  const sdk={sendCmdMsg:async packet=>{calls.push({httpSend:true});return {response:'send_message',result:'ok',msg_id:'10001',request_id:packet.request_id};}};
  root.$store.state.IMSDK=sdk;
  const cache={325:{exports:{default:{sendMsg:args=>{
    calls.push({send:args.uid,content:args.content,type:args.type,config:args.config,info:args.info});
    if(options.send) return options.send(args);
    return cache[325].exports.default.send({cmd:'send_message',request_id:'fixture-request',message:{to:{uid:args.uid},content:args.content,type:args.type,...(args.config || {}),info:args.info}},args.cb);
  },send:(packet,cb)=>{
    if (packet.cmd==='list') {
      calls.push({listRead:packet});
      if(options.listError)throw options.listError;
      if(options.listTimeout)return;
      cb(options.conversationHistory ?? {result:'ok',messages:[]});return;
    }
    calls.push({officialSend:true});packet.anti_content='fixture-official-risk';
    return Promise.resolve(root.$store.state.IMSDK.sendCmdMsg(packet)).then(response=>{
      calls.push({officialReceiptHandled:true,result:response.result});
      if(response.result==='ok'&&!options.keepWaitingAfterReceipt)waiting.unReplyTs=0;
      cb(response);
    });
  },list:args=>{
    calls.push({listArgs:args});
    return cache[325].exports.default.send({cmd:'list',request_id:'fixture-list',list:{with:{role:'user',id:args.user_sn},size:args.size},notUpdateUnreplyTs:args.notUpdateUnreplyTs});
  },getLatestUserConversation:(uid,cb)=>{calls.push({latest:uid});cb(options.latest ?? {result:'ok',uid,conversation:null});},getLatestConversation:args=>{calls.push({history:args});args.cb(options.history ?? {result:'ok',conversations:[],has_more:false});}}}},jXcw:{exports:{a:{virtualShipping:async body=>{
    calls.push({ship:body});return options.shipResult || {orderShipResultList:[{orderSn:'order-1',shippingResultCode:100}]};
  }}}},syB7:{exports:{e:async body=>{calls.push({query:body});return {pageItems:[row],totalItemNum:1};},m:async()=>({uid:'123'})}}};
  cache[211]={exports:{default:{uploadImage:async input=>{
    calls.push({chatUpload:true,rawImage:input.rawImage});
    if(options.chatUploadError)throw options.chatUploadError;
    return options.chatUploadResult || {url:options.uploadUrl || 'https://img.pddpic.com/fixture/qr.png'};
  }}}};
  if (options.noUploadModule) delete cache[211];
  const chunks=[];
  chunks.push=function(chunk){const probe=Object.keys(chunk[1])[0];chunk[1][probe]({}, {}, {c:cache});};
  const context={crypto:require('node:crypto').webcrypto,TextEncoder,URL,File,atob,__mms:{fetch:request},document:{querySelector:()=>({__vue__:root}),querySelectorAll:()=>[],body:{innerText:''}},location:{origin:'https://mms.pinduoduo.com',pathname:options.kind==='orders'?'/orders/list':'/chat-merchant/index.html'},webpackJsonp:chunks,webpackJsonp_mfns_orders:chunks,__localDeliveryRunNonce:7,Date,Math,setTimeout:(fn)=>setTimeout(fn,30),clearTimeout};
  context.baseUtil={uploadPictureHost:()=>options.uploadHost || 'https://file.yangkeduo.com',getUploadImageSignature:async()=>{calls.push({uploadPermission:true});return 'transient-fixture-signature';},uploadImage:async input=>{calls.push({uploadImage:true,name:input.rawImage.name,mime:input.rawImage.type,size:input.rawImage.size});return {url:options.uploadUrl || 'https://img.pddpic.com/fixture/qr.png'};}};
  context.browserType='web';context.__localWorkbenchPddSocket={status:()=>({ready:!options.socketNotReady}),sendPacket:async packet=>{calls.push({socketSend:true,content:packet.message.content,type:packet.message.type,size:packet.message.size,info:packet.message.info,antiContent:packet.anti_content});return {response:'send_message',result:'ok',msg_id:'10001',request_id:packet.request_id};}};
  const api=cache[325].exports.default, originalSend=api.send;
  if (options.noCache) delete cache[325];
  if(options.noSdk)delete root.$store.state.IMSDK;
  const run=async(action,payload={})=>JSON.parse(JSON.stringify(await vm.runInNewContext(makeBridgeScript(action,{expectedShopId:'shop-1',...payload}),context)));
  return {run,calls,api,originalSend,sdk,originalSdkSend:sdk.sendCmdMsg,waiting};
}
const job={shopId:'shop-1',buyerId:'123',orderId:'order-1',refundId:'refund-1',content:'指定内容'};
const write={job,allowWrite:true,runNonce:7};
const media={id:'a'.repeat(64),url:'https://img.pddpic.com/test/qr.png',shopId:'shop-1',name:'二维码.png',mime:'image/png',width:256,height:256,bytes:1024,uploadedAt:Date.now()};
const imageJob={...job,type:'delivery',parentJobId:'parent',partKind:'image',content:media.url,image:media,deliveryWireContent:media.url,deliveryWireContentSha256:require('node:crypto').createHash('sha256').update(media.url).digest('hex')};
test('image selection uses the official chat uploader with a data URL instead of generic multipart upload',async()=>{
 const f=fixture(),result=await f.run('image-upload',{allowAssetUpload:true,image:{name:'二维码.png',mime:'image/png',base64:Buffer.from('fixture-image').toString('base64')}});
 assert.deepEqual(result,{status:'uploaded',url:'https://img.pddpic.com/fixture/qr.png',uploadRoute:'official-chat-media-v1'});
 assert.equal(f.calls.filter(row=>row.uploadPermission || row.uploadImage).length,0);assert.equal(f.calls.filter(row=>row.chatUpload).length,1);
 assert.equal(f.calls.find(row=>row.chatUpload).rawImage,'data:image/png;base64,'+Buffer.from('fixture-image').toString('base64'));
 assert.equal(f.calls.some(row=>row.send||row.socketSend||row.httpSend),false);assert.equal(JSON.stringify(result).includes('signature'),false);
});
test('image uploads require authorization, matching shop and the official chat module',async()=>{
 const base={allowAssetUpload:true,image:{name:'x.png',mime:'image/png',base64:'aGVsbG8='}};
 for(const patch of [{allowAssetUpload:false},{expectedShopId:'other'},{image:{...base.image,mime:'image/svg+xml'}}]){const f=fixture();assert.notEqual((await f.run('image-upload',{...base,...patch})).status,'uploaded');assert.equal(f.calls.length,0);}
 const f=fixture({noUploadModule:true});assert.notEqual((await f.run('image-upload',base)).status,'uploaded');assert.equal(f.calls.length,0);
 assert.notEqual((await fixture({uploadUrl:'https://pddpic.com.evil.test/x'}).run('image-upload',base)).status,'uploaded');
});
test('chat upload failures distinguish permission from transfer and retain HTTP and platform codes',async()=>{
 const payload={allowAssetUpload:true,image:{name:'x.jpg',mime:'image/jpeg',base64:'aGVsbG8='}};
 const permission=await fixture({chatUploadResult:{type:'get_upload_sign_failed',error_code:403,error_msg:'上传许可被拒'}}).run('image-upload',payload);
 assert.equal(permission.stage,'chat-upload-permission');assert.equal(permission.platformCode,403);
 const transfer=await fixture({chatUploadResult:{type:'upload_image_failed',status:403,res:{error_code:48001,error_msg:'图片上传不成功'}}}).run('image-upload',payload);
 assert.equal(transfer.httpStatus,403);assert.equal(transfer.platformCode,48001);assert.equal(transfer.stage,'chat-image-upload');
 const thrown=await fixture({chatUploadError:{response:{status:403,data:{error_code:123,error_msg:'上传失败'}},message:'Request failed'}}).run('image-upload',payload);
 assert.equal(thrown.status,'rejected');assert.equal(thrown.httpStatus,403);assert.equal(thrown.platformCode,123);
});
test('the official chat-image CDN is accepted for upload and actual image messages',async()=>{
 const url='https://chat-img.pddugc.com/fixture/qr.jpg',f=fixture({uploadUrl:url});
 const result=await f.run('image-upload',{allowAssetUpload:true,image:{name:'qr.jpg',mime:'image/jpeg',base64:'aGVsbG8='}});assert.equal(result.status,'uploaded');
 const message={...imageJob,content:url,deliveryWireContent:url,image:{...media,url},deliveryWireContentSha256:require('node:crypto').createHash('sha256').update(url).digest('hex')};
 assert.equal((await f.run('send',{job:message,allowWrite:true,runNonce:7})).status,'confirmed');
});
test('images use the official type 1 packet, original CDN URL, dimensions and authenticated socket',async()=>{
 const f=fixture(),result=await f.run('send',{job:imageJob,allowWrite:true,runNonce:7,imagePreview:'data:image/png;base64,aGVsbG8='});
 assert.equal(result.status,'confirmed');const sent=f.calls.find(row=>row.socketSend);assert.equal(sent.type,1);assert.equal(sent.content,media.url);assert.deepEqual(JSON.parse(JSON.stringify(sent.size)),{width:256,height:256,image_size:1});assert.equal(sent.info.thumb_data,'data:image/png;base64,aGVsbG8=');
 assert.equal(f.calls.some(row=>row.httpSend),false);
});
test('mismatched image identity or altered pure URL is rejected before socket submission',async()=>{
 for(const patch of [{image:{...media,shopId:'other'}},{content:'https://evil.test/x',deliveryWireContent:'https://evil.test/x'},
 {deliveryWireContent:media.url+'  ',deliveryWireContentSha256:require('node:crypto').createHash('sha256').update(media.url+'  ').digest('hex')}]){
  const f=fixture(),result=await f.run('send',{job:{...imageJob,...patch},allowWrite:true,runNonce:7});assert.equal(result.status,'rejected');assert.equal(f.calls.some(row=>row.socketSend),false);
 }
});
test('image history matches type and both participants; duplicate retry can reuse a confirmed earlier bubble',async()=>{
 const attemptedAt=Date.now()-120000,ts=Math.floor(attemptedAt/1000)-10;
 const picture={msg_id:'80001',from:{role:'mall_cs',uid:'merchant-1'},to:{role:'user',uid:'123'},ts,type:1,content:media.url};
 const f=fixture({conversationHistory:{result:'ok',messages:[picture]}});
 assert.equal((await f.run('attachment-check',{job:{...imageJob,attemptedAt},allowPrevious:true})).messageId,'80001');
 assert.equal((await f.run('attachment-check',{job:{...imageJob,attemptedAt}})).status,'not_sent');
 assert.equal((await fixture({conversationHistory:{result:'ok',messages:[{...picture,type:0}]}}).run('attachment-check',{job:{...imageJob,attemptedAt},allowPrevious:true})).status,'not_found');
 assert.equal((await fixture({conversationHistory:{result:'ok',messages:[{...picture,to:{role:'user',uid:'other'}}]}}).run('attachment-check',{job:{...imageJob,attemptedAt},allowPrevious:true})).ready,false);
});
test('an explicit attachment rejection does not renew the uncertain-write waiting window on every preflight',async()=>{
 const f=fixture(),retrying={...imageJob,attachmentRetryCount:1,attemptedAt:Date.now()};
 const lookup=await f.run('attachment-check',{job:retrying,allowPrevious:true});
 assert.equal(lookup.status,'not_found');assert.equal(lookup.ready,true);
 const uncertain=await f.run('attachment-check',{job:retrying});assert.equal(uncertain.status,'unknown');
 assert.equal(f.calls.some(row=>row.socketSend||row.httpSend),false);
});
const pendingRow=(extra={})=>({msg_id:'old-message',from:{uid:'123',role:'user'},to:{uid:'merchant-1',role:'mall_cs'},type:0,sub_type:0,content:'试玩',ts:Math.floor(Date.now()/1000)-60,last_unreply_time:Math.floor(Date.now()/1000)-60,...extra});
test('dedicated unreplied paging projects pending buyer text and excludes answered, system and old messages',async()=>{
  const rows=[pendingRow(),pendingRow({last_unreply_time:0}),pendingRow({from:{role:'mall_cs',uid:'merchant-1'}}),pendingRow({sub_type:1}),pendingRow({no_unreply_hint:true}),pendingRow({ts:Math.floor(Date.now()/1000)-8*86400})];
  const {run,calls}=fixture({pendingList:{conversations:rows,has_more:true}});const result=await run('unreplied',{page:2});assert.equal(result.ready,true);assert.equal(result.messages.length,1);assert.equal(result.messages[0].messageId,'old-message');assert.equal(result.hasMore,true);assert.deepEqual(JSON.parse(JSON.stringify(calls[0].body)),{page:2,size:100});
  assert.equal((await fixture({pendingList:{conversations:[]}}).run('unreplied')).ready,false);
});
test('the latest per-buyer query is read-only and rejects a different identity',async()=>{
  const pending=fixture({latest:{result:'ok',uid:'123',conversation:pendingRow()}});assert.equal((await pending.run('reply-check',{buyerId:'123'})).pending,true);assert.equal(pending.calls.length,1);assert.equal(pending.calls[0].latest,'123');
  assert.equal((await fixture().run('reply-check',{buyerId:'123'})).pending,false);
  assert.equal((await fixture({latest:{result:'ok',uid:'other',conversation:pendingRow()}}).run('reply-check',{buyerId:'123'})).ready,false);
  const noTime=pendingRow();delete noTime.last_unreply_time;assert.equal((await fixture({latest:{result:'ok',uid:'123',conversation:noTime}}).run('reply-check',{buyerId:'123'})).pending,true);
});

const followupQuery={buyerId:'123',sourceMessageId:'source-question',ownReplyMessageIds:['10001']};
const historySource=(extra={})=>pendingRow({msg_id:'source-question',...extra});
const historyWelcome=(extra={})=>pendingRow({msg_id:'10001',from:{uid:'merchant-1',role:'mall_cs'},to:{uid:'123',role:'user'},...extra});
const officialAuto=(extra={})=>historyWelcome({msg_id:'30003',show_auto:true,need_reply:1,is_aut:0,...extra});

test('an official automatic reply that still needs a reply resolves to the exact buyer inquiry',async()=>{
  const auto=officialAuto(),source=historySource({ts:auto.ts});
  const f=fixture({latest:{result:'ok',uid:'123',conversation:auto},conversationHistory:{result:'ok',messages:[auto,source]}});
  const check=await f.run('reply-check',{buyerId:'123'});
  assert.equal(check.ready,true);assert.equal(check.pending,true);assert.equal(check.message.messageId,source.msg_id);
  assert.deepEqual(check.message.officialAutoReplyPending,{automaticMessageId:auto.msg_id,sourceMessageId:source.msg_id,pendingSince:auto.last_unreply_time*1000,historyVerified:true});
  assert.equal(f.calls.some(row=>row.send||row.httpSend||row.socketSend),false);
  assert.equal(f.api.send,f.originalSend);
});

test('both pending lists recover the buyer message behind an official automatic last message',async()=>{
  for(const action of ['unreplied','unreplied-history']){
    const auto=officialAuto(),source=historySource();
    const page={conversations:[auto],has_more:false,result:'ok'};
    const f=fixture({pendingList:page,history:page,conversationHistory:{result:'ok',messages:[auto,source]}});
    const result=await f.run(action,{page:1});
    assert.equal(result.ready,true);assert.equal(result.messages.length,1);assert.equal(result.messages[0].messageId,source.msg_id);
  }
});

const platformWaitHint=(extra={})=>pendingRow({msg_id:'wait-notice',type:51,no_unreply_hint:1,content:'等待提醒（隔离样本）',ts:Math.floor(Date.now()/1000),...extra});
test('every officially pending buyer message type gets a verified default recovery key',async()=>{
  for(const type of [1,7,8,42,999])for(const action of ['unreplied','unreplied-history','reply-check']){
    const marker=pendingRow({msg_id:'withdrawn-or-nontext',type,content:'',ts:Math.floor(Date.now()/1000)});
    const page={result:'ok',conversations:[marker],has_more:false};
    const f=fixture({pendingList:page,history:page,latest:{result:'ok',uid:'123',conversation:marker},conversationHistory:{result:'ok',messages:[marker,historyWelcome({ts:marker.last_unreply_time-10})]}});
    const result=await f.run(action,{buyerId:'123'}),message=action==='reply-check'?result.message:result.messages[0];
    assert.equal(result.ready,true);assert.ok(message);assert.equal(message.text,'');
    assert.equal(message.messageId,'official-pending:'+JSON.stringify([marker.msg_id,marker.last_unreply_time*1000]));
    assert.deepEqual(message.officialPendingFallback,{markerMessageId:marker.msg_id,pendingSince:marker.last_unreply_time*1000,historyVerified:true});
    assert.equal(f.calls.some(row=>row.send||row.socketSend||row.httpSend),false);
    assert.equal(f.calls.find(row=>row.listArgs).listArgs.notUpdateUnreplyTs,true);
  }
});
test('a pending card without usable text also uses the default, while a human reply wins',async()=>{
  const marker=pendingRow({sub_type:1,content:'试玩（卡片说明，不是买家文字）'});
  const pending=await fixture({latest:{result:'ok',uid:'123',conversation:marker},conversationHistory:{result:'ok',messages:[marker]}}).run('reply-check',{buyerId:'123'});
  assert.equal(pending.pending,true);assert.equal(pending.message.text,'');
  const manual=historyWelcome({ts:marker.ts+1});
  const answered=await fixture({latest:{result:'ok',uid:'123',conversation:marker},conversationHistory:{result:'ok',messages:[manual,marker]}}).run('reply-check',{buyerId:'123'});
  assert.equal(answered.pending,false);
});
test('a withdrawn message represented by the official type-31 notice recovers without reusing its old text',async()=>{
  const marker=pendingRow({msg_id:'withdrawn-original-id',type:31,content:'试玩（撤回前残留，不应用于匹配）',info:{mall_content:'对方撤回了一条消息'},ts:Math.floor(Date.now()/1000)});
  const oldReply=historyWelcome({ts:marker.last_unreply_time-10});
  const page={result:'ok',conversations:[marker],has_more:false};
  for(const action of ['unreplied','unreplied-history','reply-check']){
    const f=fixture({pendingList:page,history:page,latest:{result:'ok',uid:'123',conversation:marker},conversationHistory:{result:'ok',messages:[marker,oldReply]}});
    const result=await f.run(action,{buyerId:'123'}),message=action==='reply-check'?result.message:result.messages[0];
    assert.equal(result.ready,true);assert.ok(message.officialPendingFallback);assert.equal(message.text,'');
    assert.equal(f.calls.some(row=>row.send||row.socketSend||row.httpSend),false);
  }
  const onlyMarker=await fixture({latest:{result:'ok',uid:'123',conversation:marker},conversationHistory:{result:'ok',messages:[marker]}}).run('reply-check',{buyerId:'123'});
  assert.equal(onlyMarker.pending,true);assert.ok(onlyMarker.message.officialPendingFallback);
});
test('cleared, foreign and missing pending markers cannot create default replies',async()=>{
  const marker=pendingRow({type:999});
  for(const patch of [{last_unreply_time:0},{from:{uid:'123',role:'user',user_type:6}},{chat_type:'conciliation'}]){
    const f=fixture({latest:{result:'ok',uid:'123',conversation:{...marker,...patch}}});
    assert.equal((await f.run('reply-check',{buyerId:'123'})).pending,false);
  }
  for(const messages of [[],[{...marker,to:{uid:'foreign',role:'mall_cs'}}],[{...marker,type:1}]]){
    const f=fixture({latest:{result:'ok',uid:'123',conversation:marker},conversationHistory:{result:'ok',messages}});
    assert.equal((await f.run('reply-check',{buyerId:'123'})).ready,false);
  }
});
test('one unresolved pending history does not hide other buyers and remains visible for retry',async()=>{
  const marker=pendingRow({type:999}),other=pendingRow({msg_id:'another-source',from:{uid:'456',role:'user'}});
  for(const action of ['unreplied','unreplied-history']){
    const page={result:'ok',conversations:[marker,other],has_more:false};
    const f=fixture({pendingList:page,history:page,conversationHistory:{result:'ok',messages:[]}});
    const result=await f.run(action);
    assert.equal(result.ready,true);assert.equal(result.messages[0].buyerId,'456');assert.equal(result.deferred.length,1);
    assert.match(result.deferred[0].reason,/待回复标记/);
  }
});
test('a latest nontext event without a wait timestamp is rechecked against the official pending list',async()=>{
  const marker=pendingRow({type:999}),latest={...marker};delete latest.last_unreply_time;
  const f=fixture({latest:{result:'ok',uid:'123',conversation:latest},pendingList:{conversations:[marker],has_more:false},conversationHistory:{result:'ok',messages:[marker]}});
  const result=await f.run('reply-check',{buyerId:'123'});
  assert.equal(result.pending,true);assert.ok(result.message.officialPendingFallback);
  assert.equal(f.calls.some(row=>row.path==='/plateau/chat/unreply_conversations'),true);
  const answered=await fixture({latest:{result:'ok',uid:'123',conversation:latest},pendingList:{conversations:[],has_more:false}}).run('reply-check',{buyerId:'123'});
  assert.equal(answered.pending,false);
});
test('pending scans and preflight recover the real inquiry hidden behind a platform wait notice',async()=>{
  for(const action of ['unreplied','unreplied-history','reply-check']){
    const notice=platformWaitHint(),source=historySource({ts:notice.last_unreply_time,content:'https://example.test/goods/demo'});
    const context=historySource({msg_id:'goods-context',type:41,no_unreply_hint:1,ts:notice.ts});
    const warning=historyWelcome({msg_id:'platform-warning',type:31,no_unreply_hint:1,ts:source.ts});
    const page={result:'ok',conversations:[notice],has_more:false};
    const f=fixture({pendingList:page,history:page,latest:{result:'ok',uid:'123',conversation:notice},conversationHistory:{result:'ok',messages:[context,notice,warning,source]}});
    const result=await f.run(action,{page:1,buyerId:'123'}),message=action==='reply-check'?result.message:result.messages[0];
    assert.equal(result.ready,true);assert.ok(message);assert.equal(message.messageId,source.msg_id);assert.equal(message.text,source.content);
    assert.deepEqual(message.platformHintPending,{hintMessageId:notice.msg_id,sourceMessageId:source.msg_id,pendingSince:notice.last_unreply_time*1000,historyVerified:true});
    assert.equal(f.calls.some(row=>row.send||row.httpSend||row.socketSend),false);assert.equal(f.api.send,f.originalSend);
    assert.equal(f.calls.find(row=>row.listArgs).listArgs.notUpdateUnreplyTs,true);
  }
});

test('platform notices cannot override a later real reply or a cleared pending marker',async()=>{
  const notice=platformWaitHint(),source=historySource({ts:notice.last_unreply_time});
  const manual=historyWelcome({msg_id:'human-answer',ts:notice.ts+1});
  const answered=fixture({latest:{result:'ok',uid:'123',conversation:notice},conversationHistory:{result:'ok',messages:[manual,notice,source]}});
  assert.equal((await answered.run('reply-check',{buyerId:'123'})).pending,false);
  const cleared=fixture({latest:{result:'ok',uid:'123',conversation:{...notice,last_unreply_time:0}}});
  assert.equal((await cleared.run('reply-check',{buyerId:'123'})).pending,false);assert.equal(cleared.calls.some(row=>row.listRead),false);
});

test('missing or mismatched platform-notice history is deferred rather than declared answered',async()=>{
  const notice=platformWaitHint(),source=historySource({ts:notice.last_unreply_time});
  for(const messages of [[],[source],[{...notice,to:{uid:'another-merchant',role:'mall_cs'}},source]]){
    const f=fixture({latest:{result:'ok',uid:'123',conversation:notice},conversationHistory:{result:'ok',messages}});
    assert.equal((await f.run('reply-check',{buyerId:'123'})).ready,false);assert.equal(f.api.send,f.originalSend);
  }
});

test('a human reply and a cleared official pending marker still prevent an automatic reply',async()=>{
  for(const auto of [historyWelcome(),officialAuto({last_unreply_time:0}),officialAuto({need_reply:0})]){
    const f=fixture({latest:{result:'ok',uid:'123',conversation:auto},conversationHistory:{result:'ok',messages:[auto,historySource()]}});
    assert.equal((await f.run('reply-check',{buyerId:'123'})).pending,false);
    assert.equal(f.calls.some(row=>row.listRead),false);
  }
  const auto=officialAuto(),manual=historyWelcome({msg_id:'40004',manual_reply:1});
  const f=fixture({latest:{result:'ok',uid:'123',conversation:auto},conversationHistory:{result:'ok',messages:[manual,auto,historySource()]}});
  const result=await f.run('reply-check',{buyerId:'123'});assert.equal(result.ready,true);assert.equal(result.pending,false);
});

test('invalid automatic-reply history is deferred rather than declaring the buyer answered',async()=>{
  const auto=officialAuto();
  for(const history of [{result:'fail',messages:[]},{result:'ok',messages:[]},
    {result:'ok',messages:[officialAuto({to:{uid:'another',role:'user'}}),historySource()]}]){
    const f=fixture({latest:{result:'ok',uid:'123',conversation:auto},conversationHistory:history});
    const result=await f.run('reply-check',{buyerId:'123'});assert.equal(result.ready,false);assert.equal(f.api.send,f.originalSend);
  }
  const stale=fixture({latest:{result:'ok',uid:'123',conversation:auto},conversationHistory:{result:'ok',messages:[auto,historySource({ts:auto.ts-1000})]}});
  const pending=await stale.run('reply-check',{buyerId:'123'});
  assert.equal(pending.pending,true);assert.equal(pending.message.text,'');assert.ok(pending.message.officialPendingFallback);
});

test('official automatic bubbles do not count as human intervention in an own follow-up',async()=>{
  const f=fixture({conversationHistory:{result:'ok',messages:[officialAuto(),historyWelcome(),historySource()]}});
  assert.equal((await f.run('reply-followup-check',followupQuery)).allowFollowup,true);
});

test('a confirmed own welcome permits its same-source follow-up using a read-only 20-row request',async()=>{
  const f=fixture({conversationHistory:{result:'ok',messages:[historyWelcome(),historySource()]}});
  const result=await f.run('reply-followup-check',{...followupQuery,allowWrite:false,runNonce:0});
  assert.deepEqual(result,{ready:true,allowFollowup:true});
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find(row=>row.listArgs).listArgs)),{user_sn:'123',size:20,notUpdateUnreplyTs:true});
  assert.equal(f.calls.filter(row=>row.listRead).length,1);
  assert.equal(f.calls.some(row=>row.send||row.httpSend||row.socketSend||row.path),false);
  assert.equal(f.api.send,f.originalSend);
});

test('a latest manual reply or a newer buyer question prevents the old follow-up',async()=>{
  for(const messages of [[historyWelcome({msg_id:'20002'}),historySource()],
    [historySource({msg_id:'new-question'}),historyWelcome(),historySource()]]){
    const f=fixture({conversationHistory:{result:'ok',messages}});
    const result=await f.run('reply-followup-check',followupQuery);
    assert.equal(result.ready,true);assert.equal(result.allowFollowup,false);assert.equal(f.api.send,f.originalSend);
  }
});

test('platform hint cards cannot replace a real own receipt and do not hide a valid own welcome',async()=>{
  for(const extra of [{type:31},{type:'56'},{no_unreply_hint:1},{is_system_hint_mall:true}]){
    const hint=historyWelcome({msg_id:'30003',...extra});
    assert.equal((await fixture({conversationHistory:{result:'ok',messages:[hint,historyWelcome(),historySource()]}}).run('reply-followup-check',followupQuery)).allowFollowup,true);
    assert.equal((await fixture({conversationHistory:{result:'ok',messages:[{...hint,msg_id:'10001'},historySource()]}}).run('reply-followup-check',followupQuery)).allowFollowup,false);
    const buyerHint=historySource({msg_id:'buyer-hint',...extra});
    assert.equal((await fixture({conversationHistory:{result:'ok',messages:[buyerHint,historyWelcome(),historySource()]}}).run('reply-followup-check',followupQuery)).allowFollowup,true);
  }
});

test('history must include the exact source and keep it as the most recent effective incoming',async()=>{
  for(const messages of [[],[historyWelcome()],
    [historyWelcome(),historySource({msg_id:'new-question'}),historySource()],
    [historyWelcome(),historySource({no_unreply_hint:true})]]){
    const result=await fixture({conversationHistory:{result:'ok',messages}}).run('reply-followup-check',followupQuery);
    assert.equal(result.ready,true);assert.equal(result.allowFollowup,false);
  }
});

test('follow-up history must match both endpoints and the current merchant identity',async()=>{
  for(const extra of [{to:{uid:'other-buyer',role:'user'}},{from:{uid:'other-merchant',role:'mall_cs'}},
    {to:{uid:'123',role:'mall_cs'}}]){
    const result=await fixture({conversationHistory:{result:'ok',messages:[historyWelcome(extra),historySource()]}}).run('reply-followup-check',followupQuery);
    assert.equal(result.allowFollowup,false);
  }
  const wrongSource=historySource({to:{uid:'other-merchant',role:'mall_cs'}});
  assert.equal((await fixture({conversationHistory:{result:'ok',messages:[historyWelcome(),wrongSource]}}).run('reply-followup-check',followupQuery)).allowFollowup,false);
});

test('equal timestamps preserve server ordering rather than inferring which same-second message came last',async()=>{
  const source=historySource(),own=historyWelcome({ts:source.ts});
  assert.equal((await fixture({conversationHistory:{result:'ok',messages:[own,source]}}).run('reply-followup-check',followupQuery)).allowFollowup,true);
  assert.equal((await fixture({conversationHistory:{result:'ok',messages:[source,own]}}).run('reply-followup-check',followupQuery)).allowFollowup,false);
});

test('unknown or malformed follow-up history defers and restores the original send function',async()=>{
  for(const conversationHistory of [{result:'fail',messages:[]},{result:'ok'},
    {result:'ok',messages:{}},{result:'ok',messages:[null]},
    {result:'ok',messages:[historyWelcome({ts:'bad'}),historySource()]},
    {result:'ok',messages:[historyWelcome(),historySource(),historySource()]},
    {result:'ok',uid:'other',messages:[historyWelcome(),historySource()]},
    {result:'ok',messages:Array.from({length:21},(_,index)=>historySource({msg_id:'row-'+index}))}]){
    const f=fixture({conversationHistory});const result=await f.run('reply-followup-check',followupQuery);
    assert.equal(result.ready,false);assert.equal(result.status,'deferred');assert.equal(result.allowFollowup,false);assert.equal(f.api.send,f.originalSend);
  }
  for(const options of [{listTimeout:true},{listError:Error('offline')}]){
    const f=fixture(options);const result=await f.run('reply-followup-check',followupQuery);
    assert.equal(result.ready,false);assert.equal(result.status,'deferred');assert.equal(result.allowFollowup,false);assert.equal(f.api.send,f.originalSend);
  }
});

test('follow-up queries validate bounded real receipt IDs and the shop before any API read',async()=>{
  for(const extra of [{ownReplyMessageIds:[]},{ownReplyMessageIds:['local-job-id']},{ownReplyMessageIds:Array(21).fill('10001')},
    {ownReplyMessageIds:{}},{sourceMessageId:''},{buyerId:''},{expectedShopId:'other-shop'}]){
    const f=fixture();const result=await f.run('reply-followup-check',{...followupQuery,...extra});
    assert.equal(result.ready,false);assert.equal(result.allowFollowup,false);assert.equal(f.calls.length,0);assert.equal(f.api.send,f.originalSend);
  }
});
test('recent-conversation paging requests seven days and selects only genuinely pending messages',async()=>{
  const {run,calls}=fixture({history:{result:'ok',conversations:[pendingRow(),pendingRow({last_unreply_time:0})],has_more:true}});
  const result=await run('unreplied-history',{page:3,endTime:1800000000});assert.equal(result.ready,true);assert.equal(result.messages.length,1);assert.equal(result.hasMore,true);
  const query=calls[0].history;assert.equal(query.page,3);assert.equal(query.size,100);assert.equal(query.endTime-query.startTime,7*86400);assert.equal(calls.some(row=>row.send),false);
  assert.equal((await fixture({history:{result:'ok'}}).run('unreplied-history')).ready,false);
});
test('health checks use cached official modules without exporting or reading credentials',async()=>{
  const {run,calls}=fixture(); assert.equal((await run('health')).ready,true);assert.equal(calls.length,0);
  assert.equal((await fixture({noCache:true}).run('health')).ready,false);
});
test('delivery reconciliation finds the exact official message and respects claimed receipts and wire tags',async()=>{
  const attemptedAt=Date.now()-70000,delivered={...job,type:'delivery',attemptedAt,deliveryWireContent:job.content+'\n时间与标记'};
  const message=historyWelcome({msg_id:'80001',content:delivered.deliveryWireContent,ts:Math.floor(attemptedAt/1000)+1});
  const yes=await fixture({conversationHistory:{result:'ok',messages:[message]}}).run('delivery-check',{job:delivered});assert.equal(yes.status,'confirmed');assert.equal(yes.messageId,'80001');
  const claimed=await fixture({conversationHistory:{result:'ok',messages:[message]}}).run('delivery-check',{job:delivered,claimedMessageIds:['80001']});assert.equal(claimed.status,'not_sent');
});
test('delivery reconciliation waits for synchronization and requires history covering the attempted send',async()=>{
  const now=Date.now(),fresh={...job,type:'delivery',attemptedAt:now-1000};assert.equal((await fixture().run('delivery-check',{job:fresh})).status,'unknown');
  const old={...fresh,attemptedAt:now-70000};assert.equal((await fixture().run('delivery-check',{job:old})).status,'not_sent');
  const recent=Array.from({length:20},(_,i)=>historyWelcome({msg_id:String(81000+i),content:'other',ts:Math.floor(now/1000)-i}));
  assert.equal((await fixture({conversationHistory:{result:'ok',messages:recent}}).run('delivery-check',{job:old})).status,'unknown');
});
test('delivery reconciliation rejects a different conversation and does not guess among duplicate texts',async()=>{
  const old={...job,type:'delivery',attemptedAt:Date.now()-70000},message=historyWelcome({msg_id:'82001',content:job.content});
  const mismatch=await fixture({conversationHistory:{result:'ok',messages:[{...message,to:{uid:'other',role:'user'}}]}}).run('delivery-check',{job:old});assert.equal(mismatch.ready,false);
  const ambiguous=await fixture({conversationHistory:{result:'ok',messages:[message,{...message,msg_id:'82002'}]}}).run('delivery-check',{job:old});assert.equal(ambiguous.status,'unknown');
});
test('every write requires a running nonce and the current store',async()=>{
  for (const action of ['send','refund']) {
    const {run,calls}=fixture(); const denied=await run(action,{job,allowWrite:false,runNonce:7});
    assert.equal(denied.status,'rejected');assert.equal(calls.some(c=>c.send||c.path?.endsWith('/agreeRefund')),false);
    assert.equal((await run(action,{...write,expectedShopId:'another-shop'})).status,'rejected');
  }
  const {run,calls}=fixture({kind:'orders'});assert.equal((await run('ship',{...write,runNonce:0})).status,'rejected');assert.equal(calls.some(c=>c.ship),false);
});
test('the send callback must be a real official success with a stable server message ID',async()=>{
  const {run}=fixture();assert.equal((await run('send',write)).messageId,'10001');
  for (const response of [{result:'my_push',msg_id:'77'},{result:'ok',msg_id:Infinity},{result:'ok'}]) {
    const {run}=fixture({send:args=>args.cb(response)});assert.equal((await run('send',write)).status,'uncertain');
  }
  assert.equal((await fixture({send:args=>args.cb({result:'fail',error:'rejected'})}).run('send',write)).status,'rejected');
});
test('the official message function receives the exact persisted reply text without changing deliveries',async()=>{
  const {run,calls}=fixture();const wireContent=job.content+' \u200b\u200c\u200d';
  const wireContentSha256=require('node:crypto').createHash('sha256').update(wireContent).digest('hex');
  const response=await run('send',{...write,job:{...job,type:'reply',wireContent,wireContentSha256}});assert.equal(response.status,'confirmed');assert.equal(response.outbound.sha256,wireContentSha256);
  assert.equal(calls.find(row=>row.send).content,wireContent);
  assert.equal(calls.some(row=>row.httpSend),false);assert.equal(calls.find(row=>row.socketSend).content,wireContent);
  const delivery=fixture();await delivery.run('send',{...write,job:{...job,type:'delivery',wireContent}});
  assert.equal(delivery.calls.find(row=>row.send).content,job.content);
  assert.equal(delivery.calls.find(row=>row.socketSend).content,job.content);assert.equal(delivery.calls.some(row=>row.httpSend),false);
});
test('delivery waits for an authenticated official socket before it submits any message',async()=>{
  const f=fixture({socketNotReady:true}),result=await f.run('send',{...write,job:{...job,type:'delivery'}});
  assert.equal(result.status,'deferred');assert.equal(f.calls.some(row=>row.send||row.httpSend||row.socketSend),false);
});
test('confirmed socket replies go through the official send and receipt pipeline before completion',async()=>{
  const f=fixture(),result=await f.run('send',{...write,job:{...job,type:'delivery'}});
  assert.equal(result.status,'confirmed');assert.equal(result.messageId,'10001');
  assert.equal(f.calls.filter(row=>row.officialSend).length,1);assert.equal(f.calls.filter(row=>row.officialReceiptHandled).length,1);
  assert.equal(f.calls.filter(row=>row.socketSend).length,1);assert.equal(f.calls.some(row=>row.httpSend),false);
  assert.equal(f.calls.find(row=>row.socketSend).antiContent,'fixture-official-risk');
  assert.equal(f.waiting.unReplyTs,0);assert.equal(f.api.send,f.originalSend);assert.equal(f.sdk.sendCmdMsg,f.originalSdkSend);
});
test('the bridge leaves a newer pending inquiry under official receipt-handler control',async()=>{
  const f=fixture({keepWaitingAfterReceipt:true});const result=await f.run('send',{...write,job:{...job,type:'delivery'}});
  assert.equal(result.status,'confirmed');assert.equal(f.calls.some(row=>row.officialReceiptHandled),true);assert.equal(f.waiting.unReplyTs,1710000000);
});
test('a missing official receipt pipeline defers without sending or changing waiting state',async()=>{
  const f=fixture({noSdk:true}),result=await f.run('send',{...write,job:{...job,type:'delivery'}});
  assert.equal(result.status,'deferred');assert.equal(f.calls.length,0);assert.equal(f.waiting.unReplyTs,1710000000);assert.equal(f.api.send,f.originalSend);
});
test('a missing or changed reply payload is rejected before the official function is called',async()=>{
  for(const fields of [{},{wireContent:'body'},{wireContent:'body',wireContentSha256:'0'.repeat(64)}]){
    const {run,calls}=fixture();assert.equal((await run('send',{...write,job:{...job,type:'reply',...fields}})).status,'rejected');assert.equal(calls.some(call=>call.send),false);
  }
});
test('orders retain SKU and explicit payment/shipping status; unknown aftersales data is ineligible',async()=>{
  const {run}=fixture({kind:'orders'});const value=await run('waiting');assert.equal(value.orders[0].sku,'网盘版');assert.equal(value.orders[0].eligible,true);assert.equal(value.orders[0].paidAt,null);
  assert.equal((await fixture({kind:'orders',order:{after_sales_status:undefined}}).run('waiting')).orders[0].eligible,false);
});
test('two explicit null aftersale fields mean no aftersale, while incomplete or active fields remain ineligible',async()=>{
  const live=await fixture({kind:'orders',order:{after_sales_status:null,after_sales_id:null}}).run('waiting');assert.equal(live.orders[0].eligible,true);assert.equal(live.orders[0].refunded,false);
  for(const order of [{after_sales_status:null},{after_sales_status:null,after_sales_id:'active'},{after_sales_status:1,after_sales_id:'active'},{after_sales_status:undefined,after_sales_id:null}])assert.equal((await fixture({kind:'orders',order}).run('waiting')).orders[0].eligible,false);
});
test('shipping uses the official virtual shipment contract and checks the per-order result code',async()=>{
  const {run,calls}=fixture({kind:'orders'});assert.equal((await run('ship',write)).status,'confirmed');
  const sent=calls.find(c=>c.ship).ship;assert.equal(sent.functionType,6);assert.deepEqual(Array.from(sent.orderShipRequestList[0].virtualGoodesContent),['5','指定内容']);
  assert.equal((await fixture({kind:'orders',shipResult:{orderShipResultList:[{orderSn:'order-2',shippingResultCode:100}]}}).run('ship',write)).status,'uncertain');
  assert.equal((await fixture({kind:'orders',shipResult:{orderShipResultList:[{shippingResultCode:67,shippingResultMsg:'platform hold'}]}}).run('ship',write)).status,'rejected');
  const refunded=fixture({kind:'orders',order:{pay_status:3}});assert.equal((await refunded.run('ship',write)).status,'rejected');assert.equal(refunded.calls.some(c=>c.ship),false);
});
test('refund scanning validates response fields and preserves platform-processing state',async()=>{
  assert.equal((await fixture().run('refunds')).refunds[0].status,'pending');
  assert.equal((await fixture({refundState:2}).run('refunds')).refunds[0].status,'processing');
  assert.equal((await fixture({refund:{afterSalesType:2,afterSalesStatus:11}}).run('refunds')).refunds[0].status,'pending');
  assert.equal((await fixture({badList:true}).run('refunds')).ready,false);
});
test('refund approval uses the fresh application version then reads the changed state',async()=>{
  const {run,calls}=fixture();assert.equal((await run('refund',{...write,job:{...job,refundVersion:1}})).status,'confirmed');
  assert.equal(calls.find(c=>c.path?.endsWith('/agreeRefund')).body.version,8);
  assert.equal(calls.filter(c=>c.path?.endsWith('/queryDetail')).length,2);
  const completed=fixture({refundState:5});assert.equal((await completed.run('refund',write)).alreadyCompleted,true);assert.equal(completed.calls.some(c=>c.path?.endsWith('/agreeRefund')),false);
});
test('refund identity mismatches and closed applications cannot trigger a write',async()=>{
  for (const opts of [{refund:{orderSn:'other'}},{refund:{id:'other'}},{refundState:6},{refundState:2}]) {
    const {run,calls}=fixture(opts);assert.equal((await run('refund',write)).status,'rejected');assert.equal(calls.some(c=>c.path?.endsWith('/agreeRefund')),false);
  }
});
test('a lost financial response is uncertain while an explicit server rejection is rejected',async()=>{
  assert.equal((await fixture({refundError:new Error('disconnected')}).run('refund',write)).status,'uncertain');
  assert.equal((await fixture({refundError:{errorCode:2000000,message:'stale card'}}).run('refund',write)).status,'rejected');
});
