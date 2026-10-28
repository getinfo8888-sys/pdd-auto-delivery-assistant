'use strict';
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run({app,window,engine,dataDir,startupListener,maintainPendingReplies,recoverConnection,poll,pause,networkRefresh,observeNetwork,configureTestPlatform}) {
  const platform=require('./fixture-platform.cjs').createPlatform();configureTestPlatform(platform);
  const evalUi=code=>window.webContents.executeJavaScript(code);
  const until=async(check,label)=>{const deadline=Date.now()+18000;while(Date.now()<deadline){if(await check())return;await wait(100);}throw Error('Timeout: '+label);};
  const message=(buyerId,messageId,text='试玩')=>({shopId:platform.data.shopId,buyerId,messageId,text,direction:'incoming',pending:true,sentAt:Date.now()-3600000});
  const old=message('old-buyer','old-failed');const changed=message('answered-buyer','already-answered');const missed=message('missed-buyer','while-closed');
  const superseded=message('newer-buyer','stale-message');const newer=message('newer-buyer','newest-message');
  const historical={...message('historical-buyer','two-days-ago'),sentAt:Date.now()-2*86400000};
  engine.updateConfig({...engine.snapshot().config,running:true,autoReplyEnabled:true,autoListenOnLaunch:true,catchUpUnrepliedEnabled:true,greetingEnabled:false,cooldownSeconds:0,
    replyBodySpaceRetryEnabled:true,replyRules:[{id:'trial',name:'试玩说明',keywords:['试玩'],content:'试玩说明（本地测试）',enabled:true}]});
  const normalBridge=platform.bridge;
  const transport=engine.sendMessage;engine.sendMessage=async()=>({status:'rejected',reason:'duplicate'});
  const failed=engine.ingestMessage(old);await engine.dispatch(failed.id);engine.sendMessage=transport;assert.equal(engine.snapshot().jobs.at(-1).status,'blocked');
  pause();engine.updateConfig({...engine.snapshot().config,replySuffixEnabled:true});
  let loggedIn=false;const normalChat=platform.chat;platform.chat=()=>{if(!loggedIn)throw Error('请在官方客服页面扫码登录');return normalChat();};
  platform.data.unreplied=[old,missed,newer,historical];const pages=[];let latePendingActive=false;const retryAttempts=[];let pendingScans=0,networkFixture=false,socketReady=true;
  platform.bridge=async(kind,action,payload)=>{
    if(networkFixture && kind==='chat' && action==='health')return {...await normalBridge(kind,action,payload),canSendViaSocket:socketReady};
    if(action==='unreplied'||action==='unreplied-history')pendingScans++;
    if(latePendingActive&&action==='send'&&payload.job.buyerId==='periodic-buyer') {
      retryAttempts.push({content:payload.job.wireContent,mode:payload.job.replySuffixApplied});
      if(retryAttempts.length<=3)return {status:'rejected',reason:'请勿重复发送相同消息'};
    }
    if(latePendingActive&&['unreplied','unreplied-history'].includes(action))return normalBridge(kind,action,payload);
    if(action==='unreplied'){pages.push(payload.page);return {ready:true,scanned:2,messages:structuredClone(payload.page===1?[old,changed]:[missed,superseded]),hasMore:payload.page===1};}
    if(action==='unreplied-history')return {ready:true,messages:structuredClone([historical]),scanned:1,hasMore:false};
    return normalBridge(kind,action,payload);
  };
  await until(()=>evalUi(`!!document.querySelector('[data-nav="settings"]')`),'UI loaded');
  startupListener.arm(engine.snapshot().config);
  await until(()=>startupListener.state.phase==='login','automatic login wait');
  await until(()=>evalUi(`document.querySelector('#running-button').textContent.includes('取消自动连接')`),'cancel auto connection is visible');
  assert.equal(platform.data.actions.length,0);loggedIn=true;
  await until(()=>engine.snapshot().config.running,'login finished without pressing Start');
  await until(()=>engine.snapshot().stats.replySent===4,'historical rejected, offline and newest messages recovered');
  await until(()=>engine.snapshot().jobs.some(row=>row.catchUp&&row.status==='cancelled'),'already answered reply cancelled by preflight');
  assert.deepEqual(pages,[1,2]);assert.equal(platform.data.actions.length,4);
  assert.equal(platform.data.actions.every(row=>row.content.startsWith('试玩说明（本地测试）')&&/^(?: |  \u200b[\u200b-\u200d]{1,100})$/u.test(row.content.slice('试玩说明（本地测试）'.length))),true);
  const before=engine.snapshot().jobs.length;
  pause();startupListener.arm(engine.snapshot().config);await until(()=>engine.snapshot().config.running,'second automatic connection');
  await wait(1400);assert.equal(engine.snapshot().jobs.length,before);assert.equal(platform.data.actions.length,4);
  // This pending source is absent from the live chat view. Only the same
  // maintenance path used by the production timer can discover and recover it.
  latePendingActive=true;const late=message('periodic-buyer','late-pending','怎样领取');platform.data.unreplied.push(late);
  await maintainPendingReplies(true);
  await until(()=>engine.snapshot().jobs.some(row=>row.messageId===late.messageId&&row.status==='queued'&&row.replyRetryCount===1),'duplicate rejection remains queued');
  const waiting=engine.snapshot().jobs.find(row=>row.messageId===late.messageId);assert.ok(waiting.nextAttemptAt>Date.now());
  pause();startupListener.arm(engine.snapshot().config);await until(()=>engine.snapshot().config.running,'restart automatically resumes pending retries');
  await until(()=>engine.snapshot().jobs.some(row=>row.messageId===late.messageId&&row.status==='queued'&&row.replyRetryCount===3),'three explicit rejections reach body-space stage');
  pause();startupListener.arm(engine.snapshot().config);await until(()=>engine.snapshot().config.running,'reopening resumes body-space stage');
  await until(()=>engine.snapshot().jobs.some(row=>row.messageId===late.messageId&&row.status==='sent'),'body-space stage continues until platform receipt');
  const recovered=engine.snapshot().jobs.find(row=>row.messageId===late.messageId);
  assert.equal(recovered.replyRetryCount,3);assert.equal(recovered.replyRetryTag,true);assert.equal(recovered.replyBodySpaceOffsets.length,3);
  assert.equal(retryAttempts.length,4);assert.equal(retryAttempts[1].mode,'time');assert.equal(retryAttempts[2].mode,'time-tag');
  assert.ok(retryAttempts[2].content.startsWith(recovered.content));assert.equal(recovered.content,engine.snapshot().config.fallback);assert.match(retryAttempts[2].content,/〔消息标记：[A-Z2-9]{6}〕/u);assert.ok(recovered.sentMessageId);
  assert.equal(require('../src/core/reply-suffix.cjs').isValidReplyPayload(recovered.content,retryAttempts[3].content,recovered.replyBodySpaceOffsets),true);
  await evalUi(`document.querySelector('[data-nav="records"]').click();void 0;`);await wait(300);
  await evalUi(`document.querySelector('[data-action="job"][data-id="${recovered.id}"]').click();void 0;`);
  assert.match(await evalUi(`document.querySelector('[data-reply-retry]').textContent`),/3 次重复拒绝.*配置原文保留.*3个普通空格/su);
  assert.match(await evalUi(`document.querySelector('[data-reply-wire]').textContent`),/尾缀编码：\[换行\]\d{4}-/u);
  await evalUi(`document.querySelector('[data-action="close-modal"]').click();void 0;`);
  // A live inquiry inside cooldown must be sent by the 250ms pump after its
  // own deadline, without another periodic pending-list scan.
  engine.updateConfig({...engine.snapshot().config,cooldownSeconds:2});
  const rapidFirst={...message('cooldown-buyer','cooldown-first'),sentAt:Date.now()};platform.data.unreplied.push(rapidFirst);
  const rapidFirstJob=engine.ingestMessage(rapidFirst);
  await until(()=>engine.snapshot().jobs.find(row=>row.id===rapidFirstJob.id)?.status==='sent','first cooldown test reply');
  const scansBeforeCooldown=pendingScans;
  const rapidNext={...message('cooldown-buyer','cooldown-next'),sentAt:Date.now()};platform.data.unreplied.push(rapidNext);
  const rapidWaiting=engine.ingestMessage(rapidNext);
  assert.equal(rapidWaiting.status,'queued');assert.equal(rapidWaiting.reason,'cooldown');assert.ok(rapidWaiting.notBefore>Date.now());
  await evalUi(`refresh(true)`);
  await evalUi(`document.querySelector('[data-action="job"][data-id="${rapidWaiting.id}"]').click();void 0;`);
  assert.match(await evalUi(`document.querySelector('[data-reply-cooldown]').textContent`),/冷却结束后自动核验并发送/u);
  await evalUi(`document.querySelector('[data-action="close-modal"]').click();void 0;`);
  await until(()=>engine.snapshot().jobs.find(row=>row.id===rapidWaiting.id)?.status==='sent','cooldown deadline sends without a maintenance scan');
  const rapidSent=engine.snapshot().jobs.find(row=>row.id===rapidWaiting.id);
  assert.ok(rapidSent.attemptedAt>=rapidWaiting.notBefore);assert.ok(rapidSent.attemptedAt-rapidSent.createdAt<5000);
  assert.equal(rapidSent.catchUp,undefined);assert.ok(rapidSent.sentMessageId);assert.equal(pendingScans,scansBeforeCooldown);
  networkFixture=true;let pageReloads=0;platform.reload=async()=>{pageReloads++;socketReady=true;};
  platform.online=false;const beforeNetworkActions=platform.data.actions.length;
  // Even a stale page with a ready-looking socket must respect the OS offline
  // signal. Exercise the production poll path, without injecting its handler.
  const recoveredAt=Date.now();await assert.rejects(poll(true),/离线/u);await assert.rejects(poll(true),/离线/u);
  await until(()=>startupListener.state.phase==='offline','offline connection remains armed');
  assert.equal(engine.snapshot().config.running,false);assert.equal(pageReloads,0);assert.equal(platform.data.actions.length,beforeNetworkActions);
  const offlineInquiry={...message('offline-recovery-buyer','offline-recovery-inquiry'),sentAt:Date.now()};platform.data.unreplied.push(offlineInquiry);
  platform.online=true;
  await until(()=>engine.snapshot().config.running,'network restoration resumes work without Start');
  await until(()=>engine.snapshot().jobs.some(row=>row.messageId===offlineInquiry.messageId&&row.status==='sent'),'offline inquiry recovered after authenticated reconnect');
  assert.equal(pageReloads,1);assert.equal(socketReady,true);assert.equal(platform.data.actions.length,beforeNetworkActions+1);
  const networkRecoveryMs=Date.now()-recoveredAt;
  platform.online=false;recoverConnection('chat','再次断网');await until(()=>startupListener.state.phase==='offline','second offline wait');
  pause();platform.online=true;await wait(3300);assert.equal(engine.snapshot().config.running,false);assert.equal(startupListener.active,false);assert.equal(pageReloads,1);
  // Cached SDK health can recover while the two surrounding pages remain stale.
  // The visible page refreshes once; background order sessions are reused.
  engine.updateConfig({...engine.snapshot().config,maxPerMinute:120});
  const refreshedKinds=[];platform.pageKinds=['chat','orders'];platform.visibleKind='chat';platform.reload=async kind=>{refreshedKinds.push(kind);socketReady=true;};
  observeNetwork(true);await until(()=>!networkRefresh.timer,'initial online is idle');
  startupListener.arm(engine.snapshot().config);await until(()=>engine.snapshot().config.running,'listen before UI restoration test');
  const writesBeforeRefresh=platform.data.actions.length;
  platform.online=false;observeNetwork(false);platform.online=true;observeNetwork(true);observeNetwork(true);
  await until(()=>networkRefresh.state.phase==='complete'&&engine.snapshot().config.running,'visible page refreshes, background session remains, listening resumes');
  assert.deepEqual(refreshedKinds,['chat']);assert.equal(platform.data.actions.length,writesBeforeRefresh);
  await wait(350);assert.equal(refreshedKinds.length,1);
  await evalUi(`document.querySelector('[data-nav="shop"]').click();void 0;`);await wait(250);
  assert.match(await evalUi(`document.querySelector('[data-page-status]').textContent`),/页面已加载/);
  // An active send receipt must settle before either page is reloaded.
  let releaseSend,sendEntered=false;const mediaBridge=platform.bridge;
  platform.bridge=async(kind,action,payload)=>{if(action==='send'&&payload.job.buyerId==='held-receipt-buyer'){sendEntered=true;await new Promise(resolve=>{releaseSend=resolve;});}return mediaBridge(kind,action,payload);};
  const heldMessage={...message('held-receipt-buyer','held-receipt-message'),sentAt:Date.now()};platform.data.unreplied.push(heldMessage);const heldJob=engine.ingestMessage(heldMessage);
  await until(()=>sendEntered,'send is awaiting its platform receipt');
  observeNetwork(false);observeNetwork(true);await until(()=>networkRefresh.state.phase==='refreshing','refresh waits for in-flight receipt');
  await wait(250);assert.equal(refreshedKinds.length,1);releaseSend();
  await until(()=>engine.snapshot().jobs.find(row=>row.id===heldJob.id)?.status==='sent','held receipt is persisted before reload');
  await until(()=>networkRefresh.state.phase==='complete'&&engine.snapshot().config.running,'refresh resumes after receipt');
  assert.deepEqual(refreshedKinds,['chat','chat']);
  assert.equal(platform.data.actions.filter(row=>row.jobId===heldJob.id&&row.action==='send').length,1);
  platform.bridge=mediaBridge;
  // Manual pause during an outage must remain paused after UI recovery.
  observeNetwork(false);pause();observeNetwork(true);
  await until(()=>networkRefresh.state.phase==='complete','paused pages may refresh');
  assert.equal(engine.snapshot().config.running,false);assert.equal(startupListener.active,false);
  assert.deepEqual(refreshedKinds,['chat','chat','chat']);
  pause();await wait(300);assert.equal(startupListener.state.pending,false);assert.equal(engine.snapshot().config.running,false);
  await evalUi(`document.querySelector('[data-nav="settings"]').click();void 0;`);await wait(300);
  assert.equal(await evalUi(`document.getElementById('autoListenOnLaunch').checked`),true);
  assert.equal(engine.snapshot().config.catchUpUnrepliedEnabled,true);
  assert.equal(await evalUi(`!!document.getElementById('catchUpUnrepliedEnabled')`),false);
  const out=path.resolve(__dirname,'..','work');fs.writeFileSync(path.join(out,'startup-settings.png'),(await window.webContents.capturePage()).toPNG());
  const result={ok:true,assertions:['automatic launch requires no Start click','expired login waits with a visible cancel control','login completion resumes automatically','pending list is paginated','recent history covers pending messages outside the current list','explicit rejection is recovered with the current suffix setting','messages received while closed are recovered','fresh preflight cancels conversations already answered','a newer pending buyer message replaces the stale reply','reconnecting does not duplicate a claimed event','manual pause cancels automatic intent','automatic launch setting persists; pending recovery is built in without another switch'],actualPlatformWrites:0,fixtureWrites:platform.data.actions.length,sourceState:dataDir};
  result.assertions.push('periodic maintenance discovers pending messages outside live chat','duplicate rejection stays queued with a retry time','reopening immediately resumes a pending retry','second rejection preserves the body and adds a message tag','tagged retry success requires an actual fixture receipt','retry history and body-preserving stage are visible in the UI');
  result.assertions.push('fourth attempt adds three safe spaces without replacing configured text','wire details split the body and suffix after inserted spaces');
  result.assertions.push('live cooldown inquiries are durably queued instead of discarded','queued cooldown details show the automatic send deadline','cooldown replies use the dispatch timer without another pending scan');
  result.cooldownReplyWaitMs=rapidSent.attemptedAt-rapidSent.createdAt;
  result.assertions.push('offline sessions preserve intent without repeatedly reloading pages','network restoration reloads and authenticates before recovering missed inquiries','manual pause cancels a mid-session reconnect');
  result.assertions.push('offline polling starts recovery even when cached page health appears ready');
  result.networkRecoveryMs=networkRecoveryMs;result.networkPageReloads=pageReloads;
  result.assertions.push('network restoration refreshes the visible page and preserves the background order session','one recovery wave does not repeatedly refresh healthy pages','UI page status is independent from business connection status','an in-flight send receipt is persisted before refreshing and is never duplicated','manual pause survives automatic page refresh');
  result.refreshedPageKinds=refreshedKinds;
  result.fixtureRejectedAttempts=3;
  fs.writeFileSync(path.join(out,'startup-smoke-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));app.quit();
}
module.exports={run};
