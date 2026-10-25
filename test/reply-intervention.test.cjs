'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Engine, defaults } = require('../src/core/engine.cjs');

function fixture(t, sendMessage = async () => ({ status: 'confirmed', messageId: 'server-receipt' })) {
  const root = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(root, 'pdd-intervention-'));
  t.after(() => {
    if (path.dirname(directory) !== root || !path.basename(directory).startsWith('pdd-intervention-')) throw Error('Unsafe cleanup');
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let now = 1800000000000;
  const filePath = path.join(directory, 'state.json');
  const create = () => new Engine({ filePath, sendMessage, now: () => now });
  const engine = create();
  engine.updateConfig({ ...defaults, running: true, autoReplyEnabled: true, catchUpUnrepliedEnabled: true,
    greetingEnabled: false, fallback: '测试答复', cooldownSeconds: 0 });
  const message = (extra = {}) => ({ shopId: 'test-shop', buyerId: 'test-buyer', messageId: 'buyer-question',
    direction: 'incoming', text: '测试咨询', sentAt: now - 10000, type: '0', subType: '0', pending: true, ...extra });
  const manual = (extra = {}) => message({ messageId: 'merchant-reply', direction: 'outgoing', text: '人工答复', sentAt: now - 9000, ...extra });
  return { engine, filePath, create, message, manual, advance: ms => { now += ms; } };
}

test('ordinary reply persists the source time and requires official verification before its first attempt', t => {
  const f = fixture(t); const source = f.message();
  const job = f.engine.ingestMessage(source);
  const stored = JSON.parse(fs.readFileSync(f.filePath));
  assert.equal(job.sourceSentAt, source.sentAt);
  assert.equal(job.needsReplyVerification, true);
  assert.equal(stored.jobs[0].sourceSentAt, source.sentAt);
  assert.equal(stored.jobs[0].needsReplyVerification, true);
  assert.equal(stored.jobs[0].attemptedAt, undefined);
});

test('message metadata is normalized, persisted without its body, and rejects malformed evidence', t => {
  const f = fixture(t);
  f.engine.ingestMessage(f.manual({ history: 1, type: 56, subType: 0, systemHint: true, noUnreplyHint: 1 }));
  const stored = JSON.parse(fs.readFileSync(f.filePath));
  const entry = stored.ledger.messages[JSON.stringify(['test-shop', 'merchant-reply'])];
  assert.equal(entry.sentAt, f.manual().sentAt); assert.equal(entry.history, true);
  assert.equal(entry.type, '56'); assert.equal(entry.subType, '0');
  assert.equal(entry.systemHint, true); assert.equal(entry.noUnreplyHint, true); assert.equal(entry.text, undefined);
  for (const extra of [{ sentAt: NaN }, { sentAt: '1800000000000' }, { sentAt: -1 }, { history: 'true' },
    { systemHint: 2 }, { noUnreplyHint: {} }, { type: {} }, { subType: -1 }]) {
    assert.throws(() => f.engine.ingestMessage(f.message(extra)), /时间|标记|类型/);
  }
});

test('platform hints and historical merchant cards never count as manual intervention', t => {
  const variants = [{ type: '31' }, { type: 56 }, { history: true }, { systemHint: true }, { noUnreplyHint: true }];
  for (const [index, extra] of variants.entries()) {
    const f = fixture(t); const job = f.engine.ingestMessage(f.message());
    f.engine.ingestMessage(f.manual({ messageId: 'hint-' + index, ...extra }));
    assert.equal(f.engine.snapshot().jobs.find(row => row.id === job.id).status, 'queued');
    assert.equal(f.engine.snapshot().stats.cancelled, 0);
  }
});

test('a late-discovered older outgoing message does not cancel a newer question', t => {
  const f = fixture(t); const source = f.message(); const job = f.engine.ingestMessage(source);
  f.engine.ingestMessage(f.manual({ sentAt: source.sentAt - 2000 }));
  assert.equal(f.engine.snapshot().jobs[0].id, job.id);
  assert.equal(f.engine.snapshot().jobs[0].status, 'queued');
  assert.equal(f.engine.snapshot().logs.at(-1).code, 'older_outgoing_ignored');
});

test('official automatic messages are persisted as automatic and never cancel a waiting reply',t=>{
  const f=fixture(t);const job=f.engine.ingestMessage(f.message());
  f.engine.ingestMessage(f.manual({officialAutoReply:true}));
  const state=f.engine.snapshot();assert.equal(state.jobs.find(row=>row.id===job.id).status,'queued');
  assert.equal(JSON.parse(fs.readFileSync(f.filePath)).ledger.messages[JSON.stringify(['test-shop','merchant-reply'])].officialAutoReply,true);
  assert.throws(()=>f.engine.ingestMessage(f.message({messageId:'invalid-auto',officialAutoReply:'yes'})),/标记/);
});

test('a genuinely later manual reply cancels pending answers and retains source evidence', t => {
  const f = fixture(t); const source = f.message(); const outgoing = f.manual();
  f.engine.ingestMessage(source); f.engine.ingestMessage(outgoing);
  const result = f.engine.snapshot().jobs[0];
  assert.equal(result.status, 'cancelled'); assert.equal(result.reason, 'manual_intervention');
  assert.deepEqual(result.manualInterventionEvidence, { messageId: outgoing.messageId, sentAt: outgoing.sentAt,
    sourceSentAt: source.sentAt, observedAt: 1800000000000, type: '0', subType: '0' });
  assert.equal(result.attemptedAt, undefined); assert.equal(result.wireContent, undefined);
});

test('equal or unavailable source times require verification instead of permanent cancellation', t => {
  for (const extra of [{ outgoing: { sentAt: 1799999990000 } }, { outgoing: { sentAt: undefined } }, { incoming: { sentAt: undefined } }]) {
    const f = fixture(t); f.engine.ingestMessage(f.message(extra.incoming));
    f.engine.ingestMessage(f.manual(extra.outgoing));
    const result = f.engine.snapshot().jobs[0];
    assert.equal(result.status, 'queued'); assert.equal(result.needsReplyVerification, true);
    assert.equal(result.replyVerificationReason, 'outgoing_time_ambiguous');
    assert.equal(result.manualInterventionEvidence, undefined); assert.equal(f.engine.snapshot().stats.cancelled, 0);
  }
});

test('older outgoing and platform-card arrival orders yield the same pending reply', t => {
  for (const kind of ['older', 'hint']) for (const reversed of [false, true]) {
    const f = fixture(t); const incoming = f.message();
    const outgoing = kind === 'older' ? f.manual({ sentAt: incoming.sentAt - 2000 }) : f.manual({ type: '31', noUnreplyHint: true });
    for (const event of reversed ? [outgoing, incoming] : [incoming, outgoing]) f.engine.ingestMessage(event);
    const result = f.engine.snapshot().jobs[0];
    assert.equal(result.status, 'queued'); assert.equal(result.sourceSentAt, incoming.sentAt);
    assert.equal(result.needsReplyVerification, true); assert.equal(f.engine.snapshot().stats.cancelled, 0);
  }
});

test('a later genuine manual reply prevents sending regardless of its arrival order', async t => {
  for (const reversed of [false, true]) {
    let writes = 0;
    const f = fixture(t, async job => {
      assert.equal(job.needsReplyVerification, true);
      // The official latest-conversation check observes the newer manual reply.
      const check = { pending: false };
      if (!check.pending) return { status: 'skipped', reason: '官方会话已有较晚人工回复' };
      writes++; return { status: 'confirmed', messageId: 'unexpected' };
    });
    const incoming = f.message(), outgoing = f.manual();
    for (const event of reversed ? [outgoing, incoming] : [incoming, outgoing]) f.engine.ingestMessage(event);
    await f.engine.dispatch(f.engine.snapshot().jobs[0].id);
    assert.equal(f.engine.snapshot().jobs[0].status, 'cancelled'); assert.equal(writes, 0);
  }
});

test('a confirmed assistant echo cannot cancel a later automatic reply', async t => {
  const f = fixture(t); const sent = f.engine.ingestMessage(f.message()); await f.engine.dispatch(sent.id);
  f.engine.ingestMessage(f.message({ messageId: 'next-question', sentAt: f.message().sentAt + 1000 }));
  f.engine.ingestMessage(f.manual({ messageId: 'server-receipt', sentAt: f.message().sentAt + 2000 }));
  assert.deepEqual(f.engine.snapshot().jobs.map(row => row.status), ['sent', 'queued']);
});

test('reviewed recovery preserves the specified untouched cancellation and links one new task durably', t => {
  const f = fixture(t); const original = f.engine.ingestMessage(f.message()); f.engine.ingestMessage(f.manual());
  assert.equal(f.engine.recoverUnrepliedMessage(f.message()).status, 'needs_review');
  const recovery = f.engine.recoverUnrepliedMessage(f.message(), { reviewedCancellationJobId: original.id });
  assert.equal(recovery.status, 'created'); assert.equal(recovery.job.needsReplyVerification, true);
  assert.equal(recovery.job.reviewedCancellationJobId, original.id);
  const old = f.engine.snapshot().jobs.find(row => row.id === original.id);
  assert.equal(old.status, 'cancelled'); assert.equal(old.reason, 'manual_intervention');
  assert.equal(old.reviewedAt, 1800000000000); assert.equal(old.recoveryJobId, recovery.job.id);
  assert.equal(old.attemptedAt, undefined); assert.equal(old.wireContent, undefined);
  assert.notEqual(f.engine.recoverUnrepliedMessage(f.message(), { reviewedCancellationJobId: original.id }).status, 'created');
  const reopened = f.create(); reopened.setRunning(true);
  assert.notEqual(reopened.recoverUnrepliedMessage(f.message(), { reviewedCancellationJobId: original.id }).status, 'created');
  assert.equal(reopened.snapshot().jobs.length, 2); assert.equal(reopened.snapshot().stats.cancelled, 1);
});

test('reviewed recovery cannot restore sent, uncertain, attempted, or wire-prepared tasks', async t => {
  for (const status of ['sent', 'uncertain', 'deferred']) {
    const response = status === 'sent' ? { status: 'confirmed', messageId: 'server' } : { status: status === 'uncertain' ? 'uncertain' : 'deferred' };
    const f = fixture(t, async () => response); const original = f.engine.ingestMessage(f.message());
    await f.engine.dispatch(original.id);
    if (status === 'deferred') f.engine.ingestMessage(f.manual());
    const before = f.engine.snapshot();
    assert.notEqual(f.engine.recoverUnrepliedMessage(f.message(), { reviewedCancellationJobId: original.id }).status, 'created');
    assert.deepEqual(f.engine.snapshot(), before);
  }
});

test('reviewed recovery is restricted to the exact source and cannot waive another manual cancellation', t => {
  const f = fixture(t); const original = f.engine.ingestMessage(f.message()); f.engine.ingestMessage(f.manual());
  const before = f.engine.snapshot();
  for (const extra of [{ buyerId: 'different-buyer' }, { shopId: 'different-shop' }, { messageId: 'different-source' }]) {
    assert.equal(f.engine.recoverUnrepliedMessage(f.message(extra), { reviewedCancellationJobId: original.id }).status, 'needs_review');
    assert.deepEqual(f.engine.snapshot(), before);
  }
  assert.equal(f.engine.recoverUnrepliedMessage(f.message(), { reviewedCancellationJobId: 'missing' }).status, 'needs_review');
  const other = fixture(t); other.engine.updateConfig({ ...other.engine.snapshot().config, greetingEnabled: true,
    greeting: '欢迎', replyRules: [{ id: 'rule', name: '规则', keywords: ['测试'], content: '规则答复' }] });
  const one = other.engine.ingestMessage(other.message()); other.engine.ingestMessage(other.manual());
  assert.equal(other.engine.snapshot().jobs.length, 2);
  assert.equal(other.engine.recoverUnrepliedMessage(other.message(), { reviewedCancellationJobId: one.id }).status, 'needs_review');
});
