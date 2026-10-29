'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CloudWatchdog,endpoint}=require('../src/core/cloud-watchdog.cjs');
const {AlertService}=require('../src/core/alert-service.cjs');
const moduleReady=import('../scripts/cloud-watchdog/worker.mjs');
const heartbeatToken='fixture-heartbeat-'.repeat(3),adminToken='fixture-admin-'.repeat(4);
const beat=(at,seq=0,mode='healthy',reason=null)=>({version:1,runId:'fixture-run-000001',seq,sentAt:at,mode,reason});
function storageFixture(){let state,alarm;return {get:async()=>state&&structuredClone(state),put:async(_key,value)=>{state=structuredClone(value);},getAlarm:async()=>alarm,setAlarm:async value=>{alarm=value;},deleteAlarm:async()=>{alarm=null;},state:()=>state,alarm:()=>alarm};}
async function fixture(t){
  let time=1_000_000,calls=0;const cloud=await moduleReady;
  t.mock.method(Date,'now',()=>time);
  t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({code:0,data:{pushid:'fixture-receipt'}});});
  const storage=storageFixture(),ctx={storage,blockConcurrencyWhile:callback=>callback()},env={HEARTBEAT_TOKEN:heartbeatToken,ADMIN_TOKEN:adminToken,SERVERCHAN_SENDKEY:'SCT'+'fixture'.repeat(8)};
  let object=new cloud.Watchdog(ctx,env);
  const post=(mode='healthy',reason=null,seq=1,sentAt=time)=>object.fetch(new Request('https://example.test/v1/heartbeat',{method:'POST',headers:{authorization:'Bearer '+heartbeatToken,'content-type':'application/json'},body:JSON.stringify(beat(sentAt,seq,mode,reason))}));
  return {cloud,storage,env,ctx,post,alarm:()=>object.alarm(),advance:ms=>{time+=ms;},now:()=>time,calls:()=>calls,restart:()=>{object=new cloud.Watchdog(ctx,env);}};
}
test('missing heartbeats trigger independently after one minute and deduplicate across alarms and restart',async t=>{
  const f=await fixture(t);assert.equal((await f.post()).status,200);f.advance(59999);await f.alarm();assert.equal(f.calls(),0);
  f.advance(1);await f.alarm();assert.equal(f.calls(),1);assert.equal(f.storage.state().incident.status,'accepted');assert.equal(f.storage.state().incident.receiptId,'fixture-receipt');
  f.restart();f.advance(300000);await f.alarm();await f.alarm();assert.equal(f.calls(),1);assert.equal(f.storage.alarm(),null);
});
test('reported login failures alert even when heartbeat connectivity remains available',async t=>{
  const f=await fixture(t);await f.post('unhealthy','login');for(let i=2;i<=5;i++){f.advance(15000);await f.post('unhealthy','login',i);}await f.alarm();assert.equal(f.calls(),1);assert.equal(f.storage.state().incident.reason,'login');
});
test('short recovery flaps keep the same incident; stable recovery rearms the next fault',async t=>{
  const f=await fixture(t);await f.post();f.advance(60000);await f.alarm();const first=f.storage.state().incident.id;
  await f.post('healthy',null,2);f.advance(15000);await f.post('unhealthy','login',3);assert.equal(f.storage.state().incident.id,first);await f.alarm();assert.equal(f.calls(),1);
  await f.post('healthy',null,4);for(let i=5;i<=8;i++){f.advance(15000);await f.post('healthy',null,i);}assert.equal(f.storage.state().incident,null);
  f.advance(60000);await f.alarm();assert.equal(f.calls(),2);assert.notEqual(f.storage.state().incident.id,first);
});
test('explicit pause disarms cloud, but lost heartbeat after resume is still monitored',async t=>{
  const f=await fixture(t);await f.post();await f.post('paused',null,2);f.advance(300000);await f.alarm();assert.equal(f.calls(),0);assert.equal(f.storage.alarm(),null);
  await f.post('healthy',null,3);f.advance(60000);await f.alarm();assert.equal(f.calls(),1);
});
test('last notification receipt remains available after a deliberate pause and object restart',async t=>{
  const f=await fixture(t);await f.post();f.advance(60000);await f.alarm();await f.post('paused',null,2);f.restart();
  const result=await f.ctx.storage.get('monitor');assert.equal(result.armed,false);assert.equal(result.incident,null);assert.equal(result.lastNotification.status,'accepted');assert.equal(result.lastNotification.receiptId,'fixture-receipt');
});
test('read-only heartbeat-token status queries cannot renew or disarm the cloud lease',async t=>{
  const f=await fixture(t);await f.post();const before=await f.storage.get('monitor'),deadline=f.storage.alarm();const object=new f.cloud.Watchdog(f.ctx,f.env);
  for(let i=0;i<6;i++){f.advance(10000);const response=await object.fetch(new Request('https://example.test/v1/state',{headers:{authorization:'Bearer '+heartbeatToken}}));assert.equal(response.status,200);assert.equal((await response.json()).armed,true);}
  assert.deepEqual(await f.storage.get('monitor'),before);assert.equal(f.storage.alarm(),deadline);await f.alarm();assert.equal(f.calls(),1);
});
test('healthy recovery before fault submission suppresses stale fault',async t=>{
  const f=await fixture(t);await f.post('unhealthy','login');f.advance(55000);await f.post('healthy',null,2);f.advance(5000);await f.alarm();assert.equal(f.calls(),0);
  for(let i=3;i<=7;i++){f.advance(12000);await f.post('healthy',null,i);}await f.alarm();assert.equal(f.calls(),0);assert.equal(f.storage.state().incident,null);
});
test('replayed heartbeat cannot extend the lease; client clock has bounded tolerance',async t=>{
  const f=await fixture(t);await f.post();const at=f.storage.state().lastSeen;f.advance(15000);assert.equal((await f.post('healthy',null,1)).status,409);assert.equal(f.storage.state().lastSeen,at);
  assert.equal((await f.post('healthy',null,2,f.now()-121000)).status,400);
  assert.throws(()=>f.cloud.validateBeat({...beat(f.now()),cookie:'private'},f.now()));
});
test('unauthenticated traffic cannot instantiate objects or read monitor state',async t=>{
  const f=await fixture(t);let allocated=0;f.env.WATCHDOG={idFromName(){allocated++;},get(){throw Error();}};
  const result=await f.cloud.default.fetch(new Request('https://example.test/v1/status'),f.env);assert.equal(result.status,401);assert.equal(allocated,0);
  assert.equal((await f.cloud.default.fetch(new Request('https://example.test/health'),f.env)).status,200);
  assert.equal(await f.cloud.authorized(new Request('https://example.test',{headers:{authorization:'Bearer '+adminToken}}),heartbeatToken),false);
});
test('ambiguous notification outcomes are visible and never blindly repeated',async t=>{
  const f=await fixture(t);t.mock.method(globalThis,'fetch',async()=>{throw Error('private token must not appear');});await f.post();f.advance(60000);await f.alarm();assert.equal(f.storage.state().incident.status,'uncertain');
  let attempts=0;t.mock.method(globalThis,'fetch',async()=>{attempts++;return Response.json({code:0,data:{pushid:'wrong'}});});f.advance(300000);await f.alarm();assert.equal(attempts,0);assert.doesNotMatch(JSON.stringify(f.storage.state()),/private token/);
});
test('definite provider rejection retries with a limit, and HTTP 200 alone is not success',async t=>{
  const f=await fixture(t);let attempts=0;t.mock.method(globalThis,'fetch',async()=>{attempts++;return Response.json({code:40001});});await f.post();f.advance(60000);await f.alarm();assert.equal(f.storage.state().incident.status,'retrying');
  await f.alarm();assert.equal(attempts,1);f.advance(120000);await f.alarm();f.advance(120000);await f.alarm();assert.equal(attempts,3);assert.equal(f.storage.state().incident.status,'failed');
  assert.equal((await f.cloud.notify(f.env,{startedAt:f.now(),reason:'offline',id:'fixture'},async()=>Response.json({code:0}))).status,'uncertain');
});
test('persisted submitting status after worker restart is not resubmitted as a new notification',async t=>{
  const f=await fixture(t);await f.post('unhealthy','login');const s=f.storage.state();s.incident.status='submitting';await f.storage.put('monitor',s);f.restart();f.advance(60000);await f.alarm();assert.equal(f.calls(),0);assert.equal(f.storage.state().incident.status,'uncertain');
});
test('cloud daily submission cap covers separate incidents',async t=>{
  const f=await fixture(t);await f.post('unhealthy','login');const s=f.storage.state();s.daily={day:new Date(f.now()+8*3600000).toISOString().slice(0,10),attempts:5};await f.storage.put('monitor',s);f.advance(60000);await f.alarm();assert.equal(f.calls(),0);assert.equal(f.storage.state().incident.status,'failed');
});
test('storage failure prevents notification submission',async t=>{
  const f=await fixture(t);await f.post();f.advance(60000);f.storage.put=async()=>{throw Error('disk');};await assert.rejects(f.alarm());assert.equal(f.calls(),0);
});
test('worker uses its supported manual redirect mode and never forwards secrets to redirect destinations',async()=>{
  const cloud=await moduleReady;let calls=0;
  const result=await cloud.notify({SERVERCHAN_SENDKEY:'SCT'+'fixture'.repeat(8)},{startedAt:1000000,reason:'offline',id:'fixture'},async(_url,options)=>{calls++;assert.equal(options.redirect,'manual');return new Response(null,{status:302,headers:{location:'https://example.test/redirect'}});});
  assert.equal(result.status,'failed');assert.equal(calls,1);
});
function clientFixture(t){let now=1_000_000;const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pdd-cloud-test-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const crypto={isEncryptionAvailable:()=>true,encryptString:text=>Buffer.from('encrypted:'+text),decryptString:buffer=>buffer.toString().slice(10)};const calls=[];
  const create=()=>new CloudWatchdog({directory,crypto,now:()=>now,fetchImpl:async(url,options)=>{const value=JSON.parse(options.body);calls.push({url,options,value});return Response.json({ok:true,version:1,acceptedSeq:value.seq,armed:value.mode!=='paused',pushConfigured:true});}});
  return {directory,crypto,calls,create,advance:ms=>{now+=ms;}};
}
test('client sends minimal status, encrypts token and limits rate without touching business config',async t=>{
  const f=clientFixture(t),client=f.create();client.update({enabled:true,url:'https://fixture.example.workers.dev',token:heartbeatToken});await client.observe({wanted:true,healthy:true,cookie:'never-upload',order:'never-upload'});await client.observe({wanted:true,healthy:true});assert.equal(f.calls.length,1);
  assert.deepEqual(Object.keys(f.calls[0].value).sort(),['mode','reason','runId','sentAt','seq','version']);assert.equal(client.snapshot().status,'connected');assert.doesNotMatch(JSON.stringify(client.snapshot()),new RegExp(heartbeatToken));
  assert.ok(JSON.parse(fs.readFileSync(client.file)).secret);assert.equal(f.create().snapshot().enabled,true);f.advance(15000);await client.observe({wanted:true,healthy:false,reason:'login'});assert.equal(f.calls[1].value.reason,'login');
});
test('client failure does not fabricate heartbeat acceptance, and disabling requires cloud pause receipt',async t=>{
  const f=clientFixture(t),client=f.create();client.update({enabled:true,url:'https://fixture.example.workers.dev',token:heartbeatToken});client.fetch=async()=>Response.json({ok:true});await client.observe({wanted:true,healthy:true});assert.equal(client.snapshot().lastAcceptedAt,null);assert.equal(client.snapshot().status,'error');
  assert.throws(()=>client.update({enabled:false}));await assert.rejects(client.disable());assert.equal(client.snapshot().enabled,true);
  client.fetch=async(_url,o)=>Response.json({ok:true,version:1,acceptedSeq:JSON.parse(o.body).seq,armed:false,pushConfigured:true});await client.disable();assert.equal(client.snapshot().enabled,false);
});
test('client blocks URL credentials, redirect destinations and non-Cloudflare endpoints',()=>{
  for(const value of ['http://fixture.workers.dev','https://example.test','https://token@fixture.workers.dev','https://fixture.workers.dev/?key=private','https://fixture.workers.dev/path'])assert.throws(()=>endpoint(value));
});
test('health transitions submit promptly; logs omit credentials and successful steady heartbeats do not flood logs',async t=>{
  const f=clientFixture(t),client=f.create();client.update({enabled:true,url:'https://fixture.example.workers.dev',token:heartbeatToken});await client.observe({wanted:true,healthy:true});await client.observe({wanted:true,healthy:false,reason:'login'});await client.observe({wanted:false,healthy:false});assert.deepEqual(f.calls.map(row=>row.value.mode),['healthy','unhealthy','paused']);
  const log=fs.readFileSync(path.join(f.directory,'cloud-watchdog.jsonl'),'utf8');assert.doesNotMatch(log,new RegExp(heartbeatToken));const before=log.split('\n').filter(Boolean).length;f.advance(15000);await client.observe({wanted:false,healthy:false});assert.equal(fs.readFileSync(path.join(f.directory,'cloud-watchdog.jsonl'),'utf8').split('\n').filter(Boolean).length,before);
});
test('cloud acknowledgement of missing push configuration restores local ownership but still allows disarming',async t=>{
  const f=clientFixture(t),client=f.create();client.update({enabled:true,url:'https://fixture.example.workers.dev',token:heartbeatToken});await client.observe({wanted:true,healthy:true});assert.equal(client.snapshot().ownsMobile,true);
  client.fetch=async(_url,options)=>{const body=JSON.parse(options.body);return Response.json({ok:true,version:1,acceptedSeq:body.seq,armed:body.mode!=='paused',pushConfigured:false});};
  f.advance(15000);await client.observe({wanted:true,healthy:true});assert.equal(client.snapshot().ownsMobile,false);assert.equal(client.snapshot().status,'error');
  await client.disable();assert.equal(client.snapshot().enabled,false);assert.equal(client.snapshot().status,'paused');
});
test('client reads cloud notification result without changing last accepted heartbeat or sending a body',async t=>{
  const f=clientFixture(t),client=f.create();client.update({enabled:true,url:'https://fixture.example.workers.dev',token:heartbeatToken});await client.observe({wanted:true,healthy:true});const before=client.snapshot().lastAcceptedAt;
  client.fetch=async(url,options)=>{assert.ok(url.endsWith('/v1/state'));assert.equal(options.body,undefined);return Response.json({ok:true,version:1,armed:true,incident:{id:'current',status:'accepted',at:1000000},secrets:'must-not-be-retained'});};f.advance(65000);await client.peek();assert.equal(client.snapshot().lastAcceptedAt,before);assert.equal(client.snapshot().cloudIncident.status,'accepted');assert.doesNotMatch(JSON.stringify(client.snapshot()),/must-not-be-retained/);
});
test('delegating mobile fault notifications to cloud preserves desktop and configured settings',t=>{
  const f=clientFixture(t),service=new AlertService({directory:f.directory,crypto:f.crypto});service.update({config:{enabled:true},token:'SCT'+'fixture'.repeat(8)});service.setRemoteOwner(true);assert.equal(service.snapshot().config.enabled,true);assert.equal(service.monitor.config.enabled,false);assert.equal(service.monitor.config.desktopEnabled,true);service.update({config:{enabled:true,desktopEnabled:true}});assert.equal(service.monitor.config.enabled,false);service.setRemoteOwner(false);assert.equal(service.monitor.config.enabled,true);service.dispose();
});
