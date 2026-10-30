const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, Tray, Menu, nativeImage, powerSaveBlocker, net, safeStorage, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { Engine, matchProduct, planDelivery, validateConfig, defaults } = require('./core/engine.cjs');
const { validateImages } = require('./core/message-parts.cjs');
const { exportSharedContent, SharedImportDraft } = require('./core/shared-content.cjs');
const { StartupListener } = require('./core/startup-listener.cjs');
const { NetworkRefresh } = require('./core/network-refresh.cjs');
const { CapabilityRecovery, pageRefreshDecision } = require('./core/capability-recovery.cjs');
const { AlertService } = require('./core/alert-service.cjs');
const { connectionSample } = require('./core/alert-health.cjs');
const { CloudWatchdog } = require('./core/cloud-watchdog.cjs');
const { DesktopAlert } = require('./desktop-alert.cjs');
const { allowedUrl, defaultProfile, validateProfile, makeScript } = require('./platform/page-adapter.cjs');
const { makeOfficialScript, summarizeOfficial } = require('./platform/pdd-official.cjs');
const { makeOrdersScript } = require('./platform/pdd-orders.cjs');
const { makeBridgeScript } = require('./platform/pdd-bridge.cjs');
const { attachPopupGuard } = require('./platform/pdd-popups.cjs');
const { makePageStatusScript } = require('./platform/page-status.cjs');
const capabilitySmoke = !app.isPackaged && process.argv.includes('--capability-smoke');
const startupSmoke = !app.isPackaged && process.argv.includes('--startup-smoke');
const layoutSmoke = !app.isPackaged && process.argv.includes('--layout-smoke');
const sharedRulesSmoke = !app.isPackaged && process.argv.includes('--shared-rules-smoke');
const liveSettingsSmoke = !app.isPackaged && process.argv.includes('--live-settings-smoke');
const cloudWatchdogSmoke = !app.isPackaged && process.argv.includes('--cloud-watchdog-smoke');
const liveWireAudit = !app.isPackaged && process.argv.includes('--audit-live-wire');
const pendingReplyAudit = !app.isPackaged && process.argv.includes('--audit-live-pending');
const catchUpReadOnly = !app.isPackaged && process.argv.includes('--catchup-readonly');
const networkReadOnly = !app.isPackaged && process.argv.includes('--network-readonly');
const imageUploadAudit = !app.isPackaged && process.argv.includes('--image-upload-audit');
const popupCleanupAudit = !app.isPackaged && process.argv.includes('--popup-cleanup-audit');
const receiptReadOnly = !app.isPackaged && process.argv.includes('--receipt-readonly');
const smokeMode = !app.isPackaged && (process.argv.includes('--smoke-test') || startupSmoke || layoutSmoke || capabilitySmoke || sharedRulesSmoke || liveSettingsSmoke || cloudWatchdogSmoke);
const platformReadOnly = !app.isPackaged && process.argv.includes('--platform-readonly');
const workflowReadOnly = !app.isPackaged && process.argv.includes('--workflow-readonly');
const readOnlyDiagnostic = !app.isPackaged && (process.argv.includes('--read-only-diagnostic') || platformReadOnly || workflowReadOnly || catchUpReadOnly || networkReadOnly || popupCleanupAudit || receiptReadOnly);
if (smokeMode) app.disableHardwareAcceleration();

let window, tray, trayMenu, engine, profile, dataDir, selectedKind = 'chat', browserVisible = false, closing = false, polling = false, timer, blocker;
let startedAt = 0;
let stateRevision=0;
let testPlatform=null;
const sharedImport = new SharedImportDraft();
let connectedShopId = '', dispatching = false, dispatchTimer, pendingReplyTimer;
let orderPage = 1, refundPage = 1;
let bridgeAvailable=false, pollFailures=0, nextPollAt=0;
const capabilityRecovery=new CapabilityRecovery(smokeMode?{intervals:{orders:250,refunds:250},retryBase:250,retryMax:1000,verificationDelay:500}:{});
const capabilityBusy=new Set();
let reconciling=false;
const reconciliationChecks = new Map();
const bridgeDiagnostics = { chat: {ready:false}, orders: {ready:false}, refunds: {ready:false} };
let attachedKind = null;
const views = new Map();
const seenMessages = new Set();
const seenOrders = new Map();
const observedBuyers = new Set();
const sessionQueue = new Set();
let runNonce = 0;
let writeNonce = 0;
let startupListener, startPromise, catchUpTimer, catchUpToken = 0, catchUpCollecting = false;
let listenIntent = false, recoveryShopId = '', connectFailures = 0;
let networkRefresh, networkTimer, rendererOnline, networkRefreshBusy = false;
let phoneAlerts,phoneAlertTimer,desktopAlert,cloudWatchdog;
let lastPageStatusCheck = 0;
const pageStates = {}, lastPageLoadedAt = new Map();
const pagesToRecover = new Set(), lastPageRecovery = new Map();
let catchUpState = { phase: 'idle', scanned: 0, candidates: 0, created: 0, skipped: 0 };
const diagnostics = { chat: { ready: false, message: '尚未打开官方客服页面' }, orders: { ready: false, message: '尚未打开官方订单页面' }, notes: [] };
let officialInspection = { ready: false, readOnly: true, issue: '尚未检测官方客服数据' };
let officialOrdersInspection = { ready: false, readOnly: true, issue: '尚未检测官方订单数据' };
let bindingShopId = '';
const officialOrderBindings = new Map();
const entryUrls = { chat: 'https://mms.pinduoduo.com/chat-merchant/index.html', orders: 'https://mms.pinduoduo.com/orders/list' };
const uiUrl = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('本地数据文件无法读取：' + file + '。文件已保留，请从备份恢复。'); }
}
function writeJson(file, value) {
  const temp = file + '.tmp';
  const fd = fs.openSync(temp, 'w');
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.backup');
  fs.renameSync(temp, file);
}
function note(message) {
  if (diagnostics.notes.at(-1)?.message === message) return;
  diagnostics.notes.push({ message, time: Date.now() });
  diagnostics.notes = diagnostics.notes.slice(-100);
  changed();
}
function recordPopupCleanup(value) {
  const types = { feature_tour: '客服新功能引导', desktop_tip: 'Win 工作台提示', notification_tip: '浏览器通知提示', feature_notice: '客服功能介绍弹窗', guard: '客服弹窗检查' };
  const outcomes = { dismissed: '已自动关闭', still_visible: '关闭后仍显示，将继续检查', handler_failed: '关闭按钮执行失败，将继续检查', needs_person: '涉及验证或确认，已保留', missing_close: '未找到明确的关闭按钮，已保留', check_failed: '暂时无法读取，将继续检查' };
  for (const event of value.events || []) {
    if (!types[event.type] || !outcomes[event.outcome]) continue;
    const message = types[event.type] + '：' + outcomes[event.outcome];
    note(message);
    const item = { at: new Date().toISOString(), type: event.type, outcome: event.outcome };
    try {
      const log = path.join(dataDir, 'popup-cleanup.jsonl');
      if (fs.existsSync(log) && fs.statSync(log).size > 1024 * 1024) { fs.copyFileSync(log, log + '.previous'); fs.writeFileSync(log, ''); }
      fs.appendFileSync(log, JSON.stringify(item) + '\n');
    } catch { note('客服弹窗日志暂时无法保存。'); }
  }
}
function snapshot() {
  return { ...engine.snapshot(), revision:stateRevision, readOnly:readOnlyDiagnostic, cloudWatchdog:cloudWatchdog?.snapshot()||null, phoneAlerts:phoneAlerts?.snapshot()||null, autoStart: startupListener?.state || {phase:'idle',pending:false}, catchUp: catchUpState, connection: { profile, diagnostics, bridge: bridgeDiagnostics, network: networkRefresh?.state, pages: pageStates, shopId: connectedShopId, officialInspection, officialOrdersInspection, urls: Object.fromEntries([...views].map(([kind, view]) => [kind, view.webContents.getURL()])), coverage: '客服监听新消息，启动时分页核验近七天的待回复会话；订单与售后由官方接口分页扫描，执行结果以平台回执为准。' }, version: app.getVersion(), startup: app.getLoginItemSettings().openAtLogin, dataDir };
}
function changed() { stateRevision++; if (!closing && window && !window.isDestroyed() && engine) window.webContents.send('state:changed'); }
function showWorkbench() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
}
function trusted(event) { if (closing || !window || window.isDestroyed() || event.sender.isDestroyed() || event.sender !== window.webContents || !event.sender.getURL().startsWith(uiUrl)) throw new Error('工作台已退出或调用页面无效'); }
function pause(reason, { keepAutoStart = false } = {}) {
  if (!keepAutoStart) { listenIntent = false; recoveryShopId = ''; pagesToRecover.clear(); startupListener?.stop(); }
  clearTimeout(catchUpTimer); catchUpTimer = undefined; catchUpToken++; catchUpCollecting = false;
  runNonce += 1;
  invalidatePendingWrites();
  if (engine?.snapshot().config.running) engine.setRunning(false);
  if (blocker && powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker);
  blocker = undefined;
  if (reason) note(reason);
  changed();
}
function invalidatePendingWrites(){
  writeNonce++;
  for(const view of views.values())if(!view.webContents.isDestroyed()&&allowedUrl(view.webContents.getURL()))view.webContents.executeJavaScript(`globalThis.__localDeliveryRunNonce=${JSON.stringify(writeNonce)}`).catch(()=>{});
}
function applyLiveConfig(value,{startup}={}){
  const previous=engine.snapshot().config;
  const config=validateConfig({...value,running:previous.running});
  if(startup!==undefined&&typeof startup!=='boolean')throw Error('开机启动设置格式不正确');
  if(typeof startup==='boolean'&&startup!==app.getLoginItemSettings().openAtLogin)app.setLoginItemSettings({openAtLogin:startup});
  if(JSON.stringify(previous)!==JSON.stringify(config)){
    engine.updateConfig(config);invalidatePendingWrites();
    const deliveryKeys=['products','suffix','deliveryFallback','deliveryFallbackEnabled','deliveryFallbackImages','separateLinksEnabled','autoDeliveryEnabled','autoConfirmShipmentEnabled'];
    if(deliveryKeys.some(key=>JSON.stringify(previous[key])!==JSON.stringify(config[key])))seenOrders.clear();
    const missingLegacyReply=engine.snapshot().jobs.some(job=>job.type==='reply'&&job.status==='cancelled'&&job.reason==='rules_changed'&&job.updatedAt>=Date.now()-1000);
    if(config.running&&config.autoReplyEnabled&&(!previous.autoReplyEnabled||missingLegacyReply))void maintainPendingReplies(true).catch(error=>note('设置已保存，待回复检查稍后重试：'+error.message));
  }
  changed();return snapshot();
}
const needsPerson = message => /滑块|安全验证|扫码|登录已过期|请先.*登录|账户.*别处/.test(message);
function recoverConnection(kind = 'chat', message = '官方连接中断', { reload = true } = {}) {
  if (closing || readOnlyDiagnostic && !networkReadOnly || !listenIntent && !engine?.snapshot().config.running && !startupListener?.active) return;
  if (networkRefreshBusy) return;
  if(kind==='orders') {
    recordCapabilityFailure('orders',new Error(message));
    if(reload)pagesToRecover.add('orders');
    return;
  }
  listenIntent = true;
  if (!recoveryShopId) recoveryShopId = connectedShopId;
  if (reload) pagesToRecover.add(kind);
  bridgeAvailable = false;
  bridgeDiagnostics[kind] = { ready: false, reason: message };
  diagnostics[kind] = { ready: false, message, checkedAt: Date.now() };
  if (!startupListener?.active) {
    pause('连接中断，正在自动恢复页面与监听。', { keepAutoStart: true });
    startupListener?.recover(engine.snapshot().config);
  }
  changed();
}
async function recoverPages(onlyKind='chat') {
  if (networkRefreshBusy) throw new Error('网络已恢复，正在刷新官方页面，请稍候');
  const online = smokeMode ? testPlatform?.online !== false : net.isOnline();
  if (!online) throw new Error('电脑处于离线状态，网络恢复后将自动继续');
  for (const kind of [...pagesToRecover]) {
    if(kind!==onlyKind)continue;
    if (Date.now() - (lastPageRecovery.get(kind) || 0) < 30000) continue;
    if (!listenIntent || closing) throw new Error('已手动停止自动连接');
    if (smokeMode) {
      pagesToRecover.delete(kind);lastPageRecovery.set(kind, Date.now());
      if (testPlatform.reload) await testPlatform.reload(kind);
      continue;
    }
    const wc = ensureView(kind).webContents;
    let human = false;
    try {
      human = /\/login\/?|\/auth\//.test(new URL(wc.getURL()).pathname);
      if (!human && allowedUrl(wc.getURL())) human = await Promise.race([
        wc.executeJavaScript(`['滑块','安全验证'].some(word=>(document.body?.innerText || '').includes(word))`),
        new Promise(resolve=>setTimeout(()=>resolve(false),1500))
      ]);
    } catch {}
    pagesToRecover.delete(kind);
    if (human) continue;
    lastPageRecovery.set(kind, Date.now());
    try { await readWithTimeout(wc.loadURL(entryUrls[kind]), kind); }
    catch(error) { lastPageRecovery.delete(kind);pagesToRecover.add(kind);throw error; }
  }
}
function recordNetworkRecovery(event) {
  try {
    const file = path.join(dataDir, 'network-recovery.jsonl');
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) { fs.copyFileSync(file, file + '.previous'); fs.writeFileSync(file, ''); }
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
  } catch { note('网络恢复日志暂时无法保存。'); }
}
async function updatePageState(kind, wc) {
  if (wc.isDestroyed() || !allowedUrl(wc.getURL())) return;
  try {
    const status = await wc.executeJavaScript(makePageStatusScript(), false);
    if (wc.isDestroyed()) return;
    pageStates[kind] = { phase: status.login || status.verification ? 'needs_person' : 'loaded', login: status.login, verification: status.verification, checkedAt: Date.now() };
    changed();
  } catch {}
}
async function refreshPagesAfterNetwork(context) {
  if (closing || readOnlyDiagnostic && !networkReadOnly) return { pages: [] };
  const kinds = smokeMode ? (testPlatform?.pageKinds || []) : [...views.keys()];
  if (!kinds.length) return { pages: [] };
  networkRefreshBusy = true;
  const resume = listenIntent || engine.snapshot().config.running || startupListener?.active;
  if (resume) {
    listenIntent = true;
    if (!recoveryShopId) recoveryShopId = connectedShopId;
    startupListener?.stop('reconnecting');
    pause('网络已恢复，正在自动刷新官方页面。', { keepAutoStart: true });
  }
  const pages = []; let failed = false;
  try {
    const deadline = Date.now() + 40000;
    while (dispatching || polling || capabilityBusy.size || reconciling || startPromise) {
      if (closing || !context.isCurrent()) return { pages };
      if (Date.now() >= deadline) return { deferred: true, pages };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (closing || !context.isCurrent()) return { pages };
    for (const kind of kinds) {
      if (closing || !context.isCurrent()) break;
      // An ordinary recovery/manual refresh may already have refreshed this page.
      if ((lastPageLoadedAt.get(kind) || 0) >= context.onlineAt) { pages.push({ kind, outcome: 'already_refreshed' }); continue; }
      try {
        let status;
        if(smokeMode)status=testPlatform.pageStatus?.[kind] || {};
        else {
          const wc=views.get(kind)?.webContents;
          if(!wc || wc.isDestroyed())continue;
          try {status=await Promise.race([wc.executeJavaScript(makePageStatusScript(),false),new Promise(resolve=>setTimeout(()=>resolve({}),1500))]);}catch{}
          if(allowedUrl(wc.getURL()) && /\/(?:login|auth)(?:\/|$)/.test(new URL(wc.getURL()).pathname))status={...status,login:true};
        }
        const visibleKind=smokeMode?testPlatform.visibleKind:(browserVisible?selectedKind:null);
        const decision=pageRefreshDecision({kind,visibleKind,healthy:bridgeDiagnostics[kind]?.ready,status,recoveryRequested:pagesToRecover.has(kind)});
        if(decision!=='refresh') {
          if(status?.login || status?.verification)pageStates[kind]={phase:'needs_person',login:!!status.login,verification:!!status.verification,checkedAt:Date.now()};
          else if(status?.hasDraft)pageStates[kind]={phase:'draft',checkedAt:Date.now()};
          pages.push({kind,outcome:decision});changed();continue;
        }
        pageStates[kind] = { phase: 'refreshing', checkedAt: Date.now() }; changed();
        if (smokeMode) {
          await testPlatform.reload?.(kind);
          lastPageLoadedAt.set(kind, Date.now());
          pageStates[kind] = { phase: 'loaded', checkedAt: Date.now() };
        } else {
          const wc = views.get(kind)?.webContents;
          if (!wc || wc.isDestroyed()) continue;
          const url = wc.getURL();
          if (allowedUrl(url) && /\/(?:login|auth)(?:\/|$)/.test(new URL(url).pathname)) {
            pageStates[kind] = { phase: 'needs_person', login: true, checkedAt: Date.now() };
            pages.push({ kind, outcome: 'login_preserved' }); continue;
          }
          await readWithTimeout(wc.loadURL(allowedUrl(url) ? url : entryUrls[kind]), kind);
          lastPageLoadedAt.set(kind, Date.now());
          await updatePageState(kind, wc);
        }
        lastPageRecovery.set(kind, Date.now()); pagesToRecover.delete(kind);
        pages.push({ kind, outcome: pageStates[kind]?.phase === 'needs_person' ? 'verification_required' : 'refreshed' });
      } catch {
        failed = true; pageStates[kind] = { phase: 'failed', checkedAt: Date.now() };
        pages.push({ kind, outcome: 'load_failed' });
      }
    }
    recordNetworkRecovery({ event: 'refresh_completed', cycle: context.cycle, pages });
    note(failed ? '网络已恢复，部分官方页面刷新失败，连接恢复检查将继续。' : '网络已恢复，官方页面刷新检查完成。');
    return { pages, failed };
  } finally {
    networkRefreshBusy = false; changed();
    if (resume && listenIntent && !closing && context.isCurrent()) startupListener?.recover(engine.snapshot().config);
  }
}
function observeNetwork(online) {
  networkRefresh?.observe(online);
  if (!online) recoverConnection('chat', '电脑处于离线状态，网络恢复后将自动刷新页面', { reload: false });
}
async function readWithTimeout(pending, kind, write = false) {
  let timer;
  try { return await Promise.race([pending,new Promise((_,reject)=>{
    timer=setTimeout(()=>{const error=new Error(write?'平台操作回执超时，先核实实际结果':`官方${kind==='orders'?'订单':'客服'}读取超时`);error.code='read_timeout';error.kind=kind;reject(error);},smokeMode?1000:write?30000:20000);
  })]); } finally { clearTimeout(timer); }
}
function ensureView(kind) {
  if (!['chat', 'orders'].includes(kind)) throw new Error('未知商家页面');
  if (views.has(kind)) return views.get(kind);
  if (smokeMode) {
    const fixture=require('../scripts/layout-smoke.cjs').createView(kind);views.set(kind,fixture);return fixture;
  }
  const view = new WebContentsView({ webPreferences: { partition: 'persist:pdd-workbench-main', preload: kind==='chat'?path.join(__dirname,'platform','pdd-socket-preload.cjs'):undefined, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false } });
  const wc = view.webContents;
  // Keep a real layout even before the customer-service tab is first shown.
  if (kind === 'chat') view.setBounds({ x: 0, y: 0, width: 1200, height: 800 });
  if (kind === 'chat' && (!readOnlyDiagnostic || popupCleanupAudit) && !imageUploadAudit) attachPopupGuard(wc, recordPopupCleanup);
  let navigationTimer;
  const clearNavigationTimer=()=>{clearTimeout(navigationTimer);navigationTimer=undefined;};
  wc.on('did-start-loading',()=>{
    clearNavigationTimer();
    navigationTimer=setTimeout(()=>{
      if(wc.isDestroyed() || !wc.isLoading() || readOnlyDiagnostic&&!networkReadOnly || !listenIntent&&!startupListener?.active)return;
      wc.stop();recoverConnection(kind,'官方页面加载超时，正在自动恢复');
    },20000);
  });
  wc.on('did-stop-loading',clearNavigationTimer);
  wc.on('did-finish-load', () => { lastPageLoadedAt.set(kind, Date.now()); void updatePageState(kind, wc); });
  wc.on('did-navigate-in-page', () => { void updatePageState(kind, wc); });
  wc.on('destroyed',clearNavigationTimer);
  wc.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  wc.session.setPermissionCheckHandler(() => false);
  wc.setWindowOpenHandler(({ url }) => {
    if (allowedUrl(url)) { wc.loadURL(url).catch(e => note('官方页面跳转失败：' + e.message)); }
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => { if (!allowedUrl(url)) { event.preventDefault(); note('已保留当前商家页面，外部链接请在常用浏览器中手动打开。'); } });
  wc.on('will-redirect', (event, url) => { if (!allowedUrl(url)) event.preventDefault(); });
  wc.on('did-navigate', () => {
    diagnostics[kind] = { ready: false, message: '页面已变化，等待重新校验' };
    if (kind === 'chat') officialInspection = { ready: false, readOnly: true, issue: '客服页面已变化，请重新检测' };
    if (kind === 'orders') officialOrdersInspection = { ready: false, readOnly: true, issue: '订单页面已变化，请重新检测' };
    changed();
  });
  wc.on('render-process-gone', () => recoverConnection(kind, '商家页面进程退出，正在自动恢复'));
  wc.on('did-fail-load', (_e, code, desc, _url, mainFrame) => { if (mainFrame && code !== -3) recoverConnection(kind, '官方页面加载失败：' + desc); });
  views.set(kind, view);
  wc.loadURL(entryUrls[kind]).catch(e => note('官方页面暂未加载：' + e.message));
  return view;
}
async function evaluate(kind, action, payload = {}) {
  const view = ensureView(kind); const wc = view.webContents;
  if (!allowedUrl(wc.getURL())) throw new Error('官方页面尚未就绪，请打开后手动登录');
  return wc.executeJavaScript(makeScript(action, profile, { ...payload, kind }), false);
}
async function bridge(kind, action, payload={}) {
  let pending,wc;
  if (smokeMode) {
    if (!testPlatform) throw new Error('本地测试未配置模拟平台，禁止连接真实平台');
    pending=testPlatform.bridge(kind,action,payload);
  } else {
    if (readOnlyDiagnostic && (payload.allowWrite || payload.allowAssetUpload) || imageUploadAudit && payload.allowWrite) throw new Error('当前联调已锁定平台业务写入');
    wc=ensureView(kind).webContents;
    if (!allowedUrl(wc.getURL())) throw new Error('官方页面尚未加载，请先登录');
    pending=wc.executeJavaScript(makeBridgeScript(action,{...payload,expectedShopId:payload.expectedShopId || connectedShopId}),false);
  }
  if(payload.allowWrite)return readWithTimeout(pending,kind,true);
  let timeout;
  try {
    return await Promise.race([pending,new Promise((_,reject)=>{timeout=setTimeout(()=>{
      const error=new Error(`官方${kind==='orders'?'订单':'客服 / 售后'}读取超时，请检查官方页面后重试`);error.code='read_timeout';reject(error);
    },smokeMode?1000:20000);})]);
  } catch(error) {
    if(error.code==='read_timeout' && wc && kind==='orders') {
      let checkTimer;
      try {
        const needsVerification=await Promise.race([wc.executeJavaScript(`['滑块','安全验证'].some(word=>(document.body?.innerText || '').includes(word))`),new Promise(resolve=>{checkTimer=setTimeout(()=>resolve(false),2000);})]);
        if(needsVerification)error=new Error('官方订单页需要完成滑块验证，请本人完成验证，自动连接会继续重试');
      } finally {clearTimeout(checkTimer);}
    }
    error.kind=kind;
    throw error;
  } finally {clearTimeout(timeout);}
}
async function officialChat() {
  if (smokeMode) {
    if (!testPlatform) throw new Error('本地测试禁止连接真实客服');
    return readWithTimeout(Promise.resolve().then(()=>testPlatform.chat()),'chat');
  }
  const wc=ensureView('chat').webContents;
  if (!allowedUrl(wc.getURL())) throw new Error('请先在官方客服页面登录');
  const value=await readWithTimeout(wc.executeJavaScript(makeOfficialScript(),false),'chat');
  if (!value.ready) throw new Error(value.issue || '官方客服未就绪');
  if (connectedShopId && connectedShopId!==value.shopId && engine.snapshot().config.running) throw new Error('登录店铺已变化，自动处理已暂停');
  return value;
}
async function readyFor(kind,read) {
  if(smokeMode)return read();
  const wc=ensureView(kind).webContents;
  bridgeDiagnostics[kind]={ready:false,reason:'正在加载并检测官方页面…'};changed();
  if(wc.isLoading())await new Promise(resolve=>{
    const done=()=>{clearTimeout(timeout);wc.removeListener('did-stop-loading',done);resolve();};
    const timeout=setTimeout(done,15000);wc.once('did-stop-loading',done);
  });
  const deadline=Date.now()+15000;let lastError;
  do {
    const pathname=(()=>{try{return new URL(wc.getURL()).pathname;}catch{return '';}})();
    if(/\/login\/?|\/auth\//.test(pathname))throw new Error('官方登录已过期，请在店铺工作台扫码登录');
    try{return await read();}catch(error){lastError=error;}
    await new Promise(resolve=>setTimeout(resolve,500));
  }while(Date.now()<deadline);
  bridgeDiagnostics[kind]={ready:false,reason:lastError?.message || '官方页面尚未就绪'};changed();
  throw lastError || new Error('官方页面尚未就绪');
}
async function checkBridge({includeCapabilities=false}={}) {
  const chat=await readyFor('chat',()=>officialChat());
  if(recoveryShopId && chat.shopId!==recoveryShopId) { pause('断线恢复时发现店铺变化，已暂停自动处理。'); throw new Error('当前店铺与断线前不一致，已暂停'); }
  connectedShopId=chat.shopId;
  bridgeDiagnostics.chat=await bridge('chat','health');
  if (!bridgeDiagnostics.chat.ready) throw new Error(bridgeDiagnostics.chat.reason || '官方消息组件未就绪');
  const config=engine.snapshot().config;
  if((config.autoReplyEnabled||config.autoDeliveryEnabled)&&bridgeDiagnostics.chat.canSendViaSocket===false) {
    bridgeDiagnostics.chat={...bridgeDiagnostics.chat,ready:false,reason:'官方发送连接未恢复，正在自动重新连接'};
    throw new Error('官方发送连接尚未认证完成，正在自动重新连接');
  }
  if((config.autoReplyEnabled||config.autoDeliveryEnabled)&&bridgeDiagnostics.chat.canUseOfficialReceiptPipeline===false)throw new Error('官方消息回执处理组件尚未就绪，正在等待加载');
  diagnostics.chat={ready:true,message:`已识别官方客服：${chat.conversations.length} 个已加载会话`,checkedAt:Date.now()};
  // Order/refund reads run independently after chat authentication. A blocked
  // order page must never prevent healthy customer-service replies from starting.
  if(includeCapabilities)await Promise.allSettled(['orders','refunds'].map(async kind=>{
    if(kind==='orders'?!config.autoDeliveryEnabled:!(config.autoDeliveryEnabled||config.autoRefundEnabled))return;
    if(capabilityBusy.has(kind))return;
    capabilityBusy.add(kind);
    try {
      const value=await bridge(kind==='orders'?'orders':'chat',kind==='orders'?'waiting':'refunds',{page:1});
      if(!value.ready)throw new Error(value.reason || '官方功能暂不可用');
      bridgeDiagnostics[kind]={...capabilityRecovery.success(kind),total:value.total};
    }catch(error){recordCapabilityFailure(kind,error);}
    finally {capabilityBusy.delete(kind);}
  }));
  changed(); return snapshot();
}
async function probe(kind) {
  const result = await evaluate(kind, 'probe');
  const issues = result.issues || [result.issue].filter(Boolean);
  diagnostics[kind] = { ready: !!result.ready, message: result.ready ? (kind === 'chat' ? '当前会话字段校验通过' : `当前页读取到 ${result.orders.length} 条订单`) : issues.join('；'), checkedAt: Date.now(), buyer: result.chat?.buyerName, orderCount: result.orders?.length || 0 };
  changed();
  return result;
}
async function inspectOfficial(kind = 'chat') {
  if (!['chat', 'orders'].includes(kind)) throw new Error('未知检测页面');
  const wc = ensureView(kind).webContents;
  const url = new URL(wc.getURL() || 'about:blank');
  if (url.origin !== 'https://mms.pinduoduo.com' || !(kind === 'chat' ? url.pathname.startsWith('/chat-merchant/') : url.pathname === '/orders/list')) throw new Error('请先打开对应官方页面并由你手动登录');
  const value = await wc.executeJavaScript(kind === 'chat' ? makeOfficialScript() : makeOrdersScript(), false);
  if (kind === 'chat') {
    if (!value.ready || value.shopId !== bindingShopId) officialOrderBindings.clear();
    bindingShopId = value.ready ? value.shopId : '';
    if (value.ready) for (const reference of value.orderReferences || []) {
      const previous = officialOrderBindings.get(reference.orderId);
      const conflict = reference.conflict || previous && (previous.buyerId !== reference.buyerId || previous.title !== reference.title || previous.conflict);
      officialOrderBindings.set(reference.orderId, { ...reference, conflict: !!conflict, checkedAt: Date.now() });
    }
  } else if (bindingShopId && officialInspection.ready) {
    for (const order of value.orders || []) {
      const binding = officialOrderBindings.get(order.orderId);
      if (binding && !binding.conflict && Date.now() - binding.checkedAt < 300000 && binding.title === order.title && (!order.buyerId || order.buyerId === binding.buyerId)) {
        order.buyerId = binding.buyerId;
        order.issues = order.issues.filter(issue => issue !== '订单未提供稳定买家编号');
      }
    }
  }
  const summary = summarizeOfficial(value);
  summary.orderSamples = summary.orderSamples.map(order => {
    const match = matchProduct(order.title, engine.snapshot().config.products);
    return { ...order, match: match.status, matchName: match.product?.name || '' };
  });
  if (kind === 'chat') officialInspection = summary;
  else officialOrdersInspection = summary;
  changed();
  return summary;
}
function hideViews() { for (const view of views.values()) { try { window.contentView.removeChildView(view); } catch {} } attachedKind = null; }
function showView(kind, bounds) {
  if (browserVisible && attachedKind === kind) { selectedKind = kind; if (bounds) setBounds(bounds); return; }
  selectedKind = kind; browserVisible = true;
  hideViews();
  const view = ensureView(kind);
  if (!setBounds(bounds)) return;
  window.contentView.addChildView(view);
  attachedKind = kind;
}
function setBounds(bounds) {
  if (!browserVisible || !views.has(selectedKind)) return false;
  const [width, height] = window.getContentSize();
  const b = Object.fromEntries(['x','y','width','height'].map(k => [k, Math.round(Number(bounds?.[k]))]));
  if (Object.values(b).some(v => !Number.isFinite(v)) || b.x < 180 || b.y < 80 || b.width < 100 || b.height < 100 || b.x + b.width > width || b.y + b.height > height) { hideViews(); return false; }
  const view=views.get(selectedKind);view.setBounds(b);view.setVisible(true);return true;
}
async function transport(job) {
  if (readOnlyDiagnostic || imageUploadAudit) return {status:'rejected',reason:'联调已锁定所有平台业务写入'};
  const nonce=runNonce,writeVersion=writeNonce;
  if(capabilityRecovery.excludedTypes({chatReady:bridgeAvailable}).includes(job.type))return {status:'deferred',reason:'所需官方功能正在恢复，任务已保留等待重试'};
  let current;
  try { current=await officialChat(); } catch(error) { return {status:'deferred',reason:error.message}; }
  if (!engine.snapshot().config.running) return {status:'deferred',reason:'已暂停，尚未提交平台操作'};
  if (current.shopId!==job.shopId) return {status:'rejected',reason:'当前店铺与任务不一致'};
  if (job.messageParts?.some(part=>part.kind==='image' && part.image.shopId!==job.shopId)) return {status:'rejected',reason:'附加图片来自另一店铺，请在本店重新选择并上传图片'};
  if (job.parentJobId) {
    const parent=engine.snapshot().jobs.find(row=>row.id===job.parentJobId);
    const partIndex=parent?.partJobIds?.indexOf(job.id),part=parent?.messageParts?.[partIndex];
    if (!parent || parent.status!=='sent' || parent.shopId!==job.shopId || parent.buyerId!==job.buyerId || !part || part.kind!==job.partKind || part.content!==job.content) return {status:'skipped',reason:'附加消息与已发送正文不一致'};
    if (job.partKind==='image' && job.image.shopId!==job.shopId) return {status:'rejected',reason:'图片来自另一店铺，请重新上传'};
    if (job.attachmentRetryCount) {
      let checked;
      try {checked=await bridge('chat','attachment-check',{job,allowPrevious:true});} catch(error) {return {status:'deferred',reason:error.message};}
      if (!checked.ready) return {status:'deferred',reason:checked.reason || '正在核实链接或图片是否已送达'};
      if (checked.status==='confirmed') return {status:'confirmed',messageId:checked.messageId};
      if (!['not_sent','not_found'].includes(checked.status)) return {status:'deferred',reason:checked.reason || '等待消息同步后重试'};
    }
  }
  if (job.type === 'reply' && job.needsReplyVerification && !job.parentJobId) {
    let check;
    try { check = await bridge('chat','reply-check',{buyerId:job.buyerId}); }
    catch(error) { return {status:'deferred',reason:error.message}; }
    if (!check.ready) return {status:'deferred',reason:check.reason || '暂时无法核验待回复会话'};
    let ownFollowup=false;
    if(!check.pending && !job.catchUp) {
      const ownReplyMessageIds=engine.snapshot().jobs.filter(row=>row.id!==job.id&&row.type==='reply'&&row.status==='sent'&&row.shopId===job.shopId&&row.buyerId===job.buyerId&&row.messageId===job.messageId&&row.sentMessageId).map(row=>row.sentMessageId).slice(-20);
      if(ownReplyMessageIds.length) {
        let followup;
        try{followup=await bridge('chat','reply-followup-check',{buyerId:job.buyerId,sourceMessageId:job.messageId,ownReplyMessageIds});}
        catch(error){return {status:'deferred',reason:error.message};}
        if(!followup.ready)return {status:'deferred',reason:followup.reason||'暂时无法核验后续答复'};
        ownFollowup=followup.allowFollowup===true;
      }
    }
    if (!ownFollowup && (!check.pending || check.message?.messageId !== job.messageId)) {
      if (check.pending && check.message && engine.snapshot().config.running && nonce===runNonce) engine.recoverUnrepliedMessage(check.message);
      return {status:'skipped',reason:'会话已有回复或出现新消息，已取消旧答复'};
    }
  }
  if (['delivery','shipment'].includes(job.type)) {
    let value;
    try { value=await bridge('orders','order',{orderId:job.orderId}); } catch(error) {recordCapabilityFailure('orders',error);return {status:'deferred',reason:error.message};}
    if(!value.ready)recordCapabilityFailure('orders',new Error(value.reason || '订单核验暂不可用'));
    if (!value.ready || !value.order) return {status:'deferred',reason:value.reason || '暂时无法核验当前订单，尚未提交操作'};
    const order=value.order;
    if (job.type==='shipment' && order.shipped && !order.refunded && !order.cancelled) return {status:'confirmed',alreadyCompleted:true};
    if (!order.eligible || order.buyerId!==job.buyerId) return {status:'skipped',reason:'订单已退款、已取消、非待发货或买家编号不一致'};
    if (job.type==='delivery' && !job.parentJobId) {
      const match=planDelivery(order,engine.snapshot().config);
      if (!match.deliverable || match.productId!==job.productId || match.fallback!==!!job.deliveryFallback || match.content!==job.content) return {status:'skipped',reason:'商品名称、SKU 或发货内容已变化，请重新核对'};
    }
  }
  if (!engine.snapshot().config.running || nonce!==runNonce || writeVersion!==writeNonce || capabilityRecovery.excludedTypes({chatReady:bridgeAvailable}).includes(job.type)) return {status:'deferred',reason:'设置或连接已变化，尚未提交操作，将按最新状态重试'};
  const kind=job.type==='shipment'?'orders':'chat';
  if (!smokeMode) try { await ensureView(kind).webContents.executeJavaScript(`globalThis.__localDeliveryRunNonce=${JSON.stringify(writeVersion)}`); } catch(error) {return {status:'deferred',reason:error.message};}
  if (!engine.snapshot().config.running || nonce!==runNonce || writeVersion!==writeNonce || !bridgeAvailable) return {status:'deferred',reason:'设置或连接已变化，尚未提交操作'};
  let imagePreview;
  if (job.partKind==='image') {
    const file=path.join(dataDir,'assets',job.image.id+(job.image.mime==='image/png'?'.png':'.jpg'));
    if (fs.existsSync(file)) imagePreview=nativeImage.createFromPath(file).resize({width:Math.min(300,job.image.width)}).toDataURL();
  }
  return bridge(kind,job.type==='shipment'?'ship':job.type==='refund'?'refund':'send',{job,imagePreview,allowWrite:true,runNonce:writeVersion});
}
function recordCapabilityFailure(kind,error) {
  if(/店铺.*变化|店铺.*不一致/.test(error.message)) {pause('店铺变化，已暂停自动处理。');return;}
  const previous=capabilityRecovery.state(kind),state=capabilityRecovery.failure(kind,error);
  bridgeDiagnostics[kind]={...state};
  // Bound disk writes during persistent failures; retain transitions and the
  // first error, then one diagnostic entry per five minutes.
  if(previous.ready || previous.reason!==state.reason || !previous.loggedAt || Date.now()-previous.loggedAt>=300000) {
    const message=`${kind==='orders'?'订单 / 发货':'售后 / 退款'}暂不可用，${Math.ceil((state.retryAt-Date.now())/1000)} 秒后自动检查；客服独立运行：${state.reason}`;
    note(message);recordNetworkRecovery({event:'capability_failed',kind,reason:state.reason,retryAt:state.retryAt});state.loggedAt=Date.now();
  } else state.loggedAt=previous.loggedAt;
  changed();
}
async function pollCapability(kind) {
  const config=engine.snapshot().config;
  if(networkRefreshBusy || !config.running || !bridgeAvailable || capabilityBusy.has(kind) || !capabilityRecovery.due(kind))return;
  if(kind==='orders'?!config.autoDeliveryEnabled:!(config.autoRefundEnabled||config.autoDeliveryEnabled))return;
  const nonce=runNonce,shopId=connectedShopId;
  const current=()=>nonce===runNonce&&engine.snapshot().config.running&&shopId===connectedShopId;
  capabilityBusy.add(kind);
  try {
    if(kind==='orders')await recoverPages('orders');
    const result=await bridge(kind==='orders'?'orders':'chat',kind==='orders'?'waiting':'refunds',{page:kind==='orders'?orderPage:refundPage});
    if(!current())return;
    if(!result.ready)throw new Error(result.reason || '官方列表暂不可用');
    if(result.shopId && result.shopId!==shopId)throw new Error('登录店铺与当前自动任务不一致');
    const rows=kind==='orders'?result.orders:result.refunds;
    if(!Array.isArray(rows))throw new Error('官方列表字段未通过校验');
    for(const source of rows) {
      const event={...source};
      if(kind==='orders'&&!event.eligible)continue;
      const signature=JSON.stringify([event.title,event.sku,event.paid,event.refunded,event.cancelled]);
      if(kind==='orders'&&seenOrders.get(event.orderId)===signature)continue;
      if(!event.buyerId && (kind==='orders'||event.status==='pending'&&config.autoRefundEnabled)) {
        if(kind==='refunds'&&!capabilityRecovery.state('orders').ready&&!capabilityRecovery.due('orders'))continue;
        let lookup;
        try {lookup=await bridge('orders','order',{orderId:event.orderId});}
        catch(error){if(kind==='orders')throw error;recordCapabilityFailure('orders',error);continue;}
        if(!current())return;
        if(!lookup.ready || !lookup.order?.buyerId) {
          if(kind==='orders')throw new Error(lookup.reason || '订单暂时缺少可核验的买家编号');
          recordCapabilityFailure('orders',new Error(lookup.reason || '退款买家编号待订单接口核验'));continue;
        }
        if(kind==='orders') {if(!lookup.order.eligible)continue;Object.assign(event,lookup.order);}
        else event.buyerId=lookup.order.buyerId;
      }
      if(!current())return;
      if(kind==='orders') {engine.ingestOrder({...event,shopId,observedAt:Date.now()});seenOrders.set(event.orderId,signature);}
      else engine.ingestRefund({...event,shopId});
    }
    if(!current())return;
    const previous=capabilityRecovery.state(kind);
    bridgeDiagnostics[kind]={...capabilityRecovery.success(kind,{hasMore:result.hasMore}),total:result.total};
    if(previous.failures) {note(`${kind==='orders'?'订单 / 发货':'售后 / 退款'}连接已恢复，继续处理保留的任务。`);recordNetworkRecovery({event:'capability_recovered',kind});}
    if(kind==='orders')orderPage=result.hasMore?orderPage+1:1;
    else refundPage=result.hasMore?refundPage+1:1;
    changed();
  } catch(error) {if(current())recordCapabilityFailure(kind,error);}
  finally {capabilityBusy.delete(kind);}
}
async function reconcileOperations() {
  if(reconciling)return;
  reconciling=true;
  try {
  for (const job of engine.snapshot().jobs.filter(row=>!row.simulation && row.status==='uncertain' && (row.parentJobId || ['delivery','refund','shipment'].includes(row.type)) && row.shopId===connectedShopId)) {
    if(!engine.snapshot().config.running || networkRefreshBusy || capabilityRecovery.excludedTypes({chatReady:bridgeAvailable}).includes(job.type))continue;
    if (Date.now()-(reconciliationChecks.get(job.id)||0)<30000) continue;
    reconciliationChecks.set(job.id,Date.now());
    try {
    if (job.parentJobId) {
      const checked=await bridge('chat','attachment-check',{job});
      if (checked.ready && ['confirmed','not_sent'].includes(checked.status)) engine.reconcileAttachment(job.id,{...checked,shopId:job.shopId,buyerId:job.buyerId});
      continue;
    }
    if(job.type==='delivery'){
      const value=await bridge('orders','order',{orderId:job.orderId});
      if(!value.ready||!value.order?.eligible||value.order.buyerId!==job.buyerId)continue;
      const otherUncertain=engine.snapshot().jobs.some(row=>row.id!==job.id&&row.type==='delivery'&&row.status==='uncertain'&&row.shopId===job.shopId&&row.buyerId===job.buyerId&&(row.deliveryWireContent||row.content)===(job.deliveryWireContent||job.content));
      if(otherUncertain)continue;
      const claimedMessageIds=engine.snapshot().jobs.filter(row=>row.status==='sent'&&row.shopId===job.shopId&&row.buyerId===job.buyerId&&row.sentMessageId).map(row=>row.sentMessageId).slice(-500);
      const checked=await bridge('chat','delivery-check',{job,claimedMessageIds});
      if(checked.ready&&['confirmed','not_sent'].includes(checked.status))engine.reconcileDelivery(job.id,{...checked,shopId:job.shopId,orderId:job.orderId,buyerId:job.buyerId});
      continue;
    }
    const value=job.type==='refund' ? await bridge('chat','refund-status',{job}) : await bridge('orders','order',{orderId:job.orderId});
    if (job.type==='refund' && ['approved','refunded'].includes(value.refund?.status) || job.type==='shipment' && value.order?.shipped && !value.order.refunded) engine.reconcileOperation(job.id,{status:'confirmed',shopId:connectedShopId,orderId:job.orderId,refundId:job.refundId});
    else if(job.type==='shipment'&&value.order?.eligible&&Date.now()-(job.attemptedAt||Date.now())>=60000)engine.reconcileOperation(job.id,{status:'not_sent',eligible:true,shopId:connectedShopId,orderId:job.orderId});
    } catch(error) {if(error.kind==='orders')recordCapabilityFailure('orders',error);else note('平台结果尚未核实，任务保留：'+error.message);}
  }
  } finally {reconciling=false;}
}
async function poll(baseline=false) {
  if (networkRefreshBusy) return;
  if (polling || !baseline && Date.now()<nextPollAt) return;
  polling=true;
  try {
    const config=engine.snapshot().config;
    if (!baseline && !config.running) return;
    if(!(smokeMode?testPlatform?.online!==false:net.isOnline()))throw new Error('电脑处于离线状态，网络恢复后将自动继续');
    const chat=await officialChat();
    if (!connectedShopId) connectedShopId=chat.shopId;
    if (chat.shopId!==connectedShopId) throw new Error('登录店铺与当前自动任务不一致');
    const health=await bridge('chat','health');
    if(!health.ready || (config.autoReplyEnabled||config.autoDeliveryEnabled) && health.canSendViaSocket===false)throw new Error('官方发送连接中断，正在自动重新连接');
    if((config.autoReplyEnabled||config.autoDeliveryEnabled)&&health.canUseOfficialReceiptPipeline===false)throw new Error('官方消息回执处理组件尚未就绪，正在等待加载');
    bridgeDiagnostics.chat=health;
    if ((workflowReadOnly || catchUpReadOnly || networkReadOnly) && !baseline) {
      const orders=await bridge('orders','waiting',{page:1});
      const refunds=await bridge('chat','refunds',{page:1});
      if (!orders.ready || !refunds.ready) throw new Error(orders.reason || refunds.reason || '只读读取失败');
      bridgeDiagnostics.orders={ready:true,total:orders.total,checkedAt:Date.now()};
      bridgeDiagnostics.refunds={ready:true,total:refunds.total,checkedAt:Date.now()};
      diagnostics.chat={ready:true,message:'只读联调运行中，平台写入已锁定',checkedAt:Date.now()};
      bridgeAvailable=true;changed();return;
    }
    for (const conversation of chat.conversations) for (const message of [...conversation.messages].sort((a,b)=>(a.sentAt||0)-(b.sentAt||0))) {
      const key=JSON.stringify([chat.shopId,message.messageId]);
      if (seenMessages.has(key)) continue;
      seenMessages.add(key);
      if (baseline || message.history || !message.sentAt || message.sentAt<startedAt-5000) continue;
      if (message.systemHint || message.noUnreplyHint) continue;
      if (message.direction==='outgoing' || config.autoReplyEnabled && message.type==='0' && (!message.subType || message.subType==='0')) engine.ingestMessage({...message,shopId:chat.shopId,observedAt:Date.now()});
    }
    if (!baseline) {
      void pollCapability('refunds');
      void pollCapability('orders');
      void reconcileOperations().catch(error=>note('平台结果核验稍后继续：'+error.message));
    }
    diagnostics.chat={ready:true,message:`已连接官方客服，正在检查新消息；${chat.conversations.length} 个已加载会话`,checkedAt:Date.now()};
    bridgeAvailable=true;pollFailures=0;nextPollAt=0;
    changed();
  } catch(error) {
    bridgeAvailable=false;pollFailures++;
    const delay=Math.min(30000,3000*2**Math.min(pollFailures-1,4));nextPollAt=Date.now()+delay;
    diagnostics.chat={ready:false,message:`官方连接暂不可用，${delay/1000} 秒后重试：${error.message}`,checkedAt:Date.now()};
    if (/店铺.*变化|店铺.*不一致/.test(error.message)) pause('店铺变化，已暂停自动处理。');
    else {
      note(diagnostics.chat.message);
      if(pollFailures>=2 || needsPerson(error.message))recoverConnection(error.kind||(/订单/.test(error.message)?'orders':'chat'),error.message,{reload:!needsPerson(error.message)});
    }
    if(baseline) throw error;
  }
  finally {polling=false;}
}
async function pump() {
  if (dispatching || readOnlyDiagnostic || !bridgeAvailable || networkRefreshBusy) return;
  dispatching=true;
  try {
    const job=engine.nextJob({excludeTypes:capabilityRecovery.excludedTypes({chatReady:bridgeAvailable,collectingReplies:catchUpCollecting})});
    if (job) { const result=await engine.dispatch(job.id);if(result.type==='delivery'&&result.status==='cancelled'&&result.reason==='rules_changed')seenOrders.delete(result.orderId);changed(); }
  } catch(error) { if(smokeMode)console.error(error);pause('自动处理暂停：'+error.message); }
  finally {dispatching=false;}
}

async function scanUnreplied(nonce = runNonce) {
  if (!engine.snapshot().config.running || nonce !== runNonce) return;
  if(catchUpTimer){clearTimeout(catchUpTimer);catchUpTimer=null;}
  const token = ++catchUpToken;
  catchUpCollecting = true;
  catchUpState = { phase:'scanning', scanned:0, candidates:0, created:0, skipped:0, deferred:0, checkedAt:Date.now() }; changed();
  try {
    const latest = new Map();
    const endTime = Math.floor(Date.now()/1000);
    for (const action of ['unreplied','unreplied-history']) {
      let page = 1;
      while (true) {
        const result = await bridge('chat',action,{page,endTime});
        if (nonce !== runNonce || token !== catchUpToken || !engine.snapshot().config.running) return;
        if (!result.ready || !Array.isArray(result.messages)) throw Error(result.reason || '待回复列表读取失败');
        catchUpState.scanned += result.scanned ?? result.messages.length;
        if(result.deferred?.length){catchUpState.deferred+=result.deferred.length;note('部分待回复会话尚待核验，将重试：'+result.deferred[0].reason);}
        for (const message of result.messages) {
          if (message.shopId !== connectedShopId) throw Error('待回复会话店铺不一致');
          const previous = latest.get(message.buyerId);
          if (!previous || previous.sentAt < message.sentAt) latest.set(message.buyerId, message);
        }
        catchUpState.candidates = latest.size; changed();
        if (!result.hasMore) break;
        if (page++ >= 100) throw Error('待回复会话超过一万条，本次检查未完成，请缩小待回复范围后重试');
      }
    }
    for (const message of latest.values()) {
      if (nonce !== runNonce || token !== catchUpToken || !engine.snapshot().config.running) return;
      // Read-only diagnostics can inspect real pending conversations, but never
      // create or dispatch recovery jobs against the production account.
      const result = readOnlyDiagnostic ? {status:'read_only'} : engine.recoverUnrepliedMessage(message);
      if (result.status === 'created') catchUpState.created++; else catchUpState.skipped++;
    }
    catchUpState.phase = catchUpState.deferred ? 'retrying' : 'complete';
    note(`待回复检查完成：两个列表共读取 ${catchUpState.scanned} 条记录，近七天待回复会话 ${catchUpState.candidates} 个，已安排补答 ${catchUpState.created} 条，已有任务或无需补答 ${catchUpState.skipped} 条。`);
    if(catchUpState.deferred){catchUpState.message='部分会话核验尚未完成，30 秒后重试';catchUpTimer=setTimeout(()=>{if(nonce===runNonce)void scanUnreplied(nonce);},30000);}
  } catch(error) {
    if (nonce !== runNonce || token !== catchUpToken) return;
    catchUpState.phase = 'retrying'; catchUpState.message = error.message;
    note('待回复检查暂未完成，将在 30 秒后重试：'+error.message);
    catchUpTimer = setTimeout(() => { if (nonce === runNonce) void scanUnreplied(nonce); },30000);
  } finally {
    if (token === catchUpToken) { catchUpCollecting = false; changed(); }
  }
}

async function maintainPendingReplies(force=false) {
  const config=engine.snapshot().config;
  if(readOnlyDiagnostic||!config.running||!config.autoReplyEnabled||!config.catchUpUnrepliedEnabled||catchUpCollecting||catchUpState.phase==='retrying')return;
  if(!force&&Date.now()-(catchUpState.checkedAt||0)<55000)return;
  await scanUnreplied(runNonce);
}

function startListening() {
  if (networkRefreshBusy) return Promise.reject(new Error('网络已恢复，正在刷新官方页面，请稍候'));
  if (imageUploadAudit) return Promise.reject(new Error('图片上传检查期间禁止启动业务监听'));
  if (startPromise) return startPromise;
  startPromise = (async () => {
    if (engine.snapshot().config.running) return snapshot();
    if (readOnlyDiagnostic && !workflowReadOnly && !catchUpReadOnly && !networkReadOnly) throw new Error('当前为只读联调，请先完成取数与回执验证');
    const config = engine.snapshot().config;
    listenIntent = true;
    const checkingNonce = runNonce;
    await recoverPages();
    await checkBridge();
    if (checkingNonce !== runNonce || !listenIntent) throw new Error('连接期间设置已修改或监听已暂停，请重新开始监听');
    seenMessages.clear(); seenOrders.clear(); sessionQueue.clear(); orderPage=refundPage=1; capabilityRecovery.reset(); runNonce++; startedAt=Date.now();
    const startingNonce = runNonce;
    await poll(true);
    if (startingNonce !== runNonce) throw new Error('连接期间设置已修改或监听已暂停，请重新开始监听');
    engine.prepareRepliesForResume();
    engine.preparePendingReplyRetries();
    engine.prepareDeliveriesForResume();
    engine.prepareAttachmentsForResume();
    engine.setRunning(true);
    recoveryShopId='';connectFailures=0;
    blocker=powerSaveBlocker.start('prevent-app-suspension');
    catchUpState = {phase:'disabled',scanned:0,candidates:0,created:0,skipped:0};
    note('已启动所选功能，正在监听新消息，并扫描官方待发货订单与退款申请。');
    if (engine.snapshot().config.autoReplyEnabled) void scanUnreplied(startingNonce);
    void poll();
    return snapshot();
  })().catch(error=>{
    if(listenIntent && !needsPerson(error.message) && ++connectFailures>=2)pagesToRecover.add(error.kind||(/订单/.test(error.message)?'orders':'chat'));
    throw error;
  }).finally(() => { startPromise = null; });
  return startPromise;
}

function registerIpc() {
  ipcMain.on('network:changed', (event, online) => {
    try { trusted(event); } catch { return; }
    if (typeof online !== 'boolean' || smokeMode || readOnlyDiagnostic) return;
    rendererOnline = online; observeNetwork(net.isOnline() && rendererOnline);
  });
  const handle = (name, action) => ipcMain.handle(name, async (event, ...args) => { trusted(event); return await action(...args); });
  handle('snapshot', () => snapshot());
  handle('phone-alerts:save', input => {if(!phoneAlerts)throw Error('当前诊断模式不保存手机提醒');phoneAlerts.update(input);changed();return snapshot();});
  handle('cloud-watchdog:save',input=>{if(!cloudWatchdog)throw Error('当前诊断模式不配置云端监护');cloudWatchdog.update(input);phoneAlerts?.setRemoteOwner(cloudWatchdog.snapshot().ownsMobile);changed();return snapshot();});
  handle('cloud-watchdog:disable',async()=>{if(!cloudWatchdog)throw Error('当前诊断模式不配置云端监护');if(engine.snapshot().config.running||listenIntent||startupListener?.active)throw Error('请先手动暂停监听，再停用云端监护');await cloudWatchdog.disable();phoneAlerts?.setRemoteOwner(false);changed();return snapshot();});
  handle('phone-alerts:test', async () => {if(!phoneAlerts)throw Error('当前诊断模式禁止提交手机提醒');await phoneAlerts.test();return snapshot();});
  handle('phone-alerts:setup', provider => {if(!['serverchan','pushplus'].includes(provider))throw Error('提醒服务无效');return shell.openExternal(provider==='serverchan'?'https://sct.ftqq.com/':'https://www.pushplus.plus/uc.html');});
  handle('desktop-alert:test',()=>{if(phoneAlerts?.snapshot().monitor.incident?.desktopShownAt)throw Error('当前已有异常提醒，请先检查连接状态');desktopAlert?.show({id:'preview-'+Date.now(),reason:'这是一条桌面弹窗预览，当前连接状态没有改变。',startedAt:Date.now(),failures:0});return true;});
  ipcMain.on('desktop-alert:action',(event,action)=>desktopAlert?.action(event,action));
  handle('media:preview', value => {
    if (!value || !/^[a-f0-9]{64}$/.test(value.id || '') || !['image/png','image/jpeg'].includes(value.mime)) throw new Error('图片标识无效');
    const file=path.join(dataDir,'assets',value.id+(value.mime==='image/png'?'.png':'.jpg'));
    if (!fs.existsSync(file)) return {preview:null};
    const decoded=nativeImage.createFromPath(file),size=decoded.getSize();
    if (decoded.isEmpty()) return {preview:null};
    return {preview:decoded.resize({width:Math.max(1,Math.round(size.width*Math.min(1,300/size.width,300/size.height)))}).toDataURL()};
  });
  handle('media:add', async () => {
    if (readOnlyDiagnostic) throw new Error('只读联调不允许上传图片');
    if (smokeMode) return typeof testPlatform?.addImage==='function' ? testPlatform.addImage() : {cancelled:true};
    const result=await dialog.showOpenDialog(window,{title:'选择回复附加图片 / 二维码（每张不超过 5 MB）',properties:['openFile'],filters:[{name:'图片',extensions:['png','jpg','jpeg']}]});
    if (result.canceled) return {cancelled:true};
    const file=result.filePaths[0];
    if (fs.statSync(file).size>5*1024*1024) throw new Error('图片需要小于 5 MB');
    const bytes=fs.readFileSync(file);
    if (!bytes.length || bytes.length>5*1024*1024) throw new Error('图片需要小于 5 MB');
    const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg=bytes[0]===255 && bytes[1]===216 && bytes[2]===255;
    if (!png && !jpeg) throw new Error('请选择 PNG 或 JPG 图片');
    const decoded=nativeImage.createFromBuffer(bytes),size=decoded.getSize();
    if (decoded.isEmpty() || size.width>20000 || size.height>20000) throw new Error('图片无法读取或尺寸过大');
    const current=await officialChat(),mime=png?'image/png':'image/jpeg',id=createHash('sha256').update(bytes).digest('hex');
    const directory=path.join(dataDir,'assets');fs.mkdirSync(directory,{recursive:true});
    fs.writeFileSync(path.join(directory,id+(png?'.png':'.jpg')),bytes);
    const uploaded=await bridge('chat','image-upload',{allowAssetUpload:true,expectedShopId:current.shopId,image:{name:path.basename(file),mime,base64:bytes.toString('base64')}});
    if (uploaded.status!=='uploaded') {
      const details={at:new Date().toISOString(),stage:uploaded.stage || 'image-upload',httpStatus:uploaded.httpStatus ?? null,platformCode:uploaded.platformCode ?? null,reason:String(uploaded.reason || '图片上传未成功').slice(0,500)};
      const log=path.join(dataDir,'image-upload-errors.jsonl');
      try {if(fs.existsSync(log) && fs.statSync(log).size>1024*1024){fs.copyFileSync(log,log+'.previous');fs.writeFileSync(log,'');}fs.appendFileSync(log,JSON.stringify(details)+'\n');} catch {}
      const code=[details.httpStatus && 'HTTP '+details.httpStatus,details.platformCode && '平台代码 '+details.platformCode].filter(Boolean).join('，');
      throw new Error((code?`图片上传失败（${code}）：`:'')+details.reason);
    }
    const image=validateImages([{id,name:path.basename(file),shopId:current.shopId,mime,bytes:bytes.length,...size,url:uploaded.url,uploadedAt:Date.now()}])[0];
    note('图片已保存在本机并上传至拼多多；保存规则后生效。');
    const ratio=Math.min(1,300/size.width,300/size.height);
    return {image,preview:decoded.resize({width:Math.max(1,Math.round(size.width*ratio))}).toDataURL()};
  });
  handle('config:update', value => applyLiveConfig(value));
  handle('settings:update', value => {
    const allowed=new Set([...Object.keys(defaults).filter(key=>!['running','products','replyRules'].includes(key)),'startup']);
    if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!allowed.has(key))) throw new Error('设置更新格式不正确');
    const {startup,...patch}=value;
    if (startup!==undefined && typeof startup!=='boolean') throw new Error('开机启动设置格式不正确');
    return applyLiveConfig({...engine.snapshot().config,...patch},{startup});
  });
  handle('running:set', async enabled => {
    if (!enabled) { pause('已手动暂停监听。'); return snapshot(); }
    startupListener?.stop('manual');
    try { return await startListening(); }
    catch(error) { if(listenIntent)recoverConnection(error.kind||(/订单/.test(error.message)?'orders':'chat'),error.message,{reload:!needsPerson(error.message)}); throw error; }
  });
  handle('simulate:order', value => { engine.ingestOrder({ ...value, shopId: connectedShopId || profile.shopId, buyerId: 'local-preview', buyerName: '本地预览', orderId: 'preview-' + Date.now(), itemId: 'preview', paid: value.paid === true }, { simulation: true }); changed(); return snapshot(); });
  handle('simulate:message', value => { engine.ingestMessage({ text: String(value.text || ''), direction: 'incoming', shopId: profile.shopId, buyerId: 'preview-buyer-' + Date.now(), buyerName: '本地预览', messageId: 'preview-' + Date.now() }, { simulation: true }); changed(); return snapshot(); });
  handle('simulate:refund', value => { engine.ingestRefund({shopId:connectedShopId || profile.shopId,orderId:String(value.orderId || 'preview-order'),refundId:'preview-'+Date.now(),status:'pending',title:String(value.title || '')},{simulation:true}); changed(); return snapshot(); });
  handle('profile:save', value => { pause('网页接入设置已更新，需重新校验。'); profile = validateProfile(value); writeJson(path.join(dataDir, 'page-profile.json'), profile); diagnostics.chat.ready = diagnostics.orders.ready = false; changed(); return snapshot(); });
  handle('profile:probe', kind => probe(kind));
  handle('official:inspect', kind => inspectOfficial(kind));
  handle('platform:check', () => checkBridge({includeCapabilities:true}));
  handle('profile:pick', async ({ kind, field, label }) => {
    if (!['chat', 'orders'].includes(kind) || !Object.hasOwn(profile[kind], field)) throw new Error('未知页面字段');
    pause('正在选择页面元素，监听已暂停。');
    const result = await evaluate(kind, 'pick', { label: String(label).slice(0, 30) });
    if (result.error) throw new Error(result.error);
    if (!result.cancelled) {
      const next = JSON.parse(JSON.stringify(profile));
      next[kind][field] = ['incoming','outgoing','row'].includes(field) ? result.repeatedSelector : result.selector;
      profile = validateProfile(next); writeJson(path.join(dataDir, 'page-profile.json'), profile);
      diagnostics[kind] = { ready: false, message: '已选取元素，请完成字段后校验' };
    }
    changed(); return { ...result, state: snapshot() };
  });
  handle('browser:show', ({ kind, visible, bounds }) => { if (smokeMode&&!layoutSmoke) return true; if (!visible) { browserVisible = false; hideViews(); } else showView(kind || selectedKind, bounds); return true; });
  handle('browser:bounds', bounds => { setBounds(bounds); return true; });
  handle('browser:reload', kind => { ensureView(kind).webContents.reload(); return true; });
  handle('browser:home', kind => { ensureView(kind).webContents.loadURL(entryUrls[kind]); return true; });
  handle('jobs:resolve', ({ id, resolution }) => { if (!['sent','cancelled'].includes(resolution)) throw new Error('处理状态无效'); engine.resolveUncertain(id, resolution); changed(); return snapshot(); });
  handle('data:export', async () => {
  const result = await dialog.showSaveDialog(window, { title: '备份商品与答复规则', defaultPath: '拼多多自动发货助手-规则备份.json', filters: [{ name: 'JSON 规则备份', extensions: ['json'] }] });
    if (result.canceled) return { cancelled: true };
    const config = engine.snapshot().config;
    writeJson(result.filePath, { format: 'link-workbench-rules', version: 2, exportedAt: new Date().toISOString(), config: { ...config, running: false } });
    return { path: result.filePath };
  });
  handle('data:import', async () => {
    if(engine.snapshot().config.running||dispatching)throw Error('导入备份前请先手动暂停监听，并等待当前平台操作完成');
    const result = await dialog.showOpenDialog(window, { title: '导入规则备份', properties: ['openFile'], filters: [{ name: 'JSON 规则备份', extensions: ['json'] }] });
    if (result.canceled) return { cancelled: true };
    if(engine.snapshot().config.running||dispatching)throw Error('导入备份前请先手动暂停监听，并等待当前平台操作完成');
    const file = result.filePaths[0]; if (fs.statSync(file).size > 8 * 1024 * 1024) throw new Error('规则文件过大');
    const value = readJson(file);
    if (value?.format !== 'link-workbench-rules' || ![1,2].includes(value.version)) throw new Error('不是本软件的规则备份文件');
    pause(); engine.updateConfig({ ...value.config, running: false, autoReplyEnabled: false, autoDeliveryEnabled: false, autoRefundEnabled: false }); changed(); return snapshot();
  });
  const contentScope = scope => { if (!['replies', 'delivery'].includes(scope)) throw new Error('请选择智能答复或发货规则类别'); return scope === 'replies' ? '智能答复规则' : '发货规则'; };
  handle('content:export', async ({ scope } = {}) => {
    const label = contentScope(scope);
    const result = await dialog.showSaveDialog(window, { title: '导出' + label, defaultPath: label + '.json', filters: [{ name: 'JSON 文字规则', extensions: ['json'] }] });
    if (result.canceled) return { cancelled: true };
    const pack = exportSharedContent(engine.snapshot().config, { scope });
    if (Buffer.byteLength(JSON.stringify(pack, null, 2), 'utf8') > 8 * 1024 * 1024) throw new Error('共享文字超过 8 MB，请拆分规则后导出');
    writeJson(result.filePath, pack);
    return { path: result.filePath, reviewCount: pack.review.mediaSettings.length + pack.review.excludedRules.length + [...pack.content.products || [], ...pack.content.replyRules || []].filter(row => row.needsMedia).length };
  });
  handle('content:preview', async ({ scope } = {}) => {
    const label = contentScope(scope);
    const result = await dialog.showOpenDialog(window, { title: '预览导入' + label + '（兼容旧规则备份）', properties: ['openFile'], filters: [{ name: 'JSON 文字规则 / 规则备份', extensions: ['json'] }] });
    if (result.canceled) return { cancelled: true };
    const file = result.filePaths[0];
    if (fs.statSync(file).size > 8 * 1024 * 1024) throw new Error('规则文件需要小于 8 MB');
    const bytes = fs.readFileSync(file);
    if (bytes.length > 8 * 1024 * 1024) throw new Error('规则文件需要小于 8 MB');
    let value;
    try { value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { throw new Error('规则文件不是有效的 JSON，原文件已保留'); }
    return sharedImport.prepare(value, engine.snapshot().config, 'merge', { scope });
  });
  handle('content:repreview', ({ token, mode }) => sharedImport.repreview(token, engine.snapshot().config, mode));
  handle('content:cancel', ({ token }) => { sharedImport.cancel(token); return true; });
  handle('content:apply', ({ token }) => {
    if (readOnlyDiagnostic) throw new Error('只读联调不允许导入规则');
    const current = engine.snapshot();
    const idle = !listenIntent && !startupListener?.active && !dispatching && !polling && !capabilityBusy.size && !reconciling && !startPromise && !catchUpCollecting && !networkRefreshBusy && !current.jobs.some(job => !job.simulation && job.status === 'sending');
    let backupPath;
    sharedImport.apply(token, current.config, { idle,
      backup: config => {
        const directory = path.join(dataDir, 'rule-backups'); fs.mkdirSync(directory, { recursive: true });
        backupPath = path.join(directory, 'before-shared-import-' + Date.now() + '-' + token + '.json');
        writeJson(backupPath, { format: 'link-workbench-rules', version: 2, exportedAt: new Date().toISOString(), config });
      },
      update: config => { pause(); engine.updateConfig(config); changed(); },
    });
    return { state: snapshot(), backupPath };
  });
  handle('settings:startup', value => { app.setLoginItemSettings({ openAtLogin: value === true }); return snapshot(); });
  handle('app:data-folder', () => shell.openPath(dataDir));
  handle('app:background', () => { window.hide(); return true; });
}

if (smokeMode) app.setPath('userData', path.resolve(__dirname,'..','work','smoke-instance'));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWorkbench);
  app.whenReady().then(() => {
    const smoke = smokeMode;
    dataDir = smoke ? path.resolve(__dirname, '..', 'work', 'smoke-data-' + Date.now()) : path.join(app.getPath('appData'), 'LinkDeliveryWorkbench'); fs.mkdirSync(dataDir, { recursive: true });
    app.setPath('userData', path.join(dataDir, 'browser-data'));
    profile = validateProfile(readJson(path.join(dataDir, 'page-profile.json'), defaultProfile()));
    let stateFile=path.join(dataDir,'state.json');
    if (readOnlyDiagnostic || imageUploadAudit) {
      const shadowDir=path.resolve(__dirname,'..','work','workflow-readonly-'+Date.now());fs.mkdirSync(shadowDir,{recursive:true});
      const shadowFile=path.join(shadowDir,'state.json');if(fs.existsSync(stateFile))fs.copyFileSync(stateFile,shadowFile);stateFile=shadowFile;
    }
    engine = new Engine({ filePath: stateFile, sendMessage: transport, markShipped: transport, agreeRefund: transport });
    if(!readOnlyDiagnostic&&!imageUploadAudit){
      desktopAlert=new DesktopAlert({BrowserWindow,screen,openWorkbench:showWorkbench,mainWindow:()=>window,offscreen:smokeMode&&!layoutSmoke,onError:()=>phoneAlerts?.reportError()});
      phoneAlerts=new AlertService({directory:dataDir,crypto:safeStorage,fetchImpl:(...args)=>net.fetch(...args),previouslyWorked:engine.snapshot().stats.sent>0,changed,desktop:notice=>desktopAlert.show(notice),
        sendOverride:smokeMode?async(message,event)=>{if(typeof testPlatform?.sendPhoneAlert!=='function')throw Error('隔离样本未配置手机推送，不会请求外网');return testPlatform.sendPhoneAlert(message,event);}:undefined});
      cloudWatchdog=new CloudWatchdog({directory:dataDir,crypto:safeStorage,changed,fetchImpl:smokeMode?async(...args)=>{if(typeof testPlatform?.sendCloudHeartbeat!=='function')throw Error('隔离样本禁止外网心跳');return testPlatform.sendCloudHeartbeat(...args);}:(...args)=>net.fetch(...args)});
      phoneAlerts.setRemoteOwner(cloudWatchdog.snapshot().ownsMobile);
      phoneAlertTimer=setInterval(()=>{if(closing)return;try{const sample=connectionSample({config:engine.snapshot().config,listenIntent,startup:startupListener,bridgeAvailable,diagnostics,capabilities:{orders:capabilityRecovery.state('orders'),refunds:capabilityRecovery.state('refunds')},online:smokeMode?testPlatform?.online!==false:net.isOnline()&&rendererOnline!==false});phoneAlerts.observe(sample);void cloudWatchdog.observe(sample).then(()=>{if(!closing)phoneAlerts.setRemoteOwner(cloudWatchdog.snapshot().ownsMobile);}).catch(()=>phoneAlerts.reportError());}catch{phoneAlerts.reportError();}},5000);
    }
    startupListener = new StartupListener({start:startListening,update:()=>changed()});
    networkRefresh = new NetworkRefresh({ refresh: refreshPagesAfterNetwork, settleMs: smokeMode ? 100 : 5000, update: value => {
      if (!smokeMode && (!readOnlyDiagnostic || networkReadOnly)) recordNetworkRecovery({ event: 'network_state', phase: value.phase, cycle: value.cycle });
      changed();
    } });
    if (!smokeMode && !readOnlyDiagnostic && !imageUploadAudit) {
      observeNetwork(net.isOnline());
      networkTimer = setInterval(() => {
        observeNetwork(net.isOnline() && rendererOnline !== false);
        if (!networkRefreshBusy && browserVisible && Date.now() - lastPageStatusCheck >= 15000) {
          lastPageStatusCheck = Date.now();
          const wc = views.get(selectedKind)?.webContents;
          if (wc && !wc.isDestroyed() && !wc.isLoading()) void updatePageState(selectedKind, wc);
        }
      }, 1000);
    }
    window = new BrowserWindow({ width: 1440, height: 920, minWidth: 1120, minHeight: 740, show: !smoke && !platformReadOnly && !imageUploadAudit && !popupCleanupAudit && !receiptReadOnly, title: '拼多多自动发货助手', icon: path.join(__dirname, 'renderer', 'icon.ico'), backgroundColor: '#f6f8fa', autoHideMenuBar: true, webPreferences: { offscreen: smoke&&!layoutSmoke, backgroundThrottling: false, preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    window.on('resize',()=>{for(const view of views.values())view.setVisible(false);});
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(uiUrl)) event.preventDefault(); });
    registerIpc(); window.loadURL(uiUrl);
    if (smoke) window.webContents.once('did-finish-load', () => require(cloudWatchdogSmoke?'../scripts/cloud-watchdog-smoke.cjs':liveSettingsSmoke?'../scripts/live-settings-smoke.cjs':sharedRulesSmoke?'../scripts/shared-rules-smoke.cjs':layoutSmoke?'../scripts/layout-smoke.cjs':capabilitySmoke?'../scripts/capability-smoke.cjs':startupSmoke?'../scripts/startup-smoke.cjs':'../scripts/smoke-driver.cjs').run({ app, window, tray, trayMenu, engine, dataDir, startupListener, scanUnreplied, maintainPendingReplies, recoverConnection, poll, pollCapability, capabilityRecovery, bridgeDiagnostics, pause, networkRefresh, observeNetwork, views, phoneAlerts, desktopAlert, cloudWatchdog, configureTestPlatform:value=>{testPlatform=value;} }).catch(error => { console.error(error); app.exit(1); }));
    if (!smoke && !readOnlyDiagnostic && !liveWireAudit && !pendingReplyAudit && !imageUploadAudit && !process.argv.includes('--start-paused')) window.webContents.once('did-finish-load', () => startupListener.arm(engine.snapshot().config));
    if (imageUploadAudit) window.webContents.once('did-finish-load',()=>require('../scripts/image-upload-audit.cjs').run({app,window,engine,ensureView,bridge,dataDir}).catch(error=>{console.error('图片检查失败：'+error.message);app.exit(1);}));
    if (popupCleanupAudit) window.webContents.once('did-finish-load',()=>require('../scripts/popup-cleanup-audit.cjs').run({app,window,engine,ensureView,bridge,dataDir}).catch(error=>{console.error('弹窗检查失败：'+error.message);app.exit(1);}));
    if (receiptReadOnly) window.webContents.once('did-finish-load',()=>require('../scripts/receipt-readonly.cjs').run({app,engine,ensureView,bridge}).catch(error=>{console.error('回执组件只读检查失败：'+error.message);app.exit(1);}));
    if (liveWireAudit && !readOnlyDiagnostic && !smoke) window.webContents.once('did-finish-load',()=>require('../scripts/live-wire-audit.cjs').run({app,engine,ensureView,startupListener,bridge}).catch(error=>{console.error(error);app.quit();}));
    if (pendingReplyAudit && !readOnlyDiagnostic && !smoke) window.webContents.once('did-finish-load',()=>require('../scripts/pending-reply-live.cjs').run({app,engine,ensureView,startupListener,bridge}).catch(error=>{console.error(error);app.quit();}));
    if (catchUpReadOnly) window.webContents.once('did-finish-load', () => require('../scripts/catchup-readonly.cjs').run({app,window,engine,ensureView,bridge,startListening,scanUnreplied,shadowFile:stateFile}).catch(error=>{console.error(error);app.exit(1);}));
    if (workflowReadOnly) window.webContents.once('did-finish-load',()=>require('../scripts/workflow-readonly.cjs').run({app,window,engine,ensureView,bridge,shadowFile:stateFile}).catch(error=>{console.error(error);app.exit(1);}));
    if (networkReadOnly) window.webContents.once('did-finish-load',()=>require('../scripts/network-readonly.cjs').run({app,engine,ensureView,bridge,startupListener,networkRefresh,observeNetwork,productionStateFile:path.join(dataDir,'state.json')}).catch(error=>{console.error(error);app.exit(1);}));
    if (platformReadOnly) window.webContents.once('did-finish-load', () => require('../scripts/platform-readonly.cjs').run({ app, window, ensureView, bridge, engine, checkBridge }).catch(error => { console.error('平台只读检测失败：' + error.message); app.exit(1); }));
    else if (readOnlyDiagnostic && !workflowReadOnly && !catchUpReadOnly && !networkReadOnly && !popupCleanupAudit && !receiptReadOnly) window.webContents.once('did-finish-load', () => require('../scripts/live-read-only.cjs').run({ window, ensureView, inspectOfficial, bridge, engine }).catch(error => console.error('只读检测失败：' + error.message)));
    const icon = nativeImage.createFromPath(path.join(__dirname, 'renderer', 'tray.png')).resize({ width: 20, height: 20 });
    tray = new Tray(icon);
    tray.setToolTip('拼多多自动发货助手');
    trayMenu = Menu.buildFromTemplate([{ label: '打开工作台', click: showWorkbench }, { label: '暂停监听', click: () => pause('已通过托盘暂停监听。') }, { type: 'separator' }, { label: '退出', click: () => { closing = true; app.quit(); } }]);
    tray.setContextMenu(trayMenu);
    tray.on('double-click', showWorkbench);
    window.on('close', event => { if (!closing) { event.preventDefault(); window.hide(); } });
    window.on('closed', () => { if (!closing) app.quit(); });
    timer = setInterval(() => poll(), 3000);
    dispatchTimer = setInterval(() => pump(), 250);
    pendingReplyTimer = setInterval(() => {void maintainPendingReplies().catch(error=>note('待回复检查将继续重试：'+error.message));},60000);
    app.on('before-quit', () => { closing = true; cloudWatchdog?.dispose();phoneAlerts?.dispose();desktopAlert?.dispose();clearInterval(phoneAlertTimer);networkRefresh?.dispose(); clearInterval(networkTimer); clearInterval(timer); clearInterval(dispatchTimer); clearInterval(pendingReplyTimer); pause(); for (const view of views.values()) { if (!view.webContents.isDestroyed()) view.webContents.close(); } });
  }).catch(error => { dialog.showErrorBox('工作台启动失败', error.message); app.quit(); });
}
