'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { makePopupGuardScript } = require('../src/platform/pdd-popups.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run({ app, ensureView, engine, bridge, dataDir }) {
  const stateFile = path.join(dataDir, 'state.json');
  const digest = () => createHash('sha256').update(fs.readFileSync(stateFile)).digest('hex');
  const before = digest();
  assert.equal(engine.snapshot().config.running, false);
  await assert.rejects(() => bridge('chat', 'send', { allowWrite: true }), /锁定平台业务写入/);
  const wc = ensureView('chat').webContents;
  const startedAt = Date.now();
  let status, page;
  for (let attempt = 0; attempt < 10; attempt++) {
    await wait(3000);
    if (wc.isLoading()) continue;
    page = await wc.executeJavaScript(`(()=>({customerService:location.origin==='https://mms.pinduoduo.com'&&location.pathname.startsWith('/chat-merchant/'),guidePresent:!!document.getElementById('driver-popover-item'),viewport:{width:innerWidth,height:innerHeight},needsPerson:/滑块|安全验证|请先登录|扫码登录/.test(document.body?.innerText||'')}))()`);
    status = await wc.executeJavaScript(makePopupGuardScript('status'));
    if (status.active && status.counts?.dismissed) break;
  }
  let ready = false;
  if (page?.customerService) { try { ready = (await bridge('chat', 'health')).ready === true; } catch {} }
  const result = { at: new Date().toISOString(), elapsedMs: Date.now() - startedAt, uiCleanupAuthorized: true, businessWritesLocked: true, actualBusinessWrites: 0, productionStateUnchanged: before === digest(), page, guard: status, officialConnectionReady: ready };
  assert.equal(result.productionStateUnchanged, true);
  fs.writeFileSync(path.resolve(__dirname, '../work/popup-live-audit.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  app.quit();
}
module.exports = { run };
