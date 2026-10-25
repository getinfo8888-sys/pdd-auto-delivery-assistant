'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Engine, validateConfig, planDelivery } = require('../src/core/engine.cjs');
const { planReplies } = require('../src/core/reply-strategies.cjs');
const { exportSharedContent, validateSharedContent, readSharedContent, previewSharedImport, SharedImportDraft } = require('../src/core/shared-content.cjs');

const image = { id: 'a'.repeat(64), name: '示例.png', url: 'https://img.pddpic.com/fixture/sample.png', shopId: 'fixture-shop', mime: 'image/png', bytes: 1024, width: 100, height: 100, uploadedAt: 1792152000000 };
const product = (id = 'guide', patch = {}) => ({ id, name: '示例资料', keywords: ['资料'], content: '领取地址：https://pan.example.test/guide?pwd=ABCD\n提取码：ABCD\n请保留这行说明', enabled: true, excludeKeywords: ['试看'], matchTarget: 'either', ...patch });
const reply = (id = 'help', patch = {}) => ({ id, name: '使用说明', keywords: ['怎么使用'], content: '使用说明：https://docs.example.test/guide\n按说明操作即可。', enabled: true, matchType: 'contains', priority: 75, delaySeconds: 2, weekSlots: [0, 1, 100], ...patch });
const source = patch => validateConfig({ greeting: '欢迎咨询示例资料', fallback: '请补充商品名称。', suffix: '请保留链接。', deliveryFallbackEnabled: true, deliveryFallback: '请查看领取说明。', products: [product()], replyRules: [reply()], ...patch });
const pack = patch => exportSharedContent(source(patch));

test('portable export is a strict content whitelist without sessions, jobs, media URLs or execution settings', () => {
  const result = exportSharedContent({ ...source({ running: true, autoReplyEnabled: true, autoRefundEnabled: true, autoListenOnLaunch: true, products: [product('guide', { images: [image] })] }), cookie: 'private', jobs: ['private'], shopId: 'private', profile: { token: 'private' } });
  const serialized = JSON.stringify(result);
  for (const secret of ['private', 'pddpic', 'fixture-shop', 'cookie', 'jobs', 'autoRefund', 'autoListen', 'running']) assert.ok(!serialized.includes(secret), secret);
  assert.equal(result.content.products[0].needsMedia, true);
  assert.deepEqual(result, validateSharedContent(JSON.parse(serialized)));
});

test('shared export and merge preserve text, links, matching strategies and local settings', () => {
  const current = source({ products: [], replyRules: [], cooldownSeconds: 77, replyDelaySeconds: 19, separateLinksEnabled: true, maxPerMinute: 7 });
  const preview = previewSharedImport(pack(), current);
  assert.equal(preview.config.products[0].content, product().content);
  assert.deepEqual(preview.config.products[0].keywords, ['资料']);
  assert.deepEqual(preview.config.replyRules[0], source().replyRules[0]);
  for (const key of ['cooldownSeconds', 'replyDelaySeconds', 'separateLinksEnabled', 'maxPerMinute']) assert.equal(preview.config[key], current[key]);
  assert.equal(preview.summary.add, 2);
  const runnable = { ...preview.config, running: true, autoReplyEnabled: true, autoDeliveryEnabled: true };
  assert.equal(planDelivery({ title: '示例资料', sku: '', paid: true }, runnable).content.includes(product().content), true);
  const messages = planReplies({ text: '怎么使用' }, { ...runnable, greetingEnabled: false, replyRules: runnable.replyRules.map(row => ({ ...row, weekSlots: [] })) }, { now: 1792152000000 });
  assert.equal(messages.some(row => row.content === reply().content), true);
});

test('all portable reply strategies round-trip and system rules stay in review', () => {
  const rules = ['contains', 'exact', 'wildcard', 'expression', 'system'].map((type, i) => reply('r' + i, { matchType: type, keywords: [type === 'expression' ? '资料 & 说明' : '使用*'] }));
  const value = pack({ replyRules: rules });
  assert.deepEqual(value.content.replyRules.map(row => row.matchType), ['contains', 'exact', 'wildcard', 'expression']);
  assert.deepEqual(value.review.excludedRules, [{ id: 'r4', name: '使用说明', reason: 'platform_system' }]);
  assert.equal(previewSharedImport(value, source({ replyRules: [] })).config.replyRules.length, 4);
});

test('legacy v1/v2 backups convert without bringing execution switches or unrelated data', () => {
  for (const version of [1, 2]) {
    const value = readSharedContent({ format: 'link-workbench-rules', version, config: { ...source({ autoReplyEnabled: true }), session: 'private' }, tasks: ['private'] });
    assert.deepEqual(value.content, pack().content);
    assert.ok(!JSON.stringify(value).includes('private'));
  }
  assert.throws(() => readSharedContent({ format: 'link-workbench-rules', version: 3, config: source() }));
});

test('merge uses stable IDs; same names with different IDs remain distinct', () => {
  const current = source({ products: [product('guide', { content: '旧正文' }), product('other')], replyRules: [] });
  const original = structuredClone(current), preview = previewSharedImport(pack(), current);
  assert.equal(preview.config.products.length, 2);
  assert.equal(preview.config.products[0].content, product().content);
  assert.equal(preview.config.products[1].id, 'other');
  assert.equal(preview.summary.update, 1);
  assert.equal(preview.summary.remove, 0);
  assert.deepEqual(current, original);
});

test('identical rules are recognized despite object field ordering, with no repeated updates', () => {
  const current = source(), preview = previewSharedImport(pack(), current);
  assert.equal(preview.summary.update, 0);
  assert.equal(preview.summary.unchanged, 2);
  assert.equal(preview.summary.settings, 0);
});

test('replace previews deletions but retains local platform system rules and conflicts', () => {
  const current = source({ products: [product('old')], replyRules: [reply('old'), reply('help', { matchType: 'system' }), reply('system', { matchType: 'system' })] });
  const preview = previewSharedImport(pack(), current, 'replace');
  assert.equal(preview.summary.remove, 2);
  assert.deepEqual(preview.config.products.map(row => row.id), ['guide']);
  assert.deepEqual(preview.config.replyRules.map(row => row.id), ['help', 'system']);
  assert.ok(preview.warnings.some(row => /编号/.test(row.reason)));
  assert.equal(preview.changes.filter(row => row.action === 'remove').every(row => row.before && row.after === null), true);
});

test('source or target rule media always requires disabled text review; top-level media stays intact', () => {
  const value = pack({ products: [product('guide', { images: [image] })], greetingImages: [image], greeting: '来自图片欢迎语' });
  const current = source({ greeting: '本机欢迎语', replyRules: [reply('help', { images: [image] })], fallbackImages: [image] });
  const preview = previewSharedImport(value, current);
  for (const row of [...preview.config.products, ...preview.config.replyRules]) { assert.equal(row.enabled, false); assert.deepEqual(row.images, []); }
  assert.equal(preview.config.greeting, current.greeting);
  assert.deepEqual(preview.config.fallbackImages, [image]);
  assert.equal(preview.summary.review, 4);
});

test('import cannot enable listening, reply, delivery, or refunds and leaves other runtime settings local', () => {
  const current = source({ running: true, autoListenOnLaunch: true, autoReplyEnabled: true, autoDeliveryEnabled: true, autoRefundEnabled: true, autoConfirmShipmentEnabled: false, replyBodySpaceRetryEnabled: true });
  const result = previewSharedImport(pack(), current).config;
  for (const key of ['running', 'autoListenOnLaunch', 'autoReplyEnabled', 'autoDeliveryEnabled', 'autoRefundEnabled']) assert.equal(result[key], false, key);
  assert.equal(result.autoConfirmShipmentEnabled, false);
  assert.equal(result.replyBodySpaceRetryEnabled, true);
});

test('strict shared schema rejects hidden fields at each nesting level and unknown versions', () => {
  const mutations = [
    value => { value.cookie = 'private'; },
    value => { value.source.shopId = 'private'; },
    value => { value.content.jobs = []; },
    value => { value.content.settings.autoReplyEnabled = true; },
    value => { value.content.products[0].images = [image]; },
    value => { value.content.replyRules[0].token = 'private'; },
    value => { value.content.replyRules[0].matchType = 'system'; },
    value => { value.review.token = 'private'; },
    value => { value.review.excludedRules = [{ id: 'x', name: 'x', reason: 'platform_system', url: 'https://example.test' }]; },
    value => { value.version = 99; },
    value => { value.content.products[0].needsMedia = 'false'; },
    value => { value.review.mediaSettings = ['unknown']; },
    value => { delete value.content.settings.greeting; },
    value => { value.content.products.push(value.content.products[0]); },
    value => { value.content.replyRules[0].weekSlots = [336]; },
    value => { value.content.replyRules[0].priority = -1; },
    value => { value.content.replyRules[0].matchType = 'expression'; value.content.replyRules[0].keywords = ['(']; },
  ];
  for (const mutate of mutations) { const value = pack(); mutate(value); assert.throws(() => validateSharedContent(value)); }
});

test('merge rejects combined list overflow instead of truncating either list', () => {
  const current = source({ products: Array.from({ length: 5000 }, (_, i) => product('p' + i)) });
  assert.throws(() => previewSharedImport(pack(), current), /5000/);
  assert.equal(previewSharedImport(pack(), current, 'replace').config.products.length, 1);
});

test('preview cancellation and running guards never invoke backup or update', () => {
  const session = new SharedImportDraft(), current = source(), preview = session.prepare(pack(), current);
  assert.equal('config' in preview, false);
  const callbacks = { idle: false, backup: () => assert.fail('backup'), update: () => assert.fail('update') };
  assert.throws(() => session.apply(preview.token, current, callbacks), /暂停/);
  assert.throws(() => session.apply(preview.token, { ...current, running: true }, { ...callbacks, idle: true }), /暂停/);
  session.cancel(preview.token);
  assert.throws(() => session.apply(preview.token, current, callbacks), /失效/);
});

test('changed rules require refreshed preview and invalidate earlier tokens', () => {
  const session = new SharedImportDraft(), current = source(), preview = session.prepare(pack(), current);
  const changed = source({ suffix: '本机新尾缀' });
  const callbacks = { idle: true, backup: () => assert.fail('backup'), update: () => assert.fail('update') };
  assert.throws(() => session.apply(preview.token, changed, callbacks), /已变化/);
  const refreshed = session.repreview(preview.token, changed, 'replace');
  assert.throws(() => session.apply(preview.token, changed, callbacks), /失效/);
  assert.equal(refreshed.mode, 'replace');
});

test('apply backs up first, uses the frozen preview, and cannot apply twice', () => {
  const session = new SharedImportDraft(), current = source(), value = pack(), preview = session.prepare(value, current);
  value.content.products[0].content = '文件后来改变';
  preview.changes.find(row => row.kind === 'product').after.content = '界面后来改变';
  const order = [];
  const callbacks = { idle: true, backup: config => { order.push('backup'); assert.deepEqual(config, current); }, update: config => { order.push('update'); assert.equal(config.products[0].content, product().content); } };
  session.apply(preview.token, current, callbacks);
  assert.deepEqual(order, ['backup', 'update']);
  assert.throws(() => session.apply(preview.token, current, callbacks), /失效/);
});

test('backup failure prevents updates and preserves preview for a safe retry', () => {
  const session = new SharedImportDraft(), current = source(), preview = session.prepare(pack(), current);
  assert.throws(() => session.apply(preview.token, current, { idle: true, backup: () => { throw Error('disk full'); }, update: () => assert.fail('update') }), /disk full/);
  assert.ok(session.require(preview.token));
});

test('applying content through the engine preserves completed receipts and deduplication across reload', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-content-test-'));
  t.after(() => {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('shared-content-test-')) throw Error('Unsafe cleanup');
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const filePath = path.join(directory, 'state.json');
  const engine = new Engine({ filePath, sendMessage: async () => ({ status: 'confirmed', messageId: 'fixture-receipt-10001' }) });
  engine.updateConfig(source({ running: true, autoDeliveryEnabled: true, autoConfirmShipmentEnabled: false }));
  const event = { shopId: 'fixture-shop', buyerId: 'fixture-buyer', orderId: 'fixture-order', itemId: 'fixture-item', title: '示例资料', paid: true };
  engine.ingestOrder(event);
  await engine.dispatch(engine.nextJob().id);
  engine.setRunning(false);
  const before = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const session = new SharedImportDraft(), current = engine.snapshot().config;
  const preview = session.prepare(pack({ products: [product('guide', { content: '更新后的示例资料说明' })] }), current);
  session.apply(preview.token, current, { idle: true, backup: () => {}, update: config => engine.updateConfig(config) });
  const after = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.deepEqual(after.jobs, before.jobs);
  assert.deepEqual(after.ledger, before.ledger);
  assert.equal(after.jobs[0].status, 'sent');
  assert.equal(after.jobs[0].sentMessageId, 'fixture-receipt-10001');
  const reloaded = new Engine({ filePath, sendMessage: async () => assert.fail('duplicate send') });
  reloaded.updateConfig({ ...reloaded.snapshot().config, running: true, autoDeliveryEnabled: true });
  reloaded.ingestOrder(event);
  assert.equal(reloaded.nextJob(), null);
  assert.equal(reloaded.snapshot().jobs.length, before.jobs.length);
});
