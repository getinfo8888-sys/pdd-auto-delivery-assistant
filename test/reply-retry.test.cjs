'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Engine, defaults, validateConfig } = require('../src/core/engine.cjs');
const duplicate = { status: 'rejected', reason: '请勿重复发送相同消息' };
const sha = value => createHash('sha256').update(value).digest('hex');

function fixture(t) {
  const root = path.resolve(os.tmpdir()), directory = fs.mkdtempSync(path.join(root, 'pdd-retry-'));
  t.after(() => {
    if (path.dirname(directory) !== root || !path.basename(directory).startsWith('pdd-retry-')) throw Error('Unsafe cleanup');
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let now = 1800000000000, response = duplicate;
  const filePath = path.join(directory, 'state.json'), calls = [], sourceAt = now - 10000;
  const sendMessage = async job => { calls.push(structuredClone(job)); if (response instanceof Error) throw response; return response; };
  const create = () => new Engine({ filePath, sendMessage, now: () => now });
  const engine = create();
  engine.updateConfig({ ...defaults, running: true, autoReplyEnabled: true, catchUpUnrepliedEnabled: true,
    greetingEnabled: false, fallback: '原始自动答复', replySuffixEnabled: true, cooldownSeconds: 0, maxPerMinute: 120 });
  const message = (extra = {}) => ({ shopId: 'test-shop', buyerId: 'test-buyer', messageId: 'test-source',
    direction: 'incoming', text: '咨询', pending: true, sentAt: sourceAt, type: '0', subType: '0', ...extra });
  return { engine, filePath, create, calls, message, now: () => now, advance: ms => { now += ms; },
    advanceTo: value => { now = value; }, respond: value => { response = value; } };
}

async function legacyDuplicate(f, extra = {}) {
  // Create a real recovery claim, then retain a fixture of the older release's
  // terminal duplicate outcome. This never touches production state.
  f.respond({ status: 'rejected', reason: 'fixture legacy rejection' });
  const recovered = f.engine.recoverUnrepliedMessage(f.message());
  await f.engine.dispatch(recovered.job.id);
  const state = JSON.parse(fs.readFileSync(f.filePath));
  const old = state.jobs.find(job => job.id === recovered.job.id);
  old.detail = duplicate.reason;
  if (extra.manualReason) {
    state.jobs.push({ ...structuredClone(old), id: 'manual-stop', status: 'cancelled', reason: extra.manualReason });
    state.counts.total++; state.counts.cancelled++;
  }
  fs.writeFileSync(f.filePath, JSON.stringify(state));
  const engine = f.create(); engine.setRunning(true);
  return { engine, old, state };
}

async function afterThreeDuplicates(f) {
  const job = f.engine.ingestMessage(f.message()); let waiting;
  for (let index = 0; index < 3; index++) { waiting = await f.engine.dispatch(job.id); f.advanceTo(waiting.nextAttemptAt); }
  return { job, waiting };
}

function assertThreeBodySpaces(attempt, original) {
  assert.equal(attempt.content, original); assert.equal(attempt.replySuffixApplied, 'time-tag');
  const offsets = attempt.replyBodySpaceOffsets;
  assert.equal(offsets.length, 3); assert.equal(new Set(offsets).size, 3);
  assert.deepEqual(offsets, offsets.toSorted((a, b) => a - b));
  let expected = original;
  for (const offset of [...offsets].reverse()) expected = expected.slice(0, offset) + ' ' + expected.slice(offset);
  assert.equal(expected.length, original.length + 3);
  assert.equal(attempt.wireContent.slice(0, expected.length), expected);
  assert.match(attempt.wireContent.slice(expected.length), /^\n\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\n〔消息标记：[A-Z0-9]{6}〕$/u);
  assert.equal(attempt.wireContentSha256, sha(attempt.wireContent));
  return expected;
}

test('an explicit duplicate rejection is persisted as waiting with its exact failed payload hash', async t => {
  const f = fixture(t), job = f.engine.ingestMessage(f.message());
  const result = await f.engine.dispatch(job.id), attempted = f.calls[0];
  assert.equal(result.status, 'queued'); assert.equal(result.reason, 'reply_retry_wait');
  assert.equal(result.replyRetryCount, 1); assert.equal(result.replyRetrySuffixMode, 'time');
  assert.equal(result.needsReplyVerification, true); assert.equal(result.nextAttemptAt, f.now() + 3000);
  assert.deepEqual(result.replyAttemptHistory, [{ at: attempted.attemptedAt, sha: sha(attempted.wireContent), suffixMode: attempted.replySuffixApplied, error: duplicate.reason }]);
  for (const key of ['wireContent', 'wireContentSha256', 'wireContentLength', 'replySuffixApplied', 'replySuffixProfile', 'outbound']) assert.equal(Object.hasOwn(result, key), false);
  assert.equal(f.engine.snapshot().stats.blocked, 0); assert.equal(f.engine.snapshot().stats.sent, 0);
  assert.equal(JSON.parse(fs.readFileSync(f.filePath)).jobs[0].replyRetryCount, 1);
  assert.equal(f.engine.nextJob(), null); await f.engine.dispatch(job.id); assert.equal(f.calls.length, 1);
});

test('duplicate retries back off to a five-minute ceiling without a permanent attempt limit', async t => {
  const f = fixture(t), job = f.engine.ingestMessage(f.message());
  const expected = [3000, 10000, 30000, 60000, 120000, 300000, 300000];
  for (const [index, delay] of expected.entries()) {
    const result = await f.engine.dispatch(job.id);
    assert.equal(result.replyRetryCount, index + 1); assert.equal(result.nextAttemptAt, f.now() + delay);
    assert.equal(result.status, 'queued'); assert.equal(f.engine.snapshot().stats.blocked, 0);
    f.advanceTo(result.nextAttemptAt);
  }
  assert.equal(f.calls.length, 7);
});

test('all retries preserve the exact rule text while later attempts add a fresh time and random tag', async t => {
  const f = fixture(t);
  const original = f.engine.ingestMessage(f.message());
  const first = await f.engine.dispatch(original.id);
  assert.equal(first.content, original.content); assert.equal(first.replyRetryFallbackApplied, undefined);
  f.advanceTo(first.nextAttemptAt);
  const second = await f.engine.dispatch(original.id);
  assert.equal(f.calls[1].content, original.content); assert.equal(f.calls[1].replySuffixApplied, 'time');
  assert.match(f.calls[1].wireContent, /\n\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u);
  assert.notEqual(f.calls[1].wireContentSha256, f.calls[0].wireContentSha256);
  assert.equal(second.retryOriginalContent, undefined); assert.equal(second.replyRetryFallbackApplied, undefined);
  assert.equal(second.content, original.content); assert.equal(second.replyRetryTag, true); assert.equal(second.replyRetrySuffixMode, 'time-tag');
  f.advanceTo(second.nextAttemptAt); const third = await f.engine.dispatch(original.id);
  f.respond({ status: 'confirmed', messageId: '10001' }); f.advanceTo(third.nextAttemptAt);
  const sent = await f.engine.dispatch(original.id);
  const tags = [];
  for (const attempted of f.calls.slice(2)) {
    assert.equal(attempted.content, original.content); assert.equal(attempted.replySuffixApplied, 'time-tag');
    assert.equal(attempted.wireContent.startsWith(original.content + '\n'), true);
    assert.match(attempted.wireContent, /\n\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\n〔消息标记：[A-Z0-9]{6}〕$/u);
    assert.equal(attempted.wireContentSha256, sha(attempted.wireContent));
    tags.push(attempted.wireContent.match(/〔消息标记：([A-Z0-9]{6})〕$/u)[1]);
  }
  assert.notEqual(tags[0], tags[1]);
  assert.deepEqual(sent.replyAttemptHistory.map(row => row.sha), f.calls.slice(0, 3).map(row => row.wireContentSha256));
  assert.equal(f.engine.snapshot().config.replySuffixMode, 'invisible');
  assert.equal(sent.status, 'sent'); assert.equal(sent.sentMessageId, '10001'); assert.equal(sent.detail, undefined);
  assert.equal(f.engine.snapshot().stats.replySent, 1); assert.equal(f.engine.snapshot().stats.blocked, 0);
  assert.equal(f.engine.nextJob(), null); await f.engine.dispatch(original.id); assert.equal(f.calls.length, 4);
  assert.equal(f.engine.preparePendingReplyRetries(), 0);
});

test('an initially successful reply retains its configured original content', async t => {
  const f = fixture(t); f.respond({ status: 'confirmed', messageId: '10001' });
  const job = f.engine.ingestMessage(f.message()), sent = await f.engine.dispatch(job.id);
  assert.equal(sent.content, job.content); assert.equal(sent.retryOriginalContent, undefined);
  assert.equal(sent.replyRetryFallbackApplied, undefined); assert.equal(sent.replyRetryCount, undefined);
  assert.equal(f.calls.length, 1);
});

test('a known preflight deferral reuses its persisted retry wire rather than rebuilding it', async t => {
  const f = fixture(t), job = f.engine.ingestMessage(f.message());
  const failed = await f.engine.dispatch(job.id); f.advanceTo(failed.nextAttemptAt);
  f.respond({ status: 'deferred', reason: '尚未提交' }); const deferred = await f.engine.dispatch(job.id);
  assert.equal(deferred.replyRetryCount, 1); assert.equal(deferred.wireContent, f.calls[1].wireContent);
  f.advanceTo(deferred.nextAttemptAt); f.respond({ status: 'confirmed', messageId: '10001' }); await f.engine.dispatch(job.id);
  assert.equal(f.calls[2].wireContent, f.calls[1].wireContent); assert.equal(f.calls[2].wireContentSha256, f.calls[1].wireContentSha256);
});

test('unknown outcomes keep the original wire and never automatically repeat even after opening again', async t => {
  for (const response of [{ status: 'uncertain' }, {}, Error('connection lost')]) {
    const f = fixture(t), original = f.engine.ingestMessage(f.message());
    const rejected = await f.engine.dispatch(original.id); f.advanceTo(rejected.nextAttemptAt);
    f.respond(response); const outcome = await f.engine.dispatch(original.id);
    assert.equal(outcome.status, 'uncertain'); assert.equal(outcome.wireContent, f.calls[1].wireContent);
    const reopened = f.create(); reopened.setRunning(true);
    assert.equal(reopened.preparePendingReplyRetries(), 0); assert.equal(reopened.nextJob(), null);
    assert.equal(reopened.recoverUnrepliedMessage(f.message()).status, 'already_handled');
    await reopened.dispatch(original.id); assert.equal(f.calls.length, 2);
  }
});

test('opening preserves the original body and random-tag stage and can advance only a pending retry time', async t => {
  const f = fixture(t), job = f.engine.ingestMessage(f.message());
  let waiting = await f.engine.dispatch(job.id); f.advanceTo(waiting.nextAttemptAt);
  waiting = await f.engine.dispatch(job.id);
  const savedBody = waiting.content;
  const reopened = f.create(); reopened.setRunning(true);
  assert.equal(reopened.nextJob(), null); assert.equal(reopened.preparePendingReplyRetries(), 1);
  const next = reopened.nextJob(); assert.equal(next.id, job.id); assert.equal(next.content, savedBody);
  assert.equal(next.retryOriginalContent, undefined); assert.equal(next.replyRetryFallbackApplied, undefined);
  assert.equal(next.replyRetryTag, true); assert.equal(next.replyRetrySuffixMode, 'time-tag');
  assert.equal(next.replyRetryCount, 2); assert.equal(next.needsReplyVerification, true); assert.equal(next.nextAttemptAt, f.now());
  f.respond({ status: 'confirmed', messageId: '10001' }); await reopened.dispatch(next.id);
  assert.equal(f.calls.at(-1).content, savedBody); assert.equal(reopened.nextJob(), null);
});

test('start retry preparation keeps an explicitly configured initial delay intact', async t => {
  const f = fixture(t), legacy = await legacyDuplicate(f);
  legacy.engine.updateConfig({ ...legacy.engine.snapshot().config, replyDelaySeconds: 120 });
  const recovered = legacy.engine.recoverUnrepliedMessage(f.message()); assert.equal(recovered.status, 'created');
  const notBefore = recovered.job.notBefore;
  assert.equal(notBefore, f.now() + 120000); assert.equal(legacy.engine.preparePendingReplyRetries(), 1);
  assert.equal(legacy.engine.snapshot().jobs.find(row => row.id === recovered.job.id).notBefore, notBefore);
  assert.equal(legacy.engine.nextJob(), null); await legacy.engine.dispatch(recovered.job.id); assert.equal(f.calls.length, 1);
});

test('official pending recovery automatically rescues an old blocked duplicate despite its permanent old claim', async t => {
  const f = fixture(t), legacy = await legacyDuplicate(f);
  assert.equal(Object.keys(legacy.state.ledger.replyRecovery).length, 1);
  const recovery = legacy.engine.recoverUnrepliedMessage(f.message());
  assert.equal(recovery.status, 'created'); assert.equal(recovery.job.retryRejectedJobId, legacy.old.id);
  assert.equal(recovery.job.replyRetrySuffixMode, 'time'); assert.equal(recovery.job.replyRetryCount, 1);
  const stored = JSON.parse(fs.readFileSync(f.filePath));
  assert.equal(stored.jobs.find(row => row.id === legacy.old.id).status, 'blocked');
  assert.equal(stored.jobs.find(row => row.id === legacy.old.id).retryJobId, recovery.job.id);
  assert.equal(Object.keys(stored.ledger.replyRecovery).length, 2);
  assert.equal(legacy.engine.recoverUnrepliedMessage(f.message()).status, 'queued');
  f.respond(duplicate); const queued = await legacy.engine.dispatch(recovery.job.id);
  assert.equal(queued.status, 'queued'); assert.equal(queued.replyRetryCount, 2);
  assert.equal(legacy.engine.recoverUnrepliedMessage(f.message()).status, 'queued');
});

test('a later manual reply or changed official conversation stops the retry without reviving it', async t => {
  for (const kind of ['manual', 'changed']) {
    const f = fixture(t), job = f.engine.ingestMessage(f.message()); const waiting = await f.engine.dispatch(job.id);
    if (kind === 'manual') {
      f.engine.ingestMessage(f.message({ messageId: 'manual-reply', direction: 'outgoing', text: '人工已处理', sentAt: f.now() }));
    } else {
      f.advanceTo(waiting.nextAttemptAt); f.respond({ status: 'skipped', reason: '出现新咨询' }); await f.engine.dispatch(job.id);
    }
    assert.equal(f.engine.snapshot().jobs[0].status, 'cancelled'); assert.equal(f.engine.preparePendingReplyRetries(), 0);
    assert.equal(f.engine.recoverUnrepliedMessage(f.message()).status, 'needs_review');
    const count = f.calls.length; await f.engine.dispatch(job.id); assert.equal(f.calls.length, count);
  }
});

test('historical duplicate recovery never bypasses a real manual cancellation', async t => {
  for (const manualReason of ['manual_intervention', 'manual_cancelled']) {
    const f = fixture(t), legacy = await legacyDuplicate(f, { manualReason });
    const before = legacy.engine.snapshot();
    assert.equal(legacy.engine.recoverUnrepliedMessage(f.message()).status, 'needs_review');
    assert.deepEqual(legacy.engine.snapshot(), before);
  }
});

test('reply duplicate retries and delivery failure retries preserve their own configured content', async t => {
  const f = fixture(t); f.engine.updateConfig({ ...f.engine.snapshot().config, autoDeliveryEnabled: true,
    products: [{ id: 'game', name: '游戏', keywords: ['游戏'], content: '发货链接', enabled: true }] });
  const order = f.engine.ingestOrder({ shopId: 'test-shop', buyerId: 'test-buyer', orderId: 'order', itemId: 'goods', title: '游戏', paid: true });
  const delivered = await f.engine.dispatch(order.id);
  assert.equal(delivered.status, 'queued'); assert.equal(delivered.deliveryRetryCount,1);assert.equal(delivered.content, order.content);
  assert.equal(delivered.replyRetryCount, undefined); assert.equal(delivered.replyRetryFallbackApplied, undefined);
  f.respond({ status: 'rejected', reason: '平台拒绝其他操作' });
  const reply = f.engine.ingestMessage(f.message()); const stopped = await f.engine.dispatch(reply.id);
  assert.equal(stopped.status, 'blocked'); assert.equal(stopped.replyRetryCount, undefined);
  await f.engine.dispatch(reply.id); assert.equal(f.calls.length, 2);
});

test('failed-attempt history stays bounded while retry scheduling continues past thirty failures', async t => {
  const f = fixture(t), job = f.engine.ingestMessage(f.message());
  for (let index = 0; index < 33; index++) {
    const result = await f.engine.dispatch(job.id); assert.equal(result.status, 'queued'); f.advanceTo(result.nextAttemptAt);
  }
  const result = f.engine.snapshot().jobs[0];
  assert.equal(result.replyRetryCount, 33); assert.equal(result.replyAttemptHistory.length, 30);
  assert.equal(result.replyAttemptHistory[0].sha, f.calls[3].wireContentSha256);
  assert.equal(result.replyAttemptHistory.at(-1).sha, f.calls.at(-1).wireContentSha256);
  const reopened = f.create(); reopened.setRunning(true);
  assert.equal(reopened.nextJob().id, job.id); assert.equal(reopened.snapshot().jobs[0].replyRetryCount, 33);
});

test('obsolete fallback settings are ignored without losing the actual configured rules or shop settings', t => {
  const f = fixture(t);
  f.engine.updateConfig({ ...f.engine.snapshot().config, products: [{ id: 'game', name: '游戏', keywords: ['游戏'], content: '测试链接' }],
    replyRules: [{ id: 'trial', name: '试玩', keywords: ['试玩'], content: '体验说明' }], replyRetryFallback: '自定义补答' });
  const before = f.engine.snapshot().config;
  assert.equal(Object.hasOwn(before, 'replyRetryFallback'), false);
  const stored = JSON.parse(fs.readFileSync(f.filePath)); stored.config.replyRetryFallback = '旧版本错误替代正文'; delete stored.config.replyBodySpaceRetryEnabled; fs.writeFileSync(f.filePath, JSON.stringify(stored));
  const loaded = f.create().snapshot().config;
  assert.equal(Object.hasOwn(loaded, 'replyRetryFallback'), false); assert.equal(Object.hasOwn(defaults, 'replyRetryFallback'), false);
  assert.deepEqual(loaded.products, before.products); assert.deepEqual(loaded.replyRules, before.replyRules);
  assert.equal(loaded.autoReplyEnabled, before.autoReplyEnabled); assert.equal(loaded.autoDeliveryEnabled, before.autoDeliveryEnabled);
  assert.equal(loaded.replyBodySpaceRetryEnabled, false);
  assert.equal(validateConfig({ replyRetryFallback: { ignored: true } }).fallback, defaults.fallback);
  assert.throws(() => validateConfig({ replySuffixMode: 'time-tag' }), /选项/);
  assert.throws(() => validateConfig({ replyBodySpaceRetryEnabled: 'true' }), /布尔/);
});

test('legacy replaced retry bodies are restored before a queued or explicitly rejected task continues', async t => {
  for (const status of ['queued', 'blocked']) {
    const f = fixture(t), original = f.engine.ingestMessage(f.message());
    let waiting = await f.engine.dispatch(original.id); f.advanceTo(waiting.nextAttemptAt); waiting = await f.engine.dispatch(original.id);
    const stored = JSON.parse(fs.readFileSync(f.filePath)), old = stored.jobs[0];
    old.retryOriginalContent = original.content; old.replyRetryFallbackApplied = true; old.content = '旧版本错误替代正文';
    old.replyRetrySuffixMode = 'time'; old.status = status;
    if (status === 'blocked') {
      old.reason = 'operation_rejected'; old.detail = duplicate.reason; stored.counts.blocked++;
      old.wireContent = old.content + '\n2026-10-16 12:00:00'; old.wireContentSha256 = sha(old.wireContent); old.replySuffixApplied = 'time';
      old.replyAttemptHistory = [];
    }
    fs.writeFileSync(f.filePath, JSON.stringify(stored));
    const reopened = f.create(); reopened.setRunning(true);
    const restored = reopened.snapshot().jobs[0];
    assert.equal(restored.content, original.content); assert.equal(restored.legacyReplacedContent, '旧版本错误替代正文');
    assert.equal(restored.replyRetryFallbackApplied, undefined); assert.equal(restored.replyRetryTag, true);
    assert.equal(restored.replyRetrySuffixMode, 'time-tag'); assert.equal(restored.wireContent, undefined);
    let next;
    if (status === 'blocked') {
      assert.equal(restored.replyAttemptHistory.at(-1).sha, old.wireContentSha256);
      const recovered = reopened.recoverUnrepliedMessage(f.message()); assert.equal(recovered.status, 'created'); next = recovered.job;
    } else { reopened.preparePendingReplyRetries(); next = reopened.nextJob(); }
    f.respond({ status: 'confirmed', messageId: '10001' }); await reopened.dispatch(next.id);
    assert.equal(f.calls.at(-1).content, original.content); assert.equal(f.calls.at(-1).replySuffixApplied, 'time-tag');
  }
});

test('legacy successful or unknown replaced payloads remain truthful history and never become new sends', async t => {
  for (const status of ['sent', 'uncertain', 'sending']) {
    const f = fixture(t); f.respond(status === 'sent' ? { status: 'confirmed', messageId: '10001' } : { status: 'uncertain' });
    const original = f.engine.ingestMessage(f.message()); await f.engine.dispatch(original.id);
    const stored = JSON.parse(fs.readFileSync(f.filePath)), old = stored.jobs[0];
    old.content = '历史已提交的替代正文'; old.retryOriginalContent = original.content; old.replyRetryFallbackApplied = true;
    old.replyRetryCount = 2; old.replyRetrySuffixMode = 'time'; old.status = status;
    old.wireContent = old.content + '\n2026-10-16 12:00:00'; old.wireContentSha256 = sha(old.wireContent); old.replySuffixApplied = 'time';
    fs.writeFileSync(f.filePath, JSON.stringify(stored));
    const reopened = f.create(); reopened.setRunning(true);
    const historical = reopened.snapshot().jobs[0];
    assert.equal(historical.content, old.content); assert.equal(historical.wireContent, old.wireContent);
    assert.equal(historical.status, status === 'sending' ? 'uncertain' : status);
    assert.equal(reopened.preparePendingReplyRetries(), 0); assert.equal(reopened.nextJob(), null);
    assert.equal(reopened.recoverUnrepliedMessage(f.message()).status, 'already_handled');
    await reopened.dispatch(original.id); assert.equal(f.calls.length, 1);
  }
});

test('only after three duplicate rejections can an enabled reply add exactly three safe body spaces', async t => {
  const f = fixture(t), original = '本店提供自动发货，请先查看试玩说明，再告诉我游戏名称。\n下载：https://example.invalid/resource?pwd=AbC1\n提取码：AbC1';
  f.engine.updateConfig({ ...f.engine.snapshot().config, fallback: original, replyBodySpaceRetryEnabled: true });
  const { job, waiting } = await afterThreeDuplicates(f);
  assert.equal(waiting.replyRetryCount, 3); assert.equal(waiting.replyRetryBodySpaces, true);
  for (const attempt of f.calls) { assert.equal(attempt.content, original); assert.equal(attempt.replyBodySpaceOffsets, undefined); }
  const fourth = await f.engine.dispatch(job.id), body = assertThreeBodySpaces(f.calls[3], original);
  assert.equal(body.includes('https://example.invalid/resource?pwd=AbC1'), true);
  assert.match(body, /提\s*取\s*码\s*：\s*AbC1/u);
  assert.equal(fourth.content, original); assert.equal(fourth.replyBodySpaceOffsets, undefined);
  assert.equal(fourth.replyAttemptHistory.at(-1).bodySpaceCount, 3);
  assert.equal(fourth.replyAttemptHistory.at(-1).sha, f.calls[3].wireContentSha256);
  assert.equal(fourth.replyAttemptHistory.slice(0, 3).some(row => Object.hasOwn(row, 'bodySpaceCount')), false);
  f.respond({ status: 'confirmed', messageId: '10001' }); f.advanceTo(fourth.nextAttemptAt);
  const sent = await f.engine.dispatch(job.id); assertThreeBodySpaces(f.calls[4], original);
  assert.equal(sent.status, 'sent'); assert.equal(sent.content, original); assert.equal(sent.replyBodySpaceOffsets.length, 3);
});

test('body-space wires and offsets survive preflight deferral and reopening without being regenerated', async t => {
  for (const outcome of ['confirmed', 'uncertain']) {
    const f = fixture(t); f.engine.updateConfig({ ...f.engine.snapshot().config, replyBodySpaceRetryEnabled: true });
    const { job } = await afterThreeDuplicates(f); f.respond({ status: 'deferred', reason: '尚未提交' });
    const deferred = await f.engine.dispatch(job.id); assertThreeBodySpaces(f.calls[3], job.content);
    const recordedWire = deferred.wireContent, recordedOffsets = [...deferred.replyBodySpaceOffsets];
    const reopened = f.create(); reopened.setRunning(true);
    // A settings change cannot rewrite an already persisted attempt. It applies
    // when a later explicit rejection permits generating a new payload.
    reopened.updateConfig({ ...reopened.snapshot().config, replyBodySpaceRetryEnabled: false });
    const reloaded = reopened.snapshot().jobs[0]; assert.equal(reloaded.wireContent, recordedWire);
    assert.deepEqual(reloaded.replyBodySpaceOffsets, recordedOffsets);
    f.advanceTo(deferred.nextAttemptAt); f.respond(outcome === 'confirmed' ? { status: outcome, messageId: '10001' } : { status: outcome });
    const result = await reopened.dispatch(job.id);
    assert.equal(f.calls[4].wireContent, recordedWire); assert.deepEqual(f.calls[4].replyBodySpaceOffsets, recordedOffsets);
    assert.equal(result.status, outcome === 'confirmed' ? 'sent' : 'uncertain');
    assert.equal(result.wireContent, recordedWire); assert.deepEqual(result.replyBodySpaceOffsets, recordedOffsets);
    const again = f.create(); again.setRunning(true); assert.equal(again.preparePendingReplyRetries(), 0);
    await again.dispatch(job.id); assert.equal(f.calls.length, 5);
  }
});

test('the disabled body-space option leaves every original character unchanged through later retries', async t => {
  const f = fixture(t); assert.equal(f.engine.snapshot().config.replyBodySpaceRetryEnabled, false);
  const { job } = await afterThreeDuplicates(f); const fourth = await f.engine.dispatch(job.id);
  assert.equal(f.calls[3].content, job.content); assert.equal(f.calls[3].wireContent.startsWith(job.content + '\n'), true);
  assert.equal(f.calls[3].replyBodySpaceOffsets, undefined); assert.equal(fourth.replyRetryBodySpaces, false);
  assert.equal(fourth.replyAttemptHistory.some(row => Object.hasOwn(row, 'bodySpaceCount')), false);
});

test('an old blocked reply selects its body-space stage from the current switch and rejection count', async t => {
  for (const enabled of [false, true]) {
    const f = fixture(t); await legacyDuplicate(f);
    const stored = JSON.parse(fs.readFileSync(f.filePath)); stored.jobs[0].replyRetryCount = 3;
    stored.jobs[0].replyRetrySuffixMode = 'time-tag'; fs.writeFileSync(f.filePath, JSON.stringify(stored));
    const reopened = f.create(); reopened.setRunning(true);
    reopened.updateConfig({ ...reopened.snapshot().config, replyBodySpaceRetryEnabled: enabled });
    const recovery = reopened.recoverUnrepliedMessage(f.message()); assert.equal(recovery.status, 'created');
    assert.equal(recovery.job.replyRetryBodySpaces, enabled); assert.equal(recovery.job.replyRetrySuffixMode, 'time-tag');
    f.respond({ status: 'confirmed', messageId: '10001' }); await reopened.dispatch(recovery.job.id);
    if (enabled) assertThreeBodySpaces(f.calls.at(-1), recovery.job.content);
    else assert.equal(f.calls.at(-1).wireContent.startsWith(recovery.job.content + '\n'), true);
  }
});

test('planned spaces without safe insertion points do not claim an actual body-space attempt', async t => {
  const f = fixture(t), original = 'https://example.invalid/resource?pwd=AbC1';
  f.engine.updateConfig({ ...f.engine.snapshot().config, fallback: original, replyBodySpaceRetryEnabled: true });
  const { job } = await afterThreeDuplicates(f); const rejected = await f.engine.dispatch(job.id);
  assert.equal(rejected.replyRetryBodySpaces, true); assert.equal(f.calls[3].replyBodySpaceOffsets, undefined);
  assert.equal(f.calls[3].wireContent.startsWith(original + '\n'), true);
  assert.equal(Object.hasOwn(rejected.replyAttemptHistory.at(-1), 'bodySpaceCount'), false);
});

test('saved offsets, changed reply characters and false body-space history are rejected before dispatch', async t => {
  const f = fixture(t); f.engine.updateConfig({ ...f.engine.snapshot().config, replyBodySpaceRetryEnabled: true });
  const { job } = await afterThreeDuplicates(f); f.respond({ status: 'deferred' }); await f.engine.dispatch(job.id);
  const saved = JSON.parse(fs.readFileSync(f.filePath)), size = job.content.length;
  const mutations = [
    state => { state.jobs[0].replyBodySpaceOffsets = [1, 1, 2]; },
    state => { state.jobs[0].replyBodySpaceOffsets = [3, 2, 1]; },
    state => { state.jobs[0].replyBodySpaceOffsets = [0, 1, 2]; },
    state => { state.jobs[0].replyBodySpaceOffsets = [1, 2, size]; },
    state => { state.jobs[0].replyBodySpaceOffsets = [1, 2, 2.5]; },
    state => { state.jobs[0].replyRetryBodySpaces = 'true'; },
    state => { state.jobs[0].replyAttemptHistory[0].bodySpaceCount = 2; },
    state => { state.jobs[0].wireContent = '换' + state.jobs[0].wireContent.slice(1); state.jobs[0].wireContentSha256 = sha(state.jobs[0].wireContent); },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(saved); mutate(invalid); fs.writeFileSync(f.filePath, JSON.stringify(invalid));
    assert.throws(f.create, /已损坏|无法读取/);
  }
  assert.equal(f.calls.length, 4);
});

test('even an enabled body-space option never changes delivery messages', async t => {
  const f = fixture(t); f.engine.updateConfig({ ...f.engine.snapshot().config, replyBodySpaceRetryEnabled: true,
    autoDeliveryEnabled: true, products: [{ id: 'game', name: '游戏', keywords: ['游戏'], content: '领取链接与提取码', enabled: true }] });
  const delivery = f.engine.ingestOrder({ shopId: 'test-shop', buyerId: 'test-buyer', orderId: 'order', itemId: 'goods', title: '游戏', paid: true });
  await f.engine.dispatch(delivery.id);
  assert.equal(f.calls[0].content, delivery.content); assert.equal(f.calls[0].wireContent, undefined);
  assert.equal(f.calls[0].replyBodySpaceOffsets, undefined); assert.equal(f.calls[0].replyRetryBodySpaces, undefined);
});
