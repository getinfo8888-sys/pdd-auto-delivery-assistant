'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {Engine,defaults,validateConfig}=require('../src/core/engine.cjs');
const {extractLinks,validateImages,messageParts}=require('../src/core/message-parts.cjs');
const image={id:'a'.repeat(64),name:'二维码.png',url:'https://img.pddpic.com/test/qr.png',shopId:'shop',mime:'image/png',bytes:1024,width:256,height:256,uploadedAt:1792152000000};
const url='https://pan.baidu.com/s/abc123?pwd=sr2s';
function fixture(t,patch={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pdd-parts-'));
 t.after(()=>{if(path.dirname(dir)!==path.resolve(os.tmpdir())||!path.basename(dir).startsWith('pdd-parts-'))throw Error('Unsafe cleanup');fs.rmSync(dir,{recursive:true,force:true});});
 let now=1792152000000,response={status:'confirmed',messageId:'10001'};const calls=[],filePath=path.join(dir,'state.json');
 const create=()=>new Engine({filePath,now:()=>now,sendMessage:async job=>{calls.push(job);return response;},markShipped:async job=>{calls.push(job);return {status:'confirmed'};}});
 const engine=create();engine.updateConfig({...defaults,running:true,autoDeliveryEnabled:true,autoReplyEnabled:true,greetingEnabled:false,separateLinksEnabled:true,replySuffixEnabled:true,suffix:'领取说明',products:[{id:'game',name:'游戏',keywords:['游戏'],content:'领取链接：'+url,images:[image],enabled:true}],replyRules:[{id:'trial',name:'试玩',keywords:['试玩'],content:'试玩链接：'+url,images:[image],enabled:true}],...patch});
 return {engine,create,calls,respond:r=>{response=r;},advance:n=>{now=n;},event:{shopId:'shop',buyerId:'buyer',orderId:'order',itemId:'item',title:'游戏',paid:true},incoming:{shopId:'shop',buyerId:'buyer',messageId:'question',direction:'incoming',text:'试玩',sentAt:now}};
}
test('URL bubbles preserve original spelling, query and password, deduplicate and omit surrounding punctuation',()=>{
 assert.deepEqual(extractLinks('链接：'+url+' 提取码：sr2s\n再次 '+url+'。'),[url]);
 assert.deepEqual(messageParts(url,[],true),[]);
 assert.deepEqual(extractLinks('https://pan.baidu.com/s/abc\n坏链接 javascript:alert(1)'),['https://pan.baidu.com/s/abc']);
});
test('images are bounded and only accept official HTTPS hosts and validated metadata',()=>{
 assert.equal(validateImages([image])[0].url,image.url);
 assert.equal(validateImages([{...image,url:'https://chat-img.pddugc.com/fixture/qr.jpg'}])[0].url,'https://chat-img.pddugc.com/fixture/qr.jpg');
 assert.throws(()=>validateImages([{...image,url:'https://chat-img.pddugc.com.evil.test/qr.jpg'}]));
 for (const patch of [{url:'https://pddpic.com.evil.test/x'},{url:'file:///C:/secret'},{url:'http://img.pddpic.com/x'},{bytes:6*1024*1024},{width:0},{mime:'image/svg+xml'},{shopId:''}])assert.throws(()=>validateImages([{...image,...patch}]));
 assert.throws(()=>validateImages([image,image]));
 assert.equal(validateConfig({...defaults,products:[{id:'p',name:'p',keywords:['p'],content:'p',images:[image]}]}).products[0].images.length,1);
});
test('delivery persists and sends text then raw URL then image before marking shipment',async t=>{
 const f=fixture(t),parent=f.engine.ingestOrder(f.event);await f.engine.dispatch(parent.id);
 let state=f.engine.snapshot(),children=state.jobs.filter(j=>j.parentJobId===parent.id);
 assert.deepEqual(children.map(j=>j.partKind),['link','image']);assert.equal(state.jobs.some(j=>j.type==='shipment'),false);
 assert.equal((await f.engine.dispatch(children[1].id)).status,'queued');assert.equal(f.calls.length,1);
 assert.equal(f.engine.nextJob().id,children[0].id);await f.engine.dispatch(children[0].id);
 assert.equal(f.calls[1].deliveryWireContent,url);assert.equal(f.engine.snapshot().jobs.some(j=>j.type==='shipment'),false);
 await f.engine.dispatch(children[1].id);assert.equal(f.calls[2].deliveryWireContent,image.url);assert.deepEqual(f.calls[2].image,image);
 const shipment=f.engine.nextJob();assert.equal(shipment.type,'shipment');assert.deepEqual(shipment.dependencies,[parent.id,...children.map(j=>j.id)]);
 await f.engine.dispatch(shipment.id);assert.equal(f.engine.snapshot().stats.deliverySent,1);assert.equal(f.engine.snapshot().stats.shipmentSent,1);
});
test('reply parts do not inherit invisible suffixes or recursively create more messages',async t=>{
 const f=fixture(t),parent=f.engine.ingestMessage(f.incoming);await f.engine.dispatch(parent.id);
 const children=f.engine.snapshot().jobs.filter(j=>j.parentJobId===parent.id);assert.equal(children.length,2);
 for (const child of children) {await f.engine.dispatch(child.id);const wire=f.calls.at(-1);assert.equal(wire.wireContent,child.content);assert.equal(wire.replySuffixApplied,'none');}
 assert.equal(f.engine.snapshot().jobs.length,3);assert.equal(f.engine.snapshot().stats.replySent,1);
});
test('restart resumes only missing parts without resending the parent',async t=>{
 const f=fixture(t),parent=f.engine.ingestOrder(f.event);await f.engine.dispatch(parent.id);
 const child=f.engine.nextJob();await f.engine.dispatch(child.id);
 const reopened=f.create();reopened.setRunning(true);const pending=reopened.nextJob();assert.equal(pending.partKind,'image');await reopened.dispatch(pending.id);
 assert.equal(f.calls.filter(j=>!j.parentJobId&&j.type==='delivery').length,1);assert.equal(reopened.snapshot().jobs.filter(j=>j.type==='shipment').length,1);
});
test('explicit image failure retries the same part; shipment waits for its own receipt',async t=>{
 const f=fixture(t);await f.engine.dispatch(f.engine.ingestOrder(f.event).id);await f.engine.dispatch(f.engine.nextJob().id);
 const child=f.engine.nextJob();f.respond({status:'rejected',reason:'请勿重复发送相同消息'});
 const retry=await f.engine.dispatch(child.id);assert.equal(retry.status,'queued');assert.equal(retry.reason,'attachment_retry_wait');assert.equal(f.engine.nextJob(),null);
 assert.equal(f.engine.snapshot().jobs.some(j=>j.type==='shipment'),false);
 f.advance(retry.nextAttemptAt);f.respond({status:'confirmed',messageId:'10002'});await f.engine.dispatch(child.id);
 assert.equal(f.calls.at(-1).deliveryWireContent,image.url);assert.equal(f.engine.nextJob().type,'shipment');
});
test('a pure URL stays byte identical even through repeated explicit duplicate failures',async t=>{
 const f=fixture(t);await f.engine.dispatch(f.engine.ingestMessage(f.incoming).id);const child=f.engine.nextJob();
 for(let n=0;n<4;n++){f.respond({status:'rejected',reason:'请勿重复发送相同消息'});const result=await f.engine.dispatch(child.id);assert.equal(result.status,'queued');assert.equal(f.calls.at(-1).wireContent,url);f.advance(result.nextAttemptAt);}
 assert.equal(f.engine.snapshot().jobs.find(j=>j.id===child.id).replyRetrySuffixMode,undefined);
});
test('uncertain images wait for official history and confirmed history continues the dependent shipment',async t=>{
 const f=fixture(t);await f.engine.dispatch(f.engine.ingestOrder(f.event).id);await f.engine.dispatch(f.engine.nextJob().id);
 const child=f.engine.nextJob();f.respond({status:'uncertain'});await f.engine.dispatch(child.id);assert.equal(f.engine.nextJob(),null);
 const reopened=f.create();reopened.setRunning(true);assert.equal(reopened.nextJob(),null);
 assert.throws(()=>reopened.reconcileAttachment(child.id,{status:'confirmed',shopId:'other',buyerId:'buyer',messageId:'901'}));
 reopened.reconcileAttachment(child.id,{status:'confirmed',shopId:'shop',buyerId:'buyer',messageId:'901'});assert.equal(reopened.nextJob().type,'shipment');
});
test('a refund stops every pending delivery part and never confirms shipment',async t=>{
 const f=fixture(t);await f.engine.dispatch(f.engine.ingestOrder(f.event).id);const children=f.engine.snapshot().jobs.filter(j=>j.parentJobId);
 f.engine.ingestRefund({shopId:'shop',orderId:'order',refundId:'refund',status:'pending'});
 for (const child of children)assert.equal((await f.engine.dispatch(child.id)).status,'blocked');
 assert.equal(f.engine.snapshot().jobs.some(j=>j.type==='shipment'),false);assert.equal(f.calls.length,1);
});
test('editing settings preserves the captured parts of an already delivered parent',async t=>{
 const f=fixture(t),parent=f.engine.ingestOrder(f.event);await f.engine.dispatch(parent.id);
 f.engine.updateConfig({...f.engine.snapshot().config,suffix:'新尾缀',separateLinksEnabled:false,products:[]});
 const children=f.engine.snapshot().jobs.filter(j=>j.parentJobId);assert.ok(children.every(j=>j.status==='queued'));assert.equal(children.length,2);
});
test('legacy v2 state loads without enabling extra messages or discarding old rules',t=>{
 const f=fixture(t,{separateLinksEnabled:false});const raw=JSON.parse(fs.readFileSync(f.engine.filePath,'utf8'));
 for(const key of ['separateLinksEnabled','greetingImages','fallbackImages','deliveryFallbackImages'])delete raw.config[key];
 fs.writeFileSync(f.engine.filePath,JSON.stringify(raw));const reopened=f.create();assert.equal(reopened.snapshot().config.separateLinksEnabled,false);assert.equal(reopened.snapshot().config.products[0].content,raw.config.products[0].content);
});
test('startup immediately resumes an explicitly failed part but preserves uncertain outcomes',async t=>{
 const f=fixture(t);await f.engine.dispatch(f.engine.ingestMessage(f.incoming).id);const child=f.engine.nextJob();f.respond({status:'rejected',reason:'平台暂忙'});await f.engine.dispatch(child.id);
 const reopened=f.create();reopened.setRunning(true);assert.equal(reopened.nextJob(),null);assert.equal(reopened.prepareAttachmentsForResume(),1);assert.equal(reopened.nextJob().id,child.id);
 f.respond({status:'uncertain'});await reopened.dispatch(child.id);assert.equal(reopened.prepareAttachmentsForResume(),0);assert.equal(reopened.nextJob(),null);
});
test('unmatched delivery uses its own configured image and raw URL instead of reply defaults',async t=>{
 const f=fixture(t,{deliveryFallbackEnabled:true,deliveryFallback:'通用领取：'+url,deliveryFallbackImages:[image],fallback:'客服说明'});
 const parent=f.engine.ingestOrder({...f.event,title:'未命中商品'});assert.equal(parent.deliveryFallback,true);assert.equal(parent.messageParts[1].image.id,image.id);
 await f.engine.dispatch(parent.id);assert.equal(f.engine.nextJob().content,url);
});
test('official verification of a missing attachment requeues its exact payload after an uncertain result',async t=>{
 const f=fixture(t);await f.engine.dispatch(f.engine.ingestMessage(f.incoming).id);const child=f.engine.nextJob();f.respond({status:'uncertain'});const sent=await f.engine.dispatch(child.id);
 const retry=f.engine.reconcileAttachment(child.id,{status:'not_sent',shopId:'shop',buyerId:'buyer'});assert.equal(retry.wireContent,sent.wireContent);assert.equal(f.engine.nextJob(),null);
 f.advance(retry.nextAttemptAt);f.respond({status:'confirmed',messageId:'999'});await f.engine.dispatch(child.id);assert.equal(f.calls.at(-1).wireContent,url);
});
