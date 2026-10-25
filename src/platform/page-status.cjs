'use strict';

function pageStatus() {
  const visible = el => !!el?.isConnected && !!el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const login = /\/(?:login|auth)(?:\/|$)/.test(location.pathname);
  const verification = [...document.querySelectorAll('[class*="captcha"],[id*="captcha"],[role="dialog"],iframe[src*="captcha"]')].some(el => visible(el) && (el.tagName === 'IFRAME' || /请向右滑块完成拼图|请拖动滑块|安全验证|请完成验证|验证后继续/.test(el.textContent || '')));
  const draft = document.querySelector('#replyTextarea');
  return { login, verification, hasDraft: !!(visible(draft) && (draft.value || draft.textContent || '').trim()), loaded: document.readyState === 'complete' };
}
const makePageStatusScript = () => `(${pageStatus.toString()})()`;
module.exports = { makePageStatusScript };
