'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { dialog } = require('electron');
const { exportSharedContent } = require('../src/core/shared-content.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run({ app, window, engine, dataDir, configureTestPlatform }) {
  const platform = require('./fixture-platform.cjs').createPlatform(); configureTestPlatform(platform);
  const out = path.join(dataDir, 'shared-content-smoke'); fs.mkdirSync(out);
  const product = (id, content) => ({ id, name: '示例资料', keywords: ['资料'], content, enabled: true });
  const reply = (id, matchType = 'contains') => ({ id, name: '使用说明', keywords: ['怎么用'], content: '请查看示例说明。', matchType, enabled: true });
  engine.updateConfig({ ...engine.snapshot().config, autoListenOnLaunch: true, autoReplyEnabled: true, autoDeliveryEnabled: true, autoRefundEnabled: true,
    products: [product('guide', '本机旧正文'), product('keep', '需要保留的正文')], replyRules: [reply('system-local', 'system')], suffix: '本机尾缀' });
  const baseline = engine.snapshot().config;
  const imported = { ...baseline, products: [product('guide', '领取地址：https://pan.example.test/guide?pwd=ABCD\n提取码：ABCD'), product('new', '请查看领取说明。')], replyRules: [reply('help'), reply('system-source', 'system')], suffix: '共享尾缀' };
  const shared = exportSharedContent(imported); shared.content.products[1].needsMedia = true;
  const incomingFile = path.join(out, 'incoming.json'), exportFile = path.join(out, 'export.json'), legacyFile = path.join(out, 'legacy-v1.json');
  fs.writeFileSync(incomingFile, JSON.stringify(shared));
  fs.writeFileSync(legacyFile, JSON.stringify({ format: 'link-workbench-rules', version: 1, config: imported }));
  let nextOpen = incomingFile, nextSave = exportFile;
  const openDialog = dialog.showOpenDialog, saveDialog = dialog.showSaveDialog;
  dialog.showOpenDialog = async () => nextOpen ? { canceled: false, filePaths: [nextOpen] } : { canceled: true, filePaths: [] };
  dialog.showSaveDialog = async () => nextSave ? { canceled: false, filePath: nextSave } : { canceled: true };
  const ui = code => window.webContents.executeJavaScript(code);
  const until = async (check, label) => { const deadline = Date.now() + 10000; while (Date.now() < deadline) { if (await check()) return; await wait(80); } throw Error('Timeout: ' + label); };
  const click = async selector => {
    await until(() => ui(`!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled && !busy`), selector);
    await ui(`document.querySelector(${JSON.stringify(selector)}).click();void 0;`);
    await until(() => ui('!busy'), 'action finished');
  };
  const assertions = [];
  try {
    await ui('refresh(true)'); await click('[data-nav="settings"]');
    await click('[data-action="shared-export"]');
    const exported = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
    assert.equal(exported.format, 'local-commerce-content');
    assert.equal(exported.content.products[0].content, '本机旧正文');
    assert.equal('autoRefundEnabled' in exported.content.settings, false);
    assert.deepEqual(engine.snapshot().config, baseline);
    assertions.push('export writes content only and leaves current settings intact');

    nextSave = null; await click('[data-action="shared-export"]');
    nextOpen = null; await click('[data-action="shared-import"]');
    assert.equal(await ui('!!document.querySelector(".modal")'), false);
    assert.deepEqual(engine.snapshot().config, baseline);
    nextOpen = incomingFile;
    await click('[data-action="shared-import"]');
    assert.equal(await ui('sharedPreview.summary.add'), 2);
    assert.equal(await ui('sharedPreview.summary.update'), 1);
    assert.match(await ui('document.querySelector(".shared-warnings").textContent'), /停用/);
    assert.match(await ui('document.querySelector(".shared-warnings").textContent'), /系统规则/);
    await ui('document.querySelectorAll(".shared-change").forEach(node=>{node.open=node.querySelector("summary").textContent.includes("发货内容");});document.querySelector(".shared-changes").scrollIntoView({block:"start"});void 0;');
    assert.match(await ui('document.querySelector(".shared-changes").textContent'), /pan\.example\.test/);
    await wait(250);
    fs.writeFileSync(path.join(out, 'preview.png'), (await window.webContents.capturePage()).toPNG());
    await click('[data-action="shared-replace"]');
    assert.equal(await ui('sharedPreview.summary.remove'), 1);
    await click('[data-action="close-modal"]');
    assert.deepEqual(engine.snapshot().config, baseline);
    assert.equal(fs.existsSync(path.join(dataDir, 'rule-backups')), false);
    assertions.push('canceling dialogs or preview never changes config; replace exposes deletions');

    nextOpen = legacyFile; await click('[data-action="shared-import"]');
    assert.equal(await ui('sharedPreview.source'), 'pdd');
    await ui('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape"}));void 0;');
    assert.equal(await ui('sharedPreview'), null);
    assert.deepEqual(engine.snapshot().config, baseline);
    assertions.push('legacy v1 backup previews through the same UI and Escape cancels it');

    nextOpen = incomingFile; engine.setRunning(true);
    await click('[data-action="shared-import"]');
    await click('[data-action="shared-apply"]');
    assert.match(await ui('document.querySelector("#toast").textContent'), /先暂停/);
    assert.equal(engine.snapshot().config.running, true);
    assert.equal(fs.existsSync(path.join(dataDir, 'rule-backups')), false);
    engine.setRunning(false);
    engine.updateConfig({ ...engine.snapshot().config, suffix: '预览后的本机变更' });
    await click('[data-action="shared-apply"]');
    assert.match(await ui('document.querySelector("#toast").textContent'), /已变化/);
    await click('[data-action="shared-refresh"]');
    const beforeApply = engine.snapshot().config;
    // Application must use the preview held in main, even if the original file
    // is replaced or removed while a person reviews its content.
    fs.writeFileSync(incomingFile, '{invalid json after preview');
    await click('[data-action="shared-apply"]');
    assert.equal(await ui('!!document.querySelector(".modal")'), false);
    const current = engine.snapshot().config;
    for (const key of ['running', 'autoListenOnLaunch', 'autoReplyEnabled', 'autoDeliveryEnabled', 'autoRefundEnabled']) assert.equal(current[key], false, key);
    assert.deepEqual(current.products.map(row => row.id), ['guide', 'keep', 'new']);
    assert.equal(current.products.find(row => row.id === 'new').enabled, false);
    assert.equal(current.products[0].content, shared.content.products[0].content);
    assert.deepEqual(current.replyRules.map(row => row.id), ['system-local', 'help']);
    const backups = fs.readdirSync(path.join(dataDir, 'rule-backups'));
    assert.equal(backups.length, 1);
    const backup = JSON.parse(fs.readFileSync(path.join(dataDir, 'rule-backups', backups[0]), 'utf8'));
    assert.deepEqual(backup.config, beforeApply);
    assert.equal(platform.data.actions.length, 0);
    assert.deepEqual(engine.snapshot().jobs, []);
    assertions.push('running guard and stale preview guard preserve current config', 'apply uses reviewed content, backs up original rules and disables automatic processing', 'local system rules and unrelated rows survive merge; media rows stay disabled', 'no platform writes, jobs or buyer messages are generated');

    // Also exercise the final replacement application, including its backup.
    nextOpen = legacyFile; await click('[data-action="shared-import"]'); await click('[data-action="shared-replace"]'); await click('[data-action="shared-apply"]');
    assert.deepEqual(engine.snapshot().config.products.map(row => row.id), ['guide', 'new']);
    assert.deepEqual(engine.snapshot().config.replyRules.map(row => row.id), ['system-local', 'help']);
    assert.equal(fs.readdirSync(path.join(dataDir, 'rule-backups')).length, 2);
    assertions.push('replacement applies only after preview and keeps local system rules');
    const result = { ok: true, assertions, platformWrites: platform.data.actions.length, dataDir };
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally { dialog.showOpenDialog = openDialog; dialog.showSaveDialog = saveDialog; }
  app.exit(0);
}
module.exports = { run };
