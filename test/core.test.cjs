'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Engine, defaults, matchProduct, validateConfig } = require('../src/core/engine.cjs');

const product = (id, keywords, content = `https://example.invalid/${id}`) => ({ id, name: id, keywords, excludeKeywords: [], content, enabled: true });
const order = (orderId = 'order-1', overrides = {}) => ({ shopId: 'shop-1', orderId, itemId: 'item-1', title: '示例商品 BT 版', buyerId: 'buyer-1', buyerName: '买家', paid: true, ...overrides });
const message = (messageId = 'msg-1', overrides = {}) => ({ shopId: 'shop-1', messageId, buyerId: 'buyer-1', buyerName: '买家', text: '你好', direction: 'incoming', ...overrides });

function fixture(t, options = {}) {
  const tempRoot = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(tempRoot, 'fulfillment-core-'));
  t.after(() => {
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(tempRoot + path.sep) || !path.basename(resolved).startsWith('fulfillment-core-')) throw new Error('Unsafe test cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  let time = 1800000000000;
  const calls = [];
  const filePath = path.join(directory, 'state.json');
  const sendMessage = options.sendMessage || (async (job) => { calls.push(job); return { status: 'confirmed', messageId: `sent-${job.id}` }; });
  const now = () => time;
  const engine = new Engine({ filePath, sendMessage, now });
  const configure = (extra = {}) => engine.updateConfig({ ...defaults, running: true, autoReplyEnabled: true, autoDeliveryEnabled: true, autoConfirmShipmentEnabled: false, products: [product('示例商品', ['示例商品'])], ...extra });
  return { engine, filePath, calls, configure, now, sendMessage, advance: (ms) => { time += ms; } };
}

test('configuration is normalized, isolated and rejects unsafe values', () => {
  const source = { products: [product('game', [' ＡＢＣ ', 'abc', ' '])] };
  const config = validateConfig(source);
  assert.deepEqual(config.products[0].keywords, ['ＡＢＣ']);
  assert.equal(config.running, false);
  source.products[0].content = 'changed';
  assert.notEqual(config.products[0].content, 'changed');
  assert.throws(() => validateConfig({ maxPerMinute: 0 }), /maxPerMinute/);
  assert.throws(() => validateConfig({ cooldownSeconds: -1 }), /cooldownSeconds/);
  assert.throws(() => validateConfig({ running: 'true' }), /布尔/);
  assert.throws(() => validateConfig({ products: [product('same', ['a']), product('same', ['b'])] }), /重复/);
  assert.throws(() => validateConfig({ products: [product('empty', [])] }), /关键词/);
});

test('product matching normalizes NFKC, case and whitespace, prioritizes specific phrases', () => {
  const products = [product('generic', ['示例商品']), product('specific', ['示例商品 BT版']), product('latin', ['GAMEＡ'])];
  assert.equal(matchProduct('示 例 商 品 ＢＴ 版资源', products).product.id, 'specific');
  assert.equal(matchProduct('game a 游戏', products).product.id, 'latin');
  assert.equal(matchProduct('未知商品', products).status, 'unmatched');
});

test('independent product hits and identical keywords are ambiguous; exclusions and disabled rows are respected', () => {
  const products = [product('game', ['示例商品', '商品']), product('gift', ['豪华礼包'])];
  assert.equal(matchProduct('示例商品 豪华礼包', products).status, 'ambiguous');
  assert.equal(matchProduct('示例商品', products).matches.length, 1);
  assert.equal(matchProduct('abc', [product('a', ['abc']), product('b', ['ＡＢＣ'])]).status, 'ambiguous');
  products[0].excludeKeywords = ['测试'];
  assert.equal(matchProduct('示例商品测试', products).status, 'unmatched');
  products[0].excludeKeywords = [];
  products[0].enabled = false;
  assert.equal(matchProduct('示例商品', products).status, 'unmatched');
});

test('a paid matching order produces one delivery with the common suffix', async (t) => {
  const { engine, configure, calls } = fixture(t);
  configure({ suffix: '统一领取说明' });
  const job = engine.ingestOrder(order());
  assert.equal(job.status, 'queued');
  assert.equal(job.content, 'https://example.invalid/示例商品\n\n统一领取说明');
  const sent = await engine.dispatch(job.id);
  assert.equal(sent.status, 'sent');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].status, 'sending');
  assert.equal(engine.snapshot().stats.deliverySent, 1);
  assert.equal(engine.ingestOrder(order()), null);
  await engine.dispatch(job.id);
  assert.equal(calls.length, 1);
});

test('unpaid orders cannot send and can advance to paid exactly once', async (t) => {
  const { engine, configure, calls } = fixture(t);
  configure();
  const unpaid = engine.ingestOrder(order('new-order', { paid: false }));
  assert.equal(unpaid.reason, 'unpaid');
  assert.equal((await engine.dispatch(unpaid.id)).status, 'blocked');
  const paid = engine.ingestOrder(order('new-order'));
  await engine.dispatch(paid.id);
  assert.equal(calls.length, 1);
  assert.equal(engine.ingestOrder(order('new-order')), null);
});

test('refunds and cancellations never deliver and invalidate an unsent task', async (t) => {
  const { engine, configure, calls } = fixture(t);
  configure();
  assert.equal(engine.ingestOrder(order('refund', { refunded: true })).reason, 'refunded');
  assert.equal(engine.ingestOrder(order('cancel', { cancelled: true })).reason, 'cancelled');
  const pending = engine.ingestOrder(order('pending'));
  assert.equal(engine.ingestOrder(order('pending', { refunded: true })), null);
  assert.equal((await engine.dispatch(pending.id)).status, 'blocked');
  assert.equal(engine.ingestOrder(order('pending')), null);
  const unpaid = engine.ingestOrder(order('unpaid-refund', { paid: false }));
  assert.equal(unpaid.reason, 'unpaid');
  engine.ingestOrder(order('unpaid-refund', { paid: false, refunded: true }));
  assert.equal(engine.ingestOrder(order('unpaid-refund')), null);
  assert.equal(calls.length, 0);
});

test('unmatched and ambiguous orders are blocked with no body or dispatch', async (t) => {
  const { engine, configure, calls } = fixture(t);
  configure({ products: [product('a', ['示例商品']), product('b', ['豪华礼包'])] });
  const unknown = engine.ingestOrder(order('unknown', { title: '未知' }));
  const ambiguous = engine.ingestOrder(order('ambiguous', { title: '示例商品豪华礼包' }));
  assert.equal(unknown.reason, 'no_match');
  assert.equal(ambiguous.reason, 'ambiguous_match');
  assert.equal(ambiguous.content, '');
  await engine.dispatch(unknown.id);
  await engine.dispatch(ambiguous.id);
  assert.equal(calls.length, 0);
});

test('startup is paused and toggling running never dispatches queued history', async (t) => {
  const { engine, configure, calls, filePath, now, sendMessage } = fixture(t);
  assert.equal(engine.snapshot().config.running, false);
  configure();
  const pending = engine.ingestOrder(order());
  engine.setRunning(false);
  assert.equal((await engine.dispatch(pending.id)).reason, 'paused');
  engine.setRunning(true);
  assert.equal(calls.length, 0);
  const restarted = new Engine({ filePath, now, sendMessage });
  assert.equal(restarted.snapshot().config.running, false);
  assert.equal(restarted.snapshot().jobs[0].status, 'queued');
  assert.equal(calls.length, 0);
});

test('switches gate live deliveries and replies', async (t) => {
  const { engine, configure, calls } = fixture(t);
  const paused = engine.ingestOrder(order());
  assert.equal(paused.reason, 'paused');
  configure({ autoDeliveryEnabled: false, autoReplyEnabled: false });
  const disabled = engine.ingestOrder(order('disabled'));
  const reply = engine.ingestMessage(message());
  assert.equal(disabled.reason, 'delivery_disabled');
  assert.equal(reply.reason, 'reply_disabled');
  await engine.dispatch(disabled.id);
  await engine.dispatch(reply.id);
  assert.equal(calls.length, 0);
});

test('simulation previews rules without live switches, dispatch or live dedupe/statistics', async (t) => {
  const { engine, configure, calls } = fixture(t);
  configure({ running: false, autoDeliveryEnabled: false, autoReplyEnabled: false });
  const before = engine.snapshot().stats;
  const preview = engine.ingestOrder(order(), { simulation: true });
  assert.equal(preview.status, 'simulated');
  assert.match(preview.content, /example\.invalid/);
  assert.equal((await engine.dispatch(preview.id)).status, 'simulated');
  const failedPreview = engine.ingestOrder(order('unpaid', { paid: false }), { simulation: true });
  assert.equal(failedPreview.status, 'simulated');
  assert.equal(failedPreview.reason, 'unpaid');
  assert.equal(failedPreview.content, '');
  assert.equal(engine.snapshot().stats.total, before.total);
  assert.equal(engine.snapshot().stats.sent, 0);
  configure();
  const live = engine.ingestOrder(order());
  await engine.dispatch(live.id);
  assert.equal(calls.length, 1);
});

test('first contact plans greeting and keyword separately so their delays are independent', async (t) => {
  const { engine, configure, advance, calls } = fixture(t);
  configure({ greeting: '欢迎', fallback: '请留言', replyRules: [{ id: 'trial', name: '试玩', keywords: ['试玩'], content: '试玩链接', enabled: true }] });
  const first = engine.ingestMessage(message('first', { text: '我要试玩' }));
  assert.equal(first.content, '欢迎');
  await engine.dispatch(first.id);
  const trial = engine.snapshot().jobs.find(job => job.replyRuleId === 'trial');
  assert.equal(trial.content, '试玩链接');
  await engine.dispatch(trial.id);
  advance(61000);
  const second = engine.ingestMessage(message('second', { text: '其他问题' }));
  assert.equal(second.content, '请留言');
  await engine.dispatch(second.id);
  assert.equal(calls.length, 3);
});

test('new consultation receives greeting alone, with defaults after the first one', (t) => {
  const { engine, configure, advance } = fixture(t);
  configure({ greeting: '欢迎来店', fallback: '默认答复' });
  assert.equal(engine.ingestMessage(message()).content, '欢迎来店');
  advance(61000);
  assert.equal(engine.ingestMessage(message('next')).content, '默认答复');
});

test('outgoing and duplicate events are ignored while cooldown inquiries remain queued per shop', (t) => {
  const { engine, configure, advance } = fixture(t);
  configure({ greeting: '相同答复', fallback: '相同答复' });
  assert.equal(engine.ingestMessage(message('out', { direction: 'outgoing' })), null);
  const first = engine.ingestMessage(message());
  assert.ok(first);
  assert.equal(engine.ingestMessage(message()), null);
  const waiting = engine.ingestMessage(message('fast'));
  assert.equal(waiting.status, 'queued'); assert.equal(waiting.reason, 'cooldown');
  assert.equal(waiting.notBefore, first.createdAt + 60000);
  assert.ok(engine.ingestMessage(message('same-buyer-other-shop', { shopId: 'shop-2' })));
  advance(61000);
  assert.equal(engine.ingestMessage(message('fast')), null, 'the queued source must not create a second task');
  assert.ok(engine.ingestMessage(message('after-cooldown')));
});

test('simulated messages do not consume first greeting, cooldown or message IDs', (t) => {
  const { engine, configure } = fixture(t);
  configure({ greeting: '第一次欢迎' });
  engine.ingestMessage(message(), { simulation: true });
  const live = engine.ingestMessage(message());
  assert.equal(live.content, '第一次欢迎');
  assert.equal(engine.snapshot().stats.total, 1);
});

test('confirmed live events remain deduplicated after restart and log clearing', async (t) => {
  const { engine, configure, filePath, now, sendMessage, calls } = fixture(t);
  configure();
  const delivery = engine.ingestOrder(order());
  const reply = engine.ingestMessage(message());
  await engine.dispatch(delivery.id);
  await engine.dispatch(reply.id);
  engine.clearLogs();
  assert.equal(engine.snapshot().logs.length, 0);
  const restarted = new Engine({ filePath, now, sendMessage });
  restarted.setRunning(true);
  assert.equal(restarted.ingestOrder(order()), null);
  assert.equal(restarted.ingestMessage(message()), null);
  assert.equal(restarted.snapshot().stats.sent, 2);
  assert.equal(calls.length, 2);
});

test('dispatch is serialized, persists sending before the adapter, and ignores repeat dispatches', async (t) => {
  let release;
  let filePath;
  const entered = [];
  const state = fixture(t, {
    sendMessage: async (job) => {
      entered.push(job.id);
      const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      assert.equal(persisted.jobs.find((row) => row.id === job.id).status, 'sending');
      if (entered.length === 1) await new Promise((resolve) => { release = resolve; });
      return { status: 'confirmed' };
    },
  });
  filePath = state.filePath;
  state.configure();
  const first = state.engine.ingestOrder(order('one'));
  const second = state.engine.ingestOrder(order('two'));
  const firstDispatch = state.engine.dispatch(first.id);
  const duplicateDispatch = state.engine.dispatch(first.id);
  const secondDispatch = state.engine.dispatch(second.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(entered, [first.id]);
  release();
  await Promise.all([firstDispatch, duplicateDispatch, secondDispatch]);
  assert.deepEqual(entered, [first.id, second.id]);
});

test('thrown send, uncertain send and invalid acknowledgement stay uncertain with no automatic retry', async (t) => {
  let count = 0;
  const { engine, configure } = fixture(t, {
    sendMessage: async () => {
      count += 1;
      if (count === 1) throw new Error('network disconnected');
      if (count === 2) return { status: 'uncertain' };
      return {};
    },
  });
  configure();
  const jobs = ['throws', 'unknown', 'invalid'].map((id) => engine.ingestOrder(order(id)));
  for (const job of jobs) {
    assert.equal((await engine.dispatch(job.id)).status, 'uncertain');
    assert.equal((await engine.dispatch(job.id)).status, 'uncertain');
    assert.equal(engine.ingestOrder(order(job.orderId)), null);
  }
  assert.equal(count, 3);
  assert.equal(engine.snapshot().stats.sent, 0);
  engine.resolveUncertain(jobs[0].id, 'sent');
  engine.resolveUncertain(jobs[1].id, 'cancelled');
  assert.equal(engine.snapshot().stats.sent, 1);
  assert.equal(engine.snapshot().stats.uncertain, 1);
  await engine.dispatch(jobs[1].id);
  assert.equal(count, 3);
  assert.throws(() => engine.resolveUncertain(jobs[0].id, 'sent'), /结果不明/);
});

test('a process restart recovers interrupted sends as uncertain and cannot resend them', async (t) => {
  const { engine, configure, filePath, now, calls, sendMessage } = fixture(t);
  configure();
  const pending = engine.ingestOrder(order());
  const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  state.jobs[0].status = 'sending';
  fs.writeFileSync(filePath, JSON.stringify(state));
  const restarted = new Engine({ filePath, now, sendMessage });
  const recovered = restarted.snapshot().jobs[0];
  assert.equal(recovered.status, 'uncertain');
  assert.equal(recovered.reason, 'startup_recovery');
  assert.equal(restarted.snapshot().config.running, false);
  restarted.setRunning(true);
  await restarted.dispatch(pending.id);
  assert.equal(restarted.ingestOrder(order()), null);
  assert.equal(calls.length, 0);
});

test('rate limit counts persisted attempts including uncertain sends across restarts', async (t) => {
  let attempts = 0;
  const { engine, configure, now, filePath, advance, sendMessage } = fixture(t, { sendMessage: async () => { attempts += 1; return { status: 'uncertain' }; } });
  configure({ maxPerMinute: 1 });
  await engine.dispatch(engine.ingestOrder(order('first')).id);
  const second = engine.ingestOrder(order('second'));
  assert.equal((await engine.dispatch(second.id)).reason, 'rate_limit');
  assert.equal(attempts, 1);
  const restarted = new Engine({ filePath, now, sendMessage });
  restarted.setRunning(true);
  assert.equal((await restarted.dispatch(second.id)).reason, 'rate_limit');
  assert.equal(attempts, 1);
  advance(60000);
  assert.equal((await restarted.dispatch(second.id)).status, 'uncertain');
  assert.equal(attempts, 2);
});

test('atomic updates keep a readable backup; damaged main data is preserved instead of silently resetting', (t) => {
  const { engine, filePath, now, sendMessage } = fixture(t);
  const before = fs.readFileSync(filePath, 'utf8');
  engine.updateConfig({ ...defaults, suffix: '新的后缀' });
  assert.equal(fs.readFileSync(`${filePath}.bak`, 'utf8'), before);
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).config.suffix, '新的后缀');
  const broken = '{not valid json';
  fs.writeFileSync(filePath, broken);
  assert.throws(() => new Engine({ filePath, now, sendMessage }), /原文件已保留/);
  assert.equal(fs.readFileSync(filePath, 'utf8'), broken);
  assert.equal(fs.readFileSync(`${filePath}.bak`, 'utf8'), before);
});

test('a failure to persist sending prevents any adapter call and leaves a retryable unsent task', async (t) => {
  const { engine, configure, filePath, calls } = fixture(t);
  configure();
  const job = engine.ingestOrder(order());
  const original = fs.renameSync;
  const mock = t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === filePath) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return original(from, to);
  });
  await assert.rejects(engine.dispatch(job.id), /disk full/);
  assert.equal(calls.length, 0);
  assert.equal(engine.snapshot().jobs[0].status, 'queued');
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).jobs[0].status, 'queued');
  mock.mock.restore();
  assert.equal((await engine.dispatch(job.id)).status, 'sent');
  assert.equal(calls.length, 1);
});

test('a persistence failure after sending stays uncertain both in memory and after restart', async (t) => {
  let filePath;
  let mock;
  const original = fs.renameSync;
  const { engine, configure, filePath: target, now } = fixture(t, { sendMessage: async () => {
    mock = t.mock.method(fs, 'renameSync', (from, to) => {
      if (to === filePath) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return original(from, to);
    });
    return { status: 'confirmed' };
  } });
  filePath = target;
  configure();
  const job = engine.ingestOrder(order());
  await assert.rejects(engine.dispatch(job.id), /禁止自动重试/);
  assert.equal(engine.snapshot().jobs[0].status, 'uncertain');
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).jobs[0].status, 'sending');
  mock.mock.restore();
  const restarted = new Engine({ filePath, now, sendMessage: async () => { throw new Error('must not resend'); } });
  assert.equal(restarted.snapshot().jobs[0].status, 'uncertain');
  assert.equal((await restarted.dispatch(job.id)).status, 'uncertain');
});

test('syntactically valid damage to dedupe and configuration is rejected without reset', (t) => {
  const { engine, configure, filePath, now, sendMessage } = fixture(t);
  configure();
  engine.ingestMessage(message());
  const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  state.ledger.messages['["shop-1","msg-1"]'] = false;
  fs.writeFileSync(filePath, JSON.stringify(state));
  assert.throws(() => new Engine({ filePath, now, sendMessage }), /消息去重账本已损坏/);
  state.ledger.messages['["shop-1","msg-1"]'] = { at: now() };
  delete state.config.products;
  fs.writeFileSync(filePath, JSON.stringify(state));
  assert.throws(() => new Engine({ filePath, now, sendMessage }), /设置不完整/);
});

test('snapshots and returned jobs cannot mutate live state', (t) => {
  const { engine, configure } = fixture(t);
  configure();
  const job = engine.ingestOrder(order());
  job.status = 'sent';
  const snapshot = engine.snapshot();
  snapshot.config.products[0].content = 'evil';
  snapshot.jobs.length = 0;
  assert.equal(engine.snapshot().jobs[0].status, 'queued');
  assert.match(engine.snapshot().config.products[0].content, /^https:/);
});

test('pruning old UI jobs never prunes the permanent live event ledger', async (t) => {
  const { engine, configure, filePath, now, sendMessage, calls } = fixture(t);
  configure();
  const first = engine.ingestOrder(order('old-order'));
  await engine.dispatch(first.id);
  const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const base = state.jobs[0];
  for (let index = 0; index < 1005; index += 1) state.jobs.push({ ...base, id: `fixture-${index}`, orderId: `fixture-order-${index}` });
  fs.writeFileSync(filePath, JSON.stringify(state));
  const restarted = new Engine({ filePath, now, sendMessage });
  restarted.clearLogs();
  assert.equal(restarted.snapshot().jobs.length, 1000);
  assert.equal(restarted.snapshot().jobs.some((job) => job.id === first.id), false);
  restarted.setRunning(true);
  assert.equal(restarted.ingestOrder(order('old-order')), null);
  assert.equal(calls.length, 1);
});

test('order line and shop identity are independent dedupe domains', async (t) => {
  const { engine, configure, calls } = fixture(t);
  configure();
  for (const event of [order(), order('order-1', { itemId: 'item-2' }), order('order-1', { shopId: 'shop-2' })]) {
    await engine.dispatch(engine.ingestOrder(event).id);
  }
  assert.equal(calls.length, 3);
});
