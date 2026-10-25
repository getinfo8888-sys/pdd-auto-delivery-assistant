const fs = require('node:fs');
const path = require('node:path');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Developer-only driver. It loads the user's existing session and reads our own
// allowlisted projection. It never fills fields, clicks the page, or sends.
async function run({ window, ensureView, inspectOfficial, engine }) {
  if(process.argv.includes('--audit-pending')||process.argv.includes('--audit-rejected'))return require('./pending-reply-readonly.cjs').run({window,ensureView,engine});
  if(process.argv.includes('--audit-sockets'))return require('./socket-metadata-readonly.cjs').run({window,ensureView});
  if(process.argv.includes('--audit-send'))return require('./send-audit-readonly.cjs').run({window,ensureView,engine});
  const ordersFirst=process.argv.includes('--orders-first');
  const report = async (kind, attempt) => {
    const reportPath = path.resolve(__dirname, '..', 'work', kind === 'chat' ? 'live-read-only-summary.json' : 'live-orders-read-only-summary.json');
    const view = ensureView(kind);
    let value;
    try { value = await inspectOfficial(kind); }
    catch (error) { value = { ready: false, readOnly: true, issue: error.message, checkedAt: Date.now() }; }
    const state = engine.snapshot();
    value = { ...value, attempt, pageOrigin: (() => { try { return new URL(view.webContents.getURL()).origin; } catch { return ''; } })(), running: state.config.running, actualSent: state.stats.sent };
    fs.writeFileSync(reportPath, JSON.stringify(value, null, 2), 'utf8');
    if(ordersFirst && kind==='orders' && attempt===1)fs.writeFileSync(path.resolve(__dirname,'..','work','manual-orders-page.png'),(await view.webContents.capturePage()).toPNG());
    return value;
  };
  await window.webContents.executeJavaScript(`document.querySelector('[data-nav="shop"]').click(); void 0;`);
  for (const kind of ordersFirst?['orders']:['chat','orders']) {
    ensureView(kind);
    if (kind === 'orders') await window.webContents.executeJavaScript(`document.querySelector('[data-action="browser-kind"][data-kind="orders"]').click(); void 0;`);
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await wait(5000);
      const value = await report(kind, attempt);
      console.log(JSON.stringify({ kind, readOnly: true, ready: value.ready, attempt, conversations: value.conversationCount, messages: value.messageCount, orders: value.orderCount }));
      if (value.ready) break;
    }
  }
  await wait(500);
  fs.writeFileSync(path.resolve(__dirname, '..', 'work', 'live-read-only-workbench.png'), (await window.webContents.capturePage()).toPNG());
  // Keep summaries current during this bounded development session, including
  // read-only navigation performed through the browser evidence tool.
  const deadline = Date.now() + 10 * 60 * 1000;
  let refreshing = false;
  const timer = setInterval(async () => {
    if (window.isDestroyed() || Date.now() > deadline) return clearInterval(timer);
    if (refreshing) return;
    refreshing = true;
    try { for (const kind of ['chat', 'orders']) await report(kind, 0); }
    finally { refreshing = false; }
  }, 5000);
  timer.unref();
  window.once('closed', () => clearInterval(timer));
}
module.exports = { run };
