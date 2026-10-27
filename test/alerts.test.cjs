'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {AlertMonitor,defaults}=require('../src/core/alert-monitor.cjs');
const {AlertService}=require('../src/core/alert-service.cjs');
const {sendAlert}=require('../src/core/alert-transport.cjs');
const {connectionSample}=require('../src/core/alert-health.cjs');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(extra={}){let now=1000000,stored,calls=[];const create=state=>new AlertMonitor({state,config:{...defaults,enabled:true,...extra},previouslyWorked:true,now:()=>now,persist:value=>{stored=value;},send:async message=>{calls.push(message);return {accepted:true,receiptId:'fixture-receipt'};}});const monitor=create();return {monitor,calls,advance:ms=>{now+=ms;},create,state:()=>stored,fail:(id,online=true)=>({wanted:true,online,healthy:false,reason:'login',failures:[{source:'reconnect',id:String(id)}]}),healthy:()=>({wanted:true,online:true,healthy:true,failures:[]})};}
test('transient reconnects are quiet; sustained failures submit once and remain deduplicated after restart',async()=>{
  const f=fixture();f.monitor.observe(f.fail(1));for(let i=0;i<8;i++)f.monitor.observe(f.fail(1));f.advance(120000);f.monitor.observe(f.fail(2));await settle();assert.equal(f.calls.length,0);
  f.monitor.observe(f.fail(3));await settle();assert.equal(f.calls.length,1);assert.equal(f.monitor.snapshot().lastNotification.status,'accepted');
  assert.ok(f.calls[0].content.includes('\n'),'notification paragraphs use real line breaks');
  f.monitor.observe(f.fail(4));await settle();const reopened=f.create(f.state());reopened.observe(f.fail(5));await settle();assert.equal(f.calls.length,1);
});
test('manual pause and first-time login do not trigger alerts',async()=>{
  const f=fixture();f.monitor.state.armed=false;f.monitor.observe(f.fail(1));f.advance(180000);f.monitor.observe(f.fail(2));await settle();assert.equal(f.calls.length,0);
  f.monitor.observe(f.healthy());f.monitor.observe({...f.fail(3),wanted:false});f.advance(180000);f.monitor.observe({...f.fail(4),wanted:false});await settle();assert.equal(f.calls.length,0);assert.equal(f.monitor.state.incident,null);
});
test('short healthy flaps do not reset an incident; stable recovery can notify once',async()=>{
  const f=fixture({notifyRecovery:true});f.monitor.observe(f.fail(1));f.advance(120000);f.monitor.observe(f.fail(2));f.monitor.observe(f.fail(3));await settle();
  f.monitor.observe(f.healthy());f.advance(30000);f.monitor.observe(f.fail(4));await settle();assert.equal(f.calls.length,1);
  f.monitor.observe(f.healthy());f.advance(60000);f.monitor.observe(f.healthy());await settle();assert.equal(f.calls.length,2);assert.equal(f.monitor.state.incident,null);assert.match(f.calls[1].title,/恢复/);
});
test('offline alert waits for connectivity and becomes a single recovery summary when already healthy',async()=>{
  const f=fixture();f.monitor.observe(f.fail(1,false));f.advance(120000);f.monitor.observe(f.fail(2,false));f.monitor.observe(f.fail(3,false));await settle();assert.equal(f.calls.length,0);
  f.monitor.observe(f.healthy());await settle();assert.equal(f.calls.length,0);f.advance(60000);f.monitor.observe(f.healthy());await settle();assert.equal(f.calls.length,1);assert.match(f.calls[0].content,/补充通知/);
});
test('notification failures back off and stop after three attempts without blocking observation',async()=>{
  const f=fixture();let attempts=0;f.monitor.send=async()=>{attempts++;throw Error('untrusted provider error');};f.monitor.observe(f.fail(1));f.advance(120000);f.monitor.observe(f.fail(2));f.monitor.observe(f.fail(3));await settle();
  for(let i=0;i<20;i++)f.monitor.observe(f.fail(3));await settle();assert.equal(attempts,1);
  f.advance(30000);f.monitor.observe(f.fail(4));await settle();f.advance(120000);f.monitor.observe(f.fail(5));await settle();f.advance(600000);f.monitor.observe(f.fail(6));await settle();assert.equal(attempts,3);assert.equal(f.monitor.snapshot().lastNotification.status,'failed');
});
test('failure to persist notification intent prevents external submission',async()=>{
  const f=fixture();f.monitor.persist=()=>{throw Error('disk unavailable');};f.monitor.observe(f.fail(1));f.advance(120000);f.monitor.observe(f.fail(2));f.monitor.observe(f.fail(3));await settle();assert.equal(f.calls.length,0);assert.ok(f.monitor.snapshot().persistenceError);
});
const token='SCT'+'fixture'.repeat(8);

test('default one-minute deadline alerts on the first subsequent check, with no extra two-minute wait',async()=>{
  assert.equal(defaults.failureSeconds,60);
  const f=fixture(),shown=[];f.monitor.desktop=notice=>shown.push(notice);
  f.monitor.observe(f.fail(1));f.advance(15000);f.monitor.observe(f.fail(2));f.advance(15000);f.monitor.observe(f.fail(3));f.advance(29000);f.monitor.observe(f.fail(4));await settle();
  assert.equal(f.calls.length,0);assert.equal(shown.length,0);
  f.advance(1000);f.monitor.observe(f.fail(5));await settle();assert.equal(f.calls.length,1);assert.equal(shown.filter(Boolean).length,1);
});
test('notification keys stay encrypted on disk and never appear in settings snapshots',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pdd-alerts-'));t.after(()=>{if(path.dirname(directory)!==path.resolve(os.tmpdir())||!path.basename(directory).startsWith('pdd-alerts-'))throw Error('Unsafe cleanup');fs.rmSync(directory,{recursive:true,force:true});});
  const crypto={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value).map(byte=>byte^91),decryptString:buffer=>Buffer.from(buffer.map(byte=>byte^91)).toString()};
  const service=new AlertService({directory,crypto});service.update({config:{...defaults,enabled:true},token});
  assert.equal(fs.readFileSync(path.join(directory,'phone-alerts.json'),'utf8').includes(token),false);assert.equal(JSON.stringify(service.snapshot()).includes(token),false);assert.equal(service.snapshot().credentials.serverchan,true);
  const reopened=new AlertService({directory,crypto});assert.equal(reopened.snapshot().config.enabled,true);assert.equal(reopened.snapshot().credentials.serverchan,true);
});
test('provider requests use HTTPS, expire PushPlus requests in milliseconds and require a receipt',async()=>{
  const calls=[],fetchImpl=async(url,options)=>{calls.push({url,options});return {ok:true,text:async()=>JSON.stringify(url.includes('sctapi')?{code:0,data:{errno:0,pushid:12}}:{code:200,data:'fixture-id'})};};
  assert.equal((await sendAlert({provider:'serverchan',channel:'wechat',token,message:{title:'隔离提醒',content:'连接异常'},fetchImpl})).accepted,true);
  await sendAlert({provider:'pushplus',channel:'sms',token:'a'.repeat(32),message:{title:'隔离提醒',content:'连接异常'},fetchImpl});
  const body=JSON.parse(calls[1].options.body);assert.equal(body.channel,'sms');assert.ok(body.timestamp>Date.now());assert.equal(calls[1].options.redirect,'error');assert.ok(calls.every(row=>row.url.startsWith('https://')));
  await assert.rejects(sendAlert({provider:'serverchan',channel:'wechat',token,message:{title:'隔离提醒',content:'连接异常'},fetchImpl:async()=>({ok:true,text:async()=>'{"code":0}'})}),/未受理/);
});
test('provider exceptions and echoed credentials never leak into returned errors',async()=>{
  await assert.rejects(sendAlert({provider:'serverchan',channel:'wechat',token,message:{title:'隔离提醒',content:'连接异常'},fetchImpl:async()=>{throw Error(token);}}),error=>!error.message.includes(token)&&!!error.safeMessage);
});
test('health sampling preserves recovery intent and isolates disabled capability failures',()=>{
  const now=Date.now(),base={config:{running:false,autoReplyEnabled:true},listenIntent:true,startup:{active:true,attempt:3,generation:1,state:{phase:'login',message:'请先扫码登录'}},bridgeAvailable:false,diagnostics:{chat:{ready:false,message:'请先扫码登录',checkedAt:now}},now};
  const failed=connectionSample(base);assert.equal(failed.wanted,true);assert.equal(failed.reason,'login');assert.ok(failed.failures.some(row=>row.source==='reconnect'));
  const healthy=connectionSample({...base,config:{running:true,autoReplyEnabled:true,autoDeliveryEnabled:false},startup:{active:false},bridgeAvailable:true,diagnostics:{chat:{ready:true,checkedAt:now}},capabilities:{orders:{ready:false,failures:5,checkedAt:now,reason:'滑块验证'}}});assert.equal(healthy.healthy,true);
  assert.equal(connectionSample({...base,listenIntent:false,startup:{active:false}}).wanted,false);
});

test('a notification left submitting across restart is bounded by the retry limit',async()=>{
  const f=fixture();f.monitor.observe(f.fail(1,false));f.advance(120000);f.monitor.observe(f.fail(2,false));f.monitor.observe(f.fail(3,false));
  const state=f.state();state.outbox[0].status='submitting';state.outbox[0].attempts=3;
  const reopened=f.create(state);f.advance(600000);reopened.observe(f.fail(4));await settle();assert.equal(f.calls.length,0);assert.equal(reopened.snapshot().outbox[0].status,'failed');
});

test('a failed refund identity lookup is monitored even when delivery is disabled',()=>{
  const now=Date.now();const sample=connectionSample({now,config:{running:true,autoRefundEnabled:true,autoDeliveryEnabled:false},bridgeAvailable:true,diagnostics:{chat:{ready:true,checkedAt:now}},capabilities:{orders:{ready:false,failures:3,checkedAt:now,reason:'订单查询连接中断'}}});
  assert.equal(sample.healthy,false);assert.equal(sample.reason,'orders');
});

test('corrupt optional notification files are preserved and cannot stop normal app startup',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pdd-alerts-'));t.after(()=>{if(path.dirname(directory)!==path.resolve(os.tmpdir())||!path.basename(directory).startsWith('pdd-alerts-'))throw Error('Unsafe cleanup');fs.rmSync(directory,{recursive:true,force:true});});
  const file=path.join(directory,'phone-alerts.json');const original=JSON.stringify({version:1,config:{...defaults,enabled:true},secrets:{},monitor:{version:1,armed:true,outbox:[null]}});fs.writeFileSync(file,original);
  const service=new AlertService({directory,crypto:{isEncryptionAvailable:()=>true}});assert.equal(service.snapshot().config.enabled,false);assert.ok(service.snapshot().settingsError);assert.equal(fs.readFileSync(file,'utf8'),original);
});

test('missing encryption cannot silently save a plaintext key',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pdd-alerts-'));t.after(()=>{if(path.dirname(directory)!==path.resolve(os.tmpdir())||!path.basename(directory).startsWith('pdd-alerts-'))throw Error('Unsafe cleanup');fs.rmSync(directory,{recursive:true,force:true});});
  const service=new AlertService({directory,crypto:{isEncryptionAvailable:()=>false}});assert.throws(()=>service.update({config:{...defaults,enabled:true},token}),/加密/);assert.equal(fs.existsSync(path.join(directory,'phone-alerts.json')),false);
});

test('desktop warning works offline with phone disabled, deduplicates and closes after stable recovery',async()=>{
  const f=fixture({enabled:false}),notices=[];f.monitor.desktop=notice=>notices.push(notice);
  f.monitor.observe(f.fail(1,false));f.advance(120000);f.monitor.observe(f.fail(2,false));f.monitor.observe(f.fail(3,false));
  assert.equal(notices.filter(Boolean).length,1);assert.equal(f.calls.length,0);assert.equal(f.monitor.state.outbox.length,0);
  f.monitor.observe(f.fail(4,false));assert.equal(notices.filter(Boolean).length,1);
  const reopened=f.create(f.state());reopened.desktop=notice=>notices.push(notice);reopened.observe(f.fail(5,false));assert.equal(notices.filter(Boolean).length,1);
  reopened.observe(f.healthy());f.advance(30000);reopened.observe(f.fail(6));assert.equal(notices.at(-1).id,notices[0].id);
  reopened.observe(f.healthy());f.advance(60000);reopened.observe(f.healthy());assert.equal(notices.at(-1),null);
  reopened.observe(f.fail(7));f.advance(120000);reopened.observe(f.fail(8));reopened.observe(f.fail(9));assert.equal(notices.filter(Boolean).length,2);
});

test('manual pause cancels pending notifications and closes desktop warning without stopping recovery',()=>{
  const f=fixture(),notices=[];f.monitor.desktop=notice=>notices.push(notice);
  f.monitor.observe(f.fail(1,false));f.advance(120000);f.monitor.observe(f.fail(2,false));f.monitor.observe(f.fail(3,false));
  f.monitor.observe({...f.fail(4),wanted:false});assert.equal(notices.at(-1),null);assert.equal(f.monitor.state.incident,null);assert.equal(f.monitor.state.outbox[0].status,'cancelled');
});

test('a later chat logout escalates a previously notified order-only incident',async()=>{
  const f=fixture(),notices=[];f.monitor.desktop=notice=>notices.push(notice);
  const order=id=>({...f.fail(id),reason:'orders',scope:'orders'});
  f.monitor.observe(order(1));f.advance(120000);f.monitor.observe(order(2));f.monitor.observe(order(3));await settle();assert.equal(f.calls.length,1);const orderId=f.monitor.state.incident.id;
  f.monitor.observe({...f.fail(4),scope:'chat'});f.advance(120000);f.monitor.observe({...f.fail(5),scope:'chat'});f.monitor.observe({...f.fail(6),scope:'chat'});await settle();
  assert.equal(f.calls.length,2);assert.notEqual(f.monitor.state.incident.id,orderId);assert.equal(notices.filter(Boolean).length,2);
  f.monitor.observe({...f.fail(7),scope:'chat',reason:'verification'});await settle();assert.equal(f.calls.length,2);
});

test('stale connection results and offline observations accumulate actual timed health checks',()=>{
  const base={config:{running:true,autoReplyEnabled:true},bridgeAvailable:true,diagnostics:{chat:{ready:true,checkedAt:1000}},now:120000};
  const stale=connectionSample(base),offline=connectionSample({...base,online:false});
  assert.equal(stale.healthy,false);assert.ok(stale.failures.some(row=>row.source==='stalled'));
  assert.equal(offline.scope,'chat');assert.ok(offline.failures.some(row=>row.source==='network'));
});

test('a stuck reconnect cannot postpone the one-minute alert by never completing another attempt',()=>{
  const f=fixture({enabled:false}),shown=[];f.monitor.desktop=notice=>shown.push(notice);
  for(let i=0;i<=4;i++){
    const sample=connectionSample({config:{running:false,autoReplyEnabled:true},listenIntent:true,startup:{active:true,attempt:1,generation:1,state:{phase:'login',message:'请先扫码登录'}},bridgeAvailable:false,diagnostics:{chat:{ready:false,checkedAt:1}},now:1000000+i*15000});
    f.monitor.observe(sample);if(i<4)f.advance(15000);
  }
  assert.equal(shown.filter(Boolean).length,1);assert.ok(f.monitor.state.incident.failures>=3);
});

test('local popup failure is recorded and retried without leaking an exception into business',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pdd-alerts-'));t.after(()=>{if(path.dirname(directory)!==path.resolve(os.tmpdir())||!path.basename(directory).startsWith('pdd-alerts-'))throw Error('Unsafe cleanup');fs.rmSync(directory,{recursive:true,force:true});});
  let now=1000000,attempts=0;
  const service=new AlertService({directory,crypto:{isEncryptionAvailable:()=>true},previouslyWorked:true,now:()=>now,desktop:()=>{if(++attempts===1)throw Error('fixture');}});
  const failed=id=>({wanted:true,online:false,healthy:false,reason:'login',failures:[{source:'fixture',id:String(id)}]});
  service.observe(failed(1));now+=120000;service.observe(failed(2));service.observe(failed(3));assert.ok(service.snapshot().runtimeError);
  service.observe(failed(4));assert.equal(service.snapshot().runtimeError,null);assert.equal(attempts,2);
});
