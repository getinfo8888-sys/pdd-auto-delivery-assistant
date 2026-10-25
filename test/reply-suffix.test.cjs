'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Engine,validateConfig}=require('../src/core/engine.cjs');
const {formatReplyContent,isValidReplyPayload}=require('../src/core/reply-suffix.cjs');
const message=(messageId,text='你好',extra={})=>({shopId:'shop',buyerId:'buyer',messageId,text,direction:'incoming',...extra});
function fixture(t,sendMessage=async()=>({status:'confirmed',messageId:'9001'})) {
  const base=path.resolve(os.tmpdir());const directory=fs.mkdtempSync(path.join(base,'reply-suffix-'));
  t.after(()=>{if(path.dirname(directory)!==base || !path.basename(directory).startsWith('reply-suffix-'))throw Error('Unsafe cleanup');fs.rmSync(directory,{recursive:true,force:true});});
  let time=1800000000000;
  const filePath=path.join(directory,'state.json');const options={filePath,sendMessage,now:()=>time};
  const engine=new Engine(options);
  engine.updateConfig({...engine.snapshot().config,running:true,autoReplyEnabled:true,replySuffixEnabled:true,greetingEnabled:false,fallback:'自动答复正文',cooldownSeconds:10});
  return {engine,filePath,options,advance:ms=>{time+=ms;}};
}
test('reply suffix modes validate and keep the feature off for an existing configuration',()=>{
  const config=validateConfig({});assert.equal(config.replySuffixEnabled,false);assert.equal(config.replySuffixMode,'invisible');
  assert.throws(()=>validateConfig({replySuffixMode:'unknown'}),/选项/);
  assert.throws(()=>validateConfig({replySuffixEnabled:'yes'}),/布尔/);
});
test('invisible suffixes preserve the original text and use bounded zero-width characters',()=>{
  let draw=0;
  const one=formatReplyContent('答复',{enabled:true,pick:(min,max)=>max===101?16:draw++%max});
  const two=formatReplyContent('答复',{enabled:true,pick:(min,max)=>max===101?16:draw++%max});
  assert.match(one.content,/^答复  \u200b[\u200b-\u200d]{16}$/u);assert.equal(one.mode,'invisible');assert.notEqual(one.content,two.content);
  assert.deepEqual(formatReplyContent('答复'),{content:'答复',mode:'none'});
});
test('original suffix boundaries preserve the zero draw and the 100-character draw',()=>{
  assert.equal(formatReplyContent('正文',{enabled:true,pick:()=>0}).content,'正文 ');
  const maximum=formatReplyContent('正文',{enabled:true,pick:(min,max)=>max===101?100:2});
  assert.equal(maximum.content,'正文  \u200b'+'\u200d'.repeat(100));assert.equal(maximum.content.length-'正文'.length,103);
});
test('a URL at the end is unchanged in invisible mode; a timestamp uses a separate line',()=>{
  const text='领取：https://pan.example.test/resource?code=1234';
  assert.deepEqual(formatReplyContent(text,{enabled:true}),{content:text,mode:'none',note:'url_tail'});
  const now=new Date(2026,9,16,12,34,56).getTime();
  const value=formatReplyContent(text,{enabled:true,mode:'time',now});assert.equal(value.content,text+'\n2026-10-16 12:34:56');
  const body=text+'\n提取码：1234';assert.ok(formatReplyContent(body,{enabled:true}).content.startsWith(body));
});
test('a suffix cannot truncate a long answer or change existing URL characters',()=>{
  const text='字'.repeat(20000);assert.deepEqual(formatReplyContent(text,{enabled:true}),{content:text,mode:'none',note:'length_limit'});
  assert.deepEqual(formatReplyContent(text,{enabled:true,mode:'time'}),{content:text,mode:'none',note:'length_limit'});
});

test('a retry marker varies only the suffix and preserves the entire configured answer',()=>{
  const body='第一行\n\n领取：https://pan.example.test/resource?code=1234';
  const now=new Date(2026,9,16,12,34,56).getTime();
  const first=formatReplyContent(body,{enabled:true,mode:'time-tag',now,pick:()=>0});
  const second=formatReplyContent(body,{enabled:true,mode:'time-tag',now,pick:()=>1});
  assert.equal(first.content,body+'\n2026-10-16 12:34:56\n〔消息标记：AAAAAA〕');
  assert.equal(second.content,body+'\n2026-10-16 12:34:56\n〔消息标记：BBBBBB〕');
  assert.equal(first.mode,'time-tag');assert.notEqual(first.content,second.content);
  const longBody='字'.repeat(19990);
  assert.deepEqual(formatReplyContent(longBody,{enabled:true,mode:'time-tag',now}),{content:longBody,mode:'none',note:'length_limit'});
});

test('a body-space retry adds exactly three recoverable spaces without splitting protected data',()=>{
  const body='本店所有商品为国际服\n安卓苹果通用\n链接：https://网盘.example.test/领取资源?code=测试\n提取码：测试密码\n口令：复制这段内容\n英文资源ABC123\n表情😀与扩展汉字𠮷都保留';
  const result=formatReplyContent(body,{enabled:true,mode:'time-tag',bodySpaces:true,pick:()=>0});
  assert.equal(result.bodySpaceOffsets.length,3);assert.equal(result.content.length-body.length,3+34);
  assert.equal(isValidReplyPayload(body,result.content,result.bodySpaceOffsets),true);
  const url='https://网盘.example.test/领取资源?code=测试';assert.ok(result.content.includes(url));
  for(const text of ['提取码：测试密码','口令：复制这段内容','ABC123','😀','𠮷'])assert.ok(result.content.includes(text));
  let restored=result.content.slice(0,body.length+3);
  for(let index=2;index>=0;index--){const offset=result.bodySpaceOffsets[index]+index;assert.equal(restored[offset],' ');restored=restored.slice(0,offset)+restored.slice(offset+1);}
  assert.equal(restored,body);
  assert.equal(isValidReplyPayload(body,result.content),false);
});

test('unsafe or insufficient body positions keep the answer intact and validation rejects corrupt edits',()=>{
  const now=new Date(2026,9,16,12,34,56).getTime();
  for(const body of ['你好','https://网盘.example.test/汉字资源','提取码：汉字密码','😀𠮷ABC123','`复制这段完整内容`']) {
    const result=formatReplyContent(body,{enabled:true,mode:'time-tag',bodySpaces:true,now,pick:()=>0});
    assert.ok(result.content.startsWith(body));assert.equal(result.bodySpaceOffsets,undefined);assert.equal(result.note,'no_safe_body_spaces');
    assert.equal(isValidReplyPayload(body,result.content),true);
  }
  const body='本店所有商品为国际服';const result=formatReplyContent(body,{enabled:true,mode:'time-tag',bodySpaces:true,now,pick:()=>0});
  for(const offsets of [[1,1,2],[3,2,1],[1,2,100],[1,2],[1,2,3.5],[]])assert.equal(isValidReplyPayload(body,result.content,offsets),false);
  assert.equal(isValidReplyPayload(body,result.content.replace('本','别'),result.bodySpaceOffsets),false);
  const legacy=formatReplyContent(body,{enabled:true,pick:()=>0});assert.equal(isValidReplyPayload(body,legacy.content),true);
});

test('space retries skip safely when the available character limit has room only for the suffix',()=>{
  const body='汉'.repeat(19965);const result=formatReplyContent(body,{enabled:true,mode:'time-tag',bodySpaces:true,pick:()=>0});
  assert.ok(result.content.startsWith(body));assert.equal(result.content.length,19999);assert.equal(result.bodySpaceOffsets,undefined);
  assert.equal(result.note,'body_spaces_length_limit');assert.equal(isValidReplyPayload(body,result.content),true);
});
test('v2 state without the new fields loads with every rule and completed job preserved',async t=>{
  const {engine,filePath,options}=fixture(t);const job=engine.ingestMessage(message('m1'));await engine.dispatch(job.id);
  const saved=JSON.parse(fs.readFileSync(filePath));delete saved.config.replySuffixEnabled;delete saved.config.replySuffixMode;saved.config.running=false;
  fs.writeFileSync(filePath,JSON.stringify(saved));const loaded=new Engine(options).snapshot();
  assert.equal(loaded.config.replySuffixEnabled,false);assert.equal(loaded.jobs[0].content,job.content);assert.equal(loaded.jobs[0].status,'sent');assert.equal(loaded.stats.replySent,1);
});
test('the exact suffixed send intent is persisted once and reused after a preflight deferral',async t=>{
  const sent=[];let fixtureValue;
  fixtureValue=fixture(t,async job=>{
    const saved=JSON.parse(fs.readFileSync(fixtureValue.filePath));
    assert.equal(saved.jobs.find(row=>row.id===job.id).wireContent,job.wireContent);
    assert.equal(job.wireContentSha256,require('node:crypto').createHash('sha256').update(job.wireContent).digest('hex'));
    assert.equal(saved.jobs.find(row=>row.id===job.id).status,'sending');sent.push(job);
    return sent.length===1?{status:'deferred',reason:'离线，未提交'}:{status:'confirmed',messageId:'9001'};
  });
  const {engine,advance,options}=fixtureValue;const job=engine.ingestMessage(message('m1'));await engine.dispatch(job.id);
  advance(3001);await engine.dispatch(job.id);assert.equal(sent.length,2);assert.equal(sent[0].wireContent,sent[1].wireContent);assert.equal(sent[0].content,job.content);assert.notEqual(sent[0].wireContent,job.content);
  const loaded=new Engine(options);assert.equal(loaded.snapshot().jobs[0].wireContent,sent[0].wireContent);assert.equal(loaded.snapshot().jobs[0].status,'sent');
});
test('random suffixes do not bypass local cooldowns or alter delivery content',async t=>{
  const {engine}=fixture(t);const first=engine.ingestMessage(message('m1'));await engine.dispatch(first.id);
  const waiting=engine.ingestMessage(message('m2'));assert.equal(waiting.status,'queued');assert.equal(waiting.reason,'cooldown');
  assert.equal(engine.snapshot().jobs.length,2);assert.equal(engine.snapshot().logs.at(-1).code,'cooldown_queued');assert.equal(engine.nextJob(),null);
  engine.updateConfig({...engine.snapshot().config,autoDeliveryEnabled:true,products:[{id:'p',name:'游戏',keywords:['游戏'],content:'https://pan.example.test/delivery',enabled:true}]});
  const order=engine.ingestOrder({shopId:'shop',buyerId:'buyer',orderId:'o',itemId:'g',title:'游戏',paid:true});
  await engine.dispatch(order.id);const delivery=engine.snapshot().jobs.find(row=>row.id===order.id);assert.equal(delivery.wireContent,undefined);assert.equal(delivery.content,order.content);
});
test('a suffixed assistant echo does not cancel another pending automatic reply',async t=>{
  let engine;
  const fixtureValue=fixture(t,async job=>{engine.ingestMessage(message('outgoing',job.wireContent,{direction:'outgoing'}));return {status:'confirmed',messageId:'9001'};});engine=fixtureValue.engine;
  engine.updateConfig({...engine.snapshot().config,greetingEnabled:true,replyRules:[{id:'trial',name:'试玩',keywords:['试玩'],content:'试玩说明',enabled:true}]});
  const first=engine.ingestMessage(message('incoming','试玩'));await engine.dispatch(first.id);
  const remaining=engine.snapshot().jobs.find(row=>row.id!==first.id);assert.equal(remaining.status,'queued');
});
test('previews are local and an explicit duplicate rejection waits in the retry queue',async t=>{
  let submissions=0;const {engine}=fixture(t,async()=>{submissions++;return {status:'rejected',reason:'请勿重复发送相同消息'};});
  const preview=engine.ingestMessage(message('preview'),{simulation:true});await engine.dispatch(preview.id);assert.equal(submissions,0);assert.equal(engine.snapshot().jobs[0].wireContent,undefined);
  const live=engine.ingestMessage(message('live'));await engine.dispatch(live.id);assert.equal(submissions,1);assert.equal(engine.snapshot().jobs.at(-1).status,'queued');assert.equal(engine.snapshot().jobs.at(-1).replyRetrySuffixMode,'time');assert.equal(engine.snapshot().stats.blocked,0);assert.equal(engine.nextJob(),null);
});
