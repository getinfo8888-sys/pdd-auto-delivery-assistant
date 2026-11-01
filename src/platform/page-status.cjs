'use strict';

function pageStatus() {
  const visible = el => !!el?.isConnected && !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const login = /\/(?:login|auth)(?:\/|$)/.test(location.pathname);
  const verification = [...document.querySelectorAll('[class*="captcha"],[id*="captcha"],[role="dialog"],iframe[src*="captcha"]')].some(el => visible(el) && (el.tagName === 'IFRAME' || /请向右滑块完成拼图|请拖动滑块|安全验证|请完成验证|验证后继续/.test(el.textContent || '')));
  const draft = document.querySelector('#replyTextarea');
  // A merchant can navigate the visible order tab into a product editor. Track
  // edits there before any automatic return to the order entry. The marker is
  // document-local; a manual save/navigation/reload remains under user control.
  if(!globalThis.__localWorkbenchEditGuard){
    const guard={path:location.pathname,dirty:false};globalThis.__localWorkbenchEditGuard=guard;
    const edited=event=>{
      if(guard.path!==location.pathname){guard.path=location.pathname;guard.dirty=false;}
      if(/^\/chat-merchant\//.test(location.pathname)||location.pathname==='/orders/list')return;
      const target=event.target;
      if(target?.matches?.('input:not([type="hidden"]):not([type="button"]):not([type="submit"]),textarea,select,[contenteditable="true"]'))guard.dirty=true;
    };
    document.addEventListener?.('input',edited,true);document.addEventListener?.('change',edited,true);
  }
  const guard=globalThis.__localWorkbenchEditGuard;
  if(guard.path!==location.pathname){guard.path=location.pathname;guard.dirty=false;}
  return { login, verification, hasDraft: guard.dirty || !!(visible(draft) && (draft.value || draft.textContent || '').trim()), loaded: document.readyState === 'complete' };
}
const makePageStatusScript = () => `(${pageStatus.toString()})()`;
module.exports = { makePageStatusScript };
