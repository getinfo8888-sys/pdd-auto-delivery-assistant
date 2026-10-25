'use strict';

// Only identified optional customer-service notices and tours are handled.
// Business dialogs deliberately do not share a generic acknowledgement selector.
function popupGuard(action) {
  const key = '__localWorkbenchPopupGuard';
  const allowed = location.origin === 'https://mms.pinduoduo.com' && location.pathname.startsWith('/chat-merchant/');
  if (!allowed) {
    globalThis[key]?.dispose?.();
    return { active: false, reason: 'outside_customer_service', events: [] };
  }
  const existing = globalThis[key];
  if (existing?.version === 2 && existing.active) return existing.read(action === 'drain');
  if (action !== 'install') return { active: false, events: [] };
  existing?.dispose?.();
  let active = true, scheduled, observer, poll;
  const counts = { attempted: 0, dismissed: 0, blocked: 0, failed: 0 };
  const events = [], history = [], timers = new Set(), attempts = new WeakMap(), notices = new WeakMap();
  const clean = node => (node?.textContent || '').replace(/\s/g, '');
  const sensitive = text => /验证码|安全验证|滑块|扫码登录|重新登录|登录失效|身份验证|人机验证|协议|授权|支付密码|确认退款|同意退款|确认付款|同意并|确认发货|确认收货|禁止发送|违规处理/.test(text);
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); if (active) fn(); }, ms); timers.add(id); return id; };
  const record = (type, outcome) => {
    const item = { type, outcome, at: Date.now() };
    events.push(item); history.push(item);
    if (events.length > 30) events.shift();
    if (history.length > 30) history.shift();
  };
  const visible = node => {
    if (!node?.isConnected || !node.getClientRects().length) return false;
    for (let el = node; el instanceof Element; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (el.hidden || el.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  const usable = node => {
    if (!visible(node) || node.disabled || node.getAttribute('aria-disabled') === 'true' || getComputedStyle(node).pointerEvents === 'none') return false;
    const rect = node.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
    const top = document.elementFromPoint(x, y);
    return top === node || node.contains(top);
  };
  const blocked = (root, type, outcome) => {
    if (notices.get(root) === outcome) return;
    notices.set(root, outcome); counts.blocked++; record(type, outcome);
  };
  const dismiss = (root, button, type) => {
    if (!usable(button)) return;
    const previous = attempts.get(button) || { count: 0, at: 0, checking: false };
    const delay = previous.count ? Math.min(30000, 2000 * 2 ** Math.min(previous.count - 1, 4)) : 0;
    if (previous.checking || Date.now() - previous.at < delay) return;
    previous.count++; previous.at = Date.now(); previous.checking = true;
    attempts.set(button, previous); counts.attempted++;
    try { button.click(); }
    catch { previous.checking = false; counts.failed++; record(type, 'handler_failed'); return; }
    later(() => {
      previous.checking = false;
      if (!visible(root)) { counts.dismissed++; record(type, 'dismissed'); }
      else { counts.failed++; record(type, 'still_visible'); }
    }, 700);
  };
  const dismissNotice = root => {
    if (!visible(root)) return;
    const title = clean(root.querySelector('.modal-header,.el-dialog__title,.ant-modal-title,.next-dialog-header,[data-dialog-title],h1,h2,h3'));
    const text = clean(root);
    const notification = /^(?:浏览器|消息|桌面)(?:未|尚未)(?:开启|启用)通知$/.test(title) && /开启消息通知后|新消息通知|回复超时预警/.test(text);
    const feature = /新功能|功能介绍|功能更新|功能上新|使用引导|操作指引|操作引导|新手引导|新版介绍|版本更新|升级介绍/.test(title) && title.length <= 60;
    if (!notification && !feature) return;
    const type = notification ? 'notification_tip' : 'feature_notice';
    if (sensitive(text) || root.querySelector('input,textarea,select,[contenteditable="true"],iframe')) { blocked(root, type, 'needs_person'); return; }
    const controls = [...root.querySelectorAll('button,a,[role="button"],.cancel,.btn-cancel,.btn-ok,.close,.icon-close,.el-dialog__headerbtn,.ant-modal-close,.next-dialog-close')];
    const permitted = notification ? ['今天不再提示','今日不再提示','不再提示','暂不开启','稍后再说','关闭','取消'] : ['不再提示','今天不再提示','我知道了','知道了','稍后再说','关闭'];
    // Prefer the official daily-dismiss handler over the generic X. It both
    // closes the notification dialog and persists its own per-user date.
    let button;
    for (const label of permitted) {
      button = controls.find(node => clean(node) === label && usable(node));
      if (button) break;
    }
    button ||= controls.find(node => /^(?:关闭|close)$/i.test(node.getAttribute('aria-label') || node.getAttribute('title') || '') && usable(node));
    button ||= controls.find(node => node.matches('.close,.icon-close,.el-dialog__headerbtn,.ant-modal-close,.next-dialog-close') && /^(?:×|✕|关闭)?$/.test(clean(node)) && usable(node));
    if (button?.tagName === 'A' && button.getAttribute('href') && !/^(?:#|javascript:void\(0\);?)$/.test(button.getAttribute('href'))) { blocked(root, type, 'missing_close'); return; }
    if (button) dismiss(root, button, type);
    else blocked(root, type, 'missing_close');
  };
  const sweep = () => {
    if (!active) return;
    if (location.origin !== 'https://mms.pinduoduo.com' || !location.pathname.startsWith('/chat-merchant/')) { api.dispose(); return; }
    const root = document.getElementById('driver-popover-item');
    if (visible(root) && root.querySelector('.driver-popover-title') && root.querySelector('.driver-popover-description')) {
      // Driver.close resets the guide; Driver.next may invoke an onNext callback.
      // Never advance a tour or click the highlighted business control.
      const text = [root.querySelector('.driver-popover-title').textContent, root.querySelector('.driver-popover-description').textContent].join('');
      if (sensitive(text) || root.querySelector('input,textarea,select,[contenteditable="true"],iframe')) blocked(root, 'feature_tour', 'needs_person');
      else {
        const button = root.querySelector('.driver-popover-footer .driver-close-btn');
        if (button) dismiss(root, button, 'feature_tour');
        else blocked(root, 'feature_tour', 'missing_close');
      }
    }
    for (const tip of document.querySelectorAll('.icon-pc-container .tip-content')) {
      if (visible(tip) && tip.textContent.replace(/\s/g, '') === '开启Win工作台') dismiss(tip, tip.querySelector('.icon-close'), 'desktop_tip');
    }
    for (const notice of document.querySelectorAll('.modal-box,[role="dialog"],.el-dialog,.ant-modal-content,.next-dialog,[aria-modal="true"]')) dismissNotice(notice);
  };
  const schedule = () => {
    if (active && !scheduled) scheduled = later(() => { scheduled = undefined; sweep(); }, 200);
  };
  const api = {
    version: 2,
    get active() { return active; },
    read(drain) { return { active, counts: { ...counts }, events: drain ? events.splice(0) : events.slice(), recent: history.slice() }; },
    dispose() {
      active = false; observer?.disconnect(); clearInterval(poll);
      for (const id of timers) clearTimeout(id);
      timers.clear(); window.removeEventListener('pagehide', onHide);
    }
  };
  function onHide() { api.dispose(); }
  globalThis[key] = api;
  observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'disabled', 'aria-disabled'] });
  poll = setInterval(schedule, 15000);
  window.addEventListener('pagehide', onHide, { once: true });
  sweep();
  return api.read(false);
}

function makePopupGuardScript(action = 'install') {
  if (!['install', 'status', 'drain'].includes(action)) throw new Error('未知弹窗检查操作');
  return `(${popupGuard.toString()})(${JSON.stringify(action)})`;
}

function attachPopupGuard(wc, report) {
  let busy = false, stopped = false, failures = 0, again = false;
  const check = async () => {
    if (stopped || wc.isDestroyed()) return;
    if (busy) { again = true; return; }
    if (wc.isLoading()) return;
    busy = true;
    try {
      await wc.executeJavaScript(makePopupGuardScript(), false);
      const value = await wc.executeJavaScript(makePopupGuardScript('drain'), false);
      if (!stopped) { failures = 0; report(value); }
    } catch {
      if (!stopped && !wc.isDestroyed() && ++failures === 3) report({ active: false, events: [{ type: 'guard', outcome: 'check_failed', at: Date.now() }] });
    } finally { busy = false; if (again && !stopped) { again = false; void check(); } }
  };
  const timer = setInterval(check, 10000);
  const stop = () => {
    stopped = true; clearInterval(timer);
    wc.removeListener('did-finish-load', check); wc.removeListener('did-stop-loading', check); wc.removeListener('did-navigate-in-page', check); wc.removeListener('destroyed', stop);
  };
  wc.on('did-finish-load', check); wc.on('did-stop-loading', check); wc.on('did-navigate-in-page', check); wc.once('destroyed', stop);
  void check();
  return stop;
}

module.exports = { makePopupGuardScript, attachPopupGuard };
