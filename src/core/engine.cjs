'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { parseExpression, planReplies } = require('./reply-strategies.cjs');
const { formatReplyContent, INVISIBLE_PROFILE, isValidReplyPayload } = require('./reply-suffix.cjs');
const { validateImages, messageParts } = require('./message-parts.cjs');
const REPLY_TRANSPORT_PROFILE='official-m-ws-v1';
const DUPLICATE_REPLY_ERROR = '请勿重复发送相同消息';
const REPLY_RETRY_DELAYS = [3000, 10000, 30000, 60000, 120000, 300000];
const DELIVERY_RETRY_DELAYS = [5000, 15000, 30000, 60000, 120000, 300000];

const defaults = Object.freeze({
  running: false,
  autoListenOnLaunch: false,
  catchUpUnrepliedEnabled: true,
  autoReplyEnabled: false,
  autoDeliveryEnabled: false,
  deliveryFallbackEnabled: false,
  deliveryFallback: '',
  autoConfirmShipmentEnabled: true,
  autoRefundEnabled: false,
  greetingEnabled: true,
  manualInterventionEnabled: true,
  replySuffixEnabled: false,
  replyBodySpaceRetryEnabled: true,
  replySuffixMode: 'invisible',
  separateLinksEnabled: false,
  greetingImages: Object.freeze([]),
  fallbackImages: Object.freeze([]),
  deliveryFallbackImages: Object.freeze([]),
  greeting: '您好，欢迎光临！请说明您需要了解的商品或遇到的问题。',
  fallback: '您好，已收到您的咨询。您可以补充商品名称和具体问题。',
  suffix: '',
  cooldownSeconds: 60,
  firstReplyIntervalMinutes: 30,
  firstReplyDelaySeconds: 0,
  replyDelaySeconds: 0,
  maxPerMinute: 12,
  products: Object.freeze([]),
  replyRules: Object.freeze([]),
});

const MAX_LOGS = 500;
const MAX_TERMINAL_JOBS = 1000;
const ACTIVE = new Set(['queued', 'sending', 'uncertain']);
const STATUSES = new Set(['queued', 'sending', 'sent', 'uncertain', 'blocked', 'cancelled', 'simulated']);
const clone = (value) => structuredClone(value);
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const normalized = (value) => value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, '');

function textField(value, field, { fallback, max = 20000, nonempty = false } = {}) {
  if (value === undefined && fallback !== undefined) value = fallback;
  if (typeof value !== 'string') throw new TypeError(`${field} 必须是文本`);
  value = value.trim();
  if (value.length > max) throw new RangeError(`${field} 最多 ${max} 个字符`);
  if (nonempty && !value) throw new TypeError(`${field} 不能为空`);
  return value;
}

function booleanField(value, field, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new TypeError(`${field} 必须是布尔值`);
  return value;
}

function integerField(value, field, fallback, min, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${field} 必须是 ${min} 到 ${max} 的整数`);
  return value;
}

function enumField(value, field, values, fallback) {
  if (value === undefined) return fallback;
  if (!values.includes(value)) throw new TypeError(`${field} 选项不正确`);
  return value;
}

function messageMetadata(input) {
  const flag = (value, name) => {
    if (value === undefined) return false;
    if (value === 0 || value === 1) return value === 1;
    return booleanField(value, name, false);
  };
  const kind = (value, name) => {
    if (value === undefined || value === null) return '';
    if (Number.isSafeInteger(value) && value >= 0) return String(value);
    return textField(value, name, { max: 128 });
  };
  const sentAt = input.sentAt === undefined || input.sentAt === null ? null : input.sentAt;
  if (sentAt !== null && (!Number.isFinite(sentAt) || sentAt <= 0)) throw new TypeError('消息来源时间无效');
  return { sentAt, history: flag(input.history, '历史消息标记'), type: kind(input.type, '消息类型'),
    subType: kind(input.subType, '消息子类型'), systemHint: flag(input.systemHint, '系统提示标记'),
    noUnreplyHint: flag(input.noUnreplyHint, '免待回复提示标记'), officialAutoReply: flag(input.officialAutoReply, '官方自动回复标记') };
}

function messageLedgerEntry(event, at) {
  return { at, buyerId: event.buyerId, direction: event.direction, sentAt: event.sentAt,
    history: event.history, type: event.type, subType: event.subType,
    systemHint: event.systemHint, noUnreplyHint: event.noUnreplyHint, officialAutoReply: event.officialAutoReply };
}

function rejectedReplyAttempt(job, error) {
  const recorded = job.replyAttemptHistory?.findLast(row => row.at === job.attemptedAt);
  const attempt = { at: job.attemptedAt, sha: job.wireContentSha256 || (typeof job.wireContent === 'string' ? createHash('sha256').update(job.wireContent).digest('hex') : recorded?.sha || null),
    suffixMode: job.replySuffixApplied || recorded?.suffixMode || 'unknown', error: String(error).slice(0, 2000) };
  if (job.replyBodySpaceOffsets?.length === 3 || job.wireContent === undefined && recorded?.bodySpaceCount === 3) attempt.bodySpaceCount = 3;
  return attempt;
}

function isLegacyDuplicateReply(job) {
  return job.status === 'blocked' && job.reason === 'operation_rejected' && typeof job.detail === 'string' && job.detail.includes(DUPLICATE_REPLY_ERROR) && Number.isFinite(job.attemptedAt);
}

function clearReplyWire(job) {
  for (const key of ['wireContent', 'wireContentSha256', 'wireContentLength', 'replySuffixApplied', 'replySuffixNote', 'replySuffixProfile', 'replyTransportProfile', 'replyBodySpaceOffsets', 'outbound', 'sentMessageId']) delete job[key];
}

function restoreLegacyReplyBody(job, at) {
  if (job.type !== 'reply' || !['queued', 'blocked'].includes(job.status) || job.status === 'blocked' && !isLegacyDuplicateReply(job) || typeof job.retryOriginalContent !== 'string' || !job.replyRetryFallbackApplied && job.content === job.retryOriginalContent) return false;
  if (job.status === 'blocked') {
    const rejected = rejectedReplyAttempt(job, job.detail), attempts = [...(job.replyAttemptHistory || [])];
    if (attempts.at(-1)?.at !== rejected.at || attempts.at(-1)?.sha !== rejected.sha) attempts.push(rejected);
    job.replyAttemptHistory = attempts.slice(-30);
  }
  job.legacyReplacedContent = job.content;
  job.content = job.retryOriginalContent;
  job.replyRetryCount = Math.max(2, job.replyRetryCount || 0);
  job.replyRetryTag = true;
  job.replyRetrySuffixMode = 'time-tag';
  job.needsReplyVerification = true;
  job.replyBodyRestoredAt = at;
  job.updatedAt = at;
  delete job.replyRetryFallbackApplied;
  clearReplyWire(job);
  return true;
}

function keywordsField(value, field, keyOf = normalized) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new TypeError(`${field} 必须是至多 100 项的关键词列表`);
  const seen = new Set();
  return value.map((item) => textField(item, field, { max: 256 }))
    .filter((item) => {
      const key = keyOf(item);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function rowsField(rows, kind) {
  if (rows === undefined) return [];
  if (!Array.isArray(rows) || rows.length > 5000) throw new TypeError(`${kind} 必须是至多 5000 项的列表`);
  const ids = new Set();
  return rows.map((row, index) => {
    const label = `${kind}第 ${index + 1} 项`;
    if (!plain(row)) throw new TypeError(`${label} 格式不正确`);
    const id = textField(row.id, `${label} ID`, { max: 128, nonempty: true });
    if (ids.has(id)) throw new TypeError(`${kind} ID 不能重复`);
    ids.add(id);
    const enabled = booleanField(row.enabled, `${label} enabled`, true);
    const matchType=kind==='商品' ? null : enumField(row.matchType, '答复策略', ['contains', 'exact', 'wildcard', 'expression', 'system'], 'contains');
    const keyOf=kind==='商品' ? normalized : ['exact','wildcard','system'].includes(matchType) ? value=>value : value=>value.toLowerCase();
    const keywords = keywordsField(row.keywords, `${label}关键词`,keyOf);
    const content = textField(row.content, `${label}正文`, { fallback: '', nonempty: enabled });
    if (enabled && !keywords.length) throw new TypeError(`${label}至少需要一个关键词`);
    const result = {
      id,
      name: textField(row.name, `${label}名称`, { max: 200, nonempty: true }),
      keywords,
      content,
      enabled,
      images: validateImages(row.images),
    };
    if (kind === '商品') {
      result.excludeKeywords = keywordsField(row.excludeKeywords, `${label}排除词`);
      result.matchTarget = enumField(row.matchTarget, '匹配范围', ['either', 'title', 'sku'], 'either');
    } else {
      result.matchType = matchType;
      result.priority = integerField(row.priority, '规则优先级', 100, 0, 999);
      result.delaySeconds = row.delaySeconds === null || row.delaySeconds === undefined ? null : integerField(row.delaySeconds, '规则延迟', 0, 0, 3600);
      if (row.weekSlots !== undefined && (!Array.isArray(row.weekSlots) || row.weekSlots.length > 336 || row.weekSlots.some(slot => !Number.isInteger(slot) || slot < 0 || slot > 335))) throw new TypeError('生效时段格式不正确');
      result.weekSlots = [...new Set(row.weekSlots || [])];
      if (result.matchType === 'expression') for (const word of keywords) parseExpression(word);
    }
    return result;
  });
}

function validateConfig(input) {
  if (!plain(input)) throw new TypeError('设置必须是对象');
  const config = {};
  for (const key of ['running', 'autoListenOnLaunch', 'catchUpUnrepliedEnabled', 'autoReplyEnabled', 'autoDeliveryEnabled', 'deliveryFallbackEnabled', 'autoConfirmShipmentEnabled', 'autoRefundEnabled', 'greetingEnabled', 'manualInterventionEnabled', 'replySuffixEnabled', 'replyBodySpaceRetryEnabled', 'separateLinksEnabled']) {
    config[key] = booleanField(input[key], key, defaults[key]);
  }
  // Retain the legacy fields for file compatibility. Recovery is an invariant
  // of enabled automatic replies, rather than another user-managed feature.
  config.catchUpUnrepliedEnabled = config.replyBodySpaceRetryEnabled = true;
  config.replySuffixMode=enumField(input.replySuffixMode,'答复末尾内容',['invisible','time'],defaults.replySuffixMode);
  for (const key of ['greeting', 'fallback', 'suffix', 'deliveryFallback']) {
    config[key] = textField(input[key], key, { fallback: defaults[key] });
  }
  for (const [key, min, max] of [['cooldownSeconds', 0, 86400], ['maxPerMinute', 1, 120], ['firstReplyIntervalMinutes', 1, 1440], ['firstReplyDelaySeconds', 0, 3600], ['replyDelaySeconds', 0, 3600]]) {
    const value = input[key] === undefined ? defaults[key] : input[key];
    if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${key} 必须是 ${min} 到 ${max} 的整数`);
    config[key] = value;
  }
  config.products = rowsField(input.products, '商品');
  config.replyRules = rowsField(input.replyRules, '回复规则');
  for (const key of ['greetingImages','fallbackImages','deliveryFallbackImages']) config[key] = validateImages(input[key]);
  if(config.deliveryFallbackEnabled && !config.deliveryFallback)throw new TypeError('请先填写未匹配时的默认发货内容');
  return config;
}

// A longer matching phrase shadows a shorter phrase contained inside it. Two
// unrelated phrases still select two products and must be reviewed by a human.
function matchRows(input, rows) {
  const fields = typeof input === 'string' ? { title: input, sku: '' } : input;
  if (!plain(fields)) throw new TypeError('匹配内容格式不正确');
  const title = normalized(textField(fields.title, '商品名称', { fallback: '', max: 100000 }));
  const sku = normalized(textField(fields.sku ?? fields.spec ?? fields.skuName, 'SKU', { fallback: '', max: 20000 }));
  const hits = [];
  for (const row of rows) {
    if (row.enabled === false) continue;
    const targets = row.matchTarget === 'title' ? [title] : row.matchTarget === 'sku' ? [sku] : [title, sku];
    if ((row.excludeKeywords || []).some((word) => targets.some(haystack => haystack.includes(normalized(word))))) continue;
    for (const word of row.keywords || []) {
      const key = normalized(word);
      if (key && targets.some(haystack => haystack.includes(key))) hits.push({ row, key });
    }
  }
  const strongest = hits.filter((hit) => !hits.some((other) => other.key.length > hit.key.length && other.key.includes(hit.key)));
  const unique = new Map(strongest.map(({ row }) => [row.id, row]));
  const matches = [...unique.values()];
  return {
    status: matches.length === 1 ? 'matched' : matches.length > 1 ? 'ambiguous' : 'unmatched',
    product: matches.length === 1 ? clone(matches[0]) : null,
    matches: clone(matches),
  };
}

function matchProduct(title, products = []) {
  return matchRows(title, rowsField(products, '商品'));
}
function planDelivery(order, config) {
  const match=matchRows(order,config.products);
  const fallback=match.status==='unmatched' && config.deliveryFallbackEnabled && !!config.deliveryFallback;
  const deliverable=match.status==='matched'||fallback;
  return {...match,deliverable:!!deliverable,fallback:!!fallback,
    content:deliverable?[fallback?config.deliveryFallback:match.product.content,config.suffix].filter(Boolean).join('\n\n'):'',
    images: fallback ? config.deliveryFallbackImages || [] : match.product?.images || [],
    matchName:fallback?'未匹配默认发货':match.product?.name||'',productId:match.product?.id};
}

const EMPTY_COUNTS = Object.freeze({ total: 0, sent: 0, deliverySent: 0, replySent: 0, shipmentSent: 0, refundSent: 0, blocked: 0, cancelled: 0 });

function newState() {
  return {
    version: 2,
    config: validateConfig(defaults),
    jobs: [],
    logs: [],
    ledger: { orders: {}, messages: {}, greeted: {}, lastReply: {}, lastAsk: {}, replyHistory: {}, replyRecovery: {}, shipments: {}, refunds: {}, attempts: [] },
    counts: { ...EMPTY_COUNTS },
  };
}

function validateState(value) {
  if (!plain(value) || ![1, 2].includes(value.version) || !Array.isArray(value.jobs) || !Array.isArray(value.logs) || !plain(value.ledger) || !plain(value.counts)) {
    throw new TypeError('工作台数据结构不正确');
  }
  const legacy = value.version === 1;
  // These two optional v2 fields were added in 0.2.2. Existing v2 files keep
  // their rules and ledger; the new feature stays disabled until selected.
  const required = legacy ? ['running', 'autoReplyEnabled', 'autoDeliveryEnabled', 'greetingEnabled', 'greeting', 'fallback', 'suffix', 'cooldownSeconds', 'maxPerMinute', 'products', 'replyRules'] : Object.keys(defaults).filter(key=>!['replySuffixEnabled','replySuffixMode','autoListenOnLaunch','catchUpUnrepliedEnabled','replyBodySpaceRetryEnabled','deliveryFallbackEnabled','deliveryFallback','separateLinksEnabled','greetingImages','fallbackImages','deliveryFallbackImages'].includes(key));
  if (!plain(value.config) || required.some((key) => !Object.hasOwn(value.config, key))) throw new TypeError('已保存的设置不完整');
  if (legacy) {
    value.version = 2;
    for (const key of ['lastAsk', 'replyHistory', 'shipments', 'refunds']) value.ledger[key] = {};
    value.counts.shipmentSent = value.counts.refundSent = 0;
    // Upgrading must never silently enable a new remote operation.
    value.config.autoConfirmShipmentEnabled = false;
    value.config.autoRefundEnabled = false;
  }
  value.config = validateConfig(value.config);
  if (value.ledger.replyRecovery === undefined) value.ledger.replyRecovery = {};
  if (!plain(value.ledger.replyRecovery) || Object.values(value.ledger.replyRecovery).some(entry => !plain(entry) || !Number.isFinite(entry.at) || typeof entry.jobId !== 'string')) throw new TypeError('待回复补答账本已损坏');
  for (const key of ['orders', 'messages', 'greeted', 'lastReply', 'lastAsk', 'replyHistory', 'shipments', 'refunds']) {
    if (!plain(value.ledger[key])) throw new TypeError(`去重账本 ${key} 已损坏`);
  }
  if (!Array.isArray(value.ledger.attempts) || value.ledger.attempts.some((attempt) => !plain(attempt) || !Number.isFinite(attempt.at) || typeof attempt.jobId !== 'string')) {
    throw new TypeError('发送频率账本已损坏');
  }
  for (const key of Object.keys(EMPTY_COUNTS)) {
    if (!Number.isSafeInteger(value.counts[key]) || value.counts[key] < 0) throw new TypeError('统计数据已损坏');
  }
  const ids = new Set();
  for (const job of value.jobs) {
    if (!plain(job) || typeof job.id !== 'string' || !job.id || ids.has(job.id) || !STATUSES.has(job.status) || !['reply', 'delivery', 'shipment', 'refund'].includes(job.type) || typeof job.simulation !== 'boolean' || typeof job.content !== 'string' || !Number.isFinite(job.createdAt) || !Number.isFinite(job.updatedAt) || typeof job.shopId !== 'string' || !job.shopId || typeof job.buyerId !== 'string' || (!job.buyerId && job.type !== 'refund')) {
      throw new TypeError('任务数据已损坏');
    }
    if (job.simulation !== (job.status === 'simulated')) throw new TypeError('模拟任务状态已损坏');
    if (job.parentJobId !== undefined && (!['reply','delivery'].includes(job.type) || typeof job.parentJobId !== 'string' || !job.parentJobId || !['link','image'].includes(job.partKind))) throw new TypeError('附加消息关联已损坏');
    if (job.partKind === 'image' && (validateImages([job.image])[0].url !== job.content || job.image.shopId !== job.shopId)) throw new TypeError('附加图片与店铺不一致');
    if (job.messageParts !== undefined) {
      if (!Array.isArray(job.messageParts) || job.messageParts.length > 15 || job.parentJobId) throw new TypeError('附加消息计划已损坏');
      for (const part of job.messageParts) if (!part || !['link','image'].includes(part.kind) || typeof part.content !== 'string' || part.kind === 'image' && validateImages([part.image])[0].url !== part.content) throw new TypeError('附加消息计划已损坏');
    }
    if (job.partJobIds !== undefined && (!Array.isArray(job.partJobIds) || job.partJobIds.length > 15 || job.partJobIds.some(id => typeof id !== 'string' || !id))) throw new TypeError('附加消息编号已损坏');
    if (job.attachmentRetryCount !== undefined && (!job.parentJobId || !Number.isSafeInteger(job.attachmentRetryCount) || job.attachmentRetryCount < 0)) throw new TypeError('附加消息重试次数已损坏');
    if(job.deliveryFallback!==undefined && (job.type!=='delivery'||typeof job.deliveryFallback!=='boolean'))throw new TypeError('默认发货标记已损坏');
    if(job.deliveryRetryCount!==undefined && (!['delivery','shipment'].includes(job.type)||!Number.isSafeInteger(job.deliveryRetryCount)||job.deliveryRetryCount<0))throw new TypeError('发货重试次数已损坏');
    if(job.deliveryDuplicateCount!==undefined&&(job.type!=='delivery'||!Number.isSafeInteger(job.deliveryDuplicateCount)||job.deliveryDuplicateCount<0))throw new TypeError('发货判重次数已损坏');
    if(job.deliveryWireContent!==undefined&&(job.type!=='delivery'||!isValidReplyPayload(job.content,job.deliveryWireContent)))throw new TypeError('发货发送正文已损坏');
    if(job.deliveryWireContentSha256!==undefined&&(typeof job.deliveryWireContent!=='string'||job.deliveryWireContentSha256!==createHash('sha256').update(job.deliveryWireContent).digest('hex')))throw new TypeError('发货发送正文校验已损坏');
    if (job.replyBodySpaceOffsets !== undefined && (job.type !== 'reply' || typeof job.wireContent !== 'string' || !Array.isArray(job.replyBodySpaceOffsets) || job.replyBodySpaceOffsets.length !== 3 || job.replyBodySpaceOffsets.some((offset, index, all) => !Number.isSafeInteger(offset) || offset <= 0 || offset >= job.content.length || index > 0 && offset <= all[index - 1]))) throw new TypeError('答复正文空格位置已损坏');
    if(job.wireContent!==undefined && (job.type!=='reply' || !isValidReplyPayload(job.content, job.wireContent, job.replyBodySpaceOffsets)))throw new TypeError('答复发送正文已损坏');
    if(job.wireContentSha256!==undefined && (typeof job.wireContent!=='string' || job.wireContentSha256!==createHash('sha256').update(job.wireContent).digest('hex')))throw new TypeError('答复发送正文校验已损坏');
    if (job.sourceSentAt !== undefined && job.sourceSentAt !== null && (!Number.isFinite(job.sourceSentAt) || job.sourceSentAt <= 0)) throw new TypeError('答复来源时间已损坏');
    if (job.sourceText !== undefined && (job.type !== 'reply' || typeof job.sourceText !== 'string' || job.sourceText.length > 100000)) throw new TypeError('答复来源正文已损坏');
    if (job.settingsRefreshPending !== undefined && typeof job.settingsRefreshPending !== 'boolean') throw new TypeError('任务设置刷新标记已损坏');
    if (job.needsReplyVerification !== undefined && typeof job.needsReplyVerification !== 'boolean') throw new TypeError('答复核验标记已损坏');
    if (job.reviewedAt !== undefined && (!Number.isFinite(job.reviewedAt) || job.reviewedAt < 0)) throw new TypeError('答复复核时间已损坏');
    for (const field of ['recoveryJobId', 'reviewedCancellationJobId', 'retryRejectedJobId', 'retryJobId', 'officialAutoReplyRecoveryJobId', 'platformHintRecoveryJobId']) if (job[field] !== undefined && (typeof job[field] !== 'string' || !job[field] || job[field].length > 128)) throw new TypeError('答复复核任务关联已损坏');
    if (job.replyCooldownUntil !== undefined && (job.type !== 'reply' || !Number.isFinite(job.replyCooldownUntil) || job.replyCooldownUntil < 0)) throw new TypeError('答复冷却时间已损坏');
    if (job.replyConfirmedAt !== undefined && (job.type !== 'reply' || job.parentJobId || !Number.isFinite(job.replyConfirmedAt) || job.replyConfirmedAt < 0)) throw new TypeError('答复确认时间已损坏');
    if (job.replyRetryCount !== undefined && (job.type !== 'reply' || !Number.isSafeInteger(job.replyRetryCount) || job.replyRetryCount < 0)) throw new TypeError('答复重试次数已损坏');
    if (job.replyRetrySuffixMode !== undefined && (job.type !== 'reply' || !['time', 'time-tag'].includes(job.replyRetrySuffixMode))) throw new TypeError('答复重试尾缀已损坏');
    if (job.replyRetryTag !== undefined && (job.type !== 'reply' || typeof job.replyRetryTag !== 'boolean')) throw new TypeError('答复重试标记已损坏');
    if (job.replyRetryBodySpaces !== undefined && (job.type !== 'reply' || typeof job.replyRetryBodySpaces !== 'boolean')) throw new TypeError('答复正文空格重试标记已损坏');
    if (job.retryOriginalContent !== undefined && (job.type !== 'reply' || typeof job.retryOriginalContent !== 'string' || job.retryOriginalContent.length > 20000)) throw new TypeError('补答原始正文已损坏');
    if (job.replyRetryFallbackApplied !== undefined && (typeof job.replyRetryFallbackApplied !== 'boolean' || job.replyRetryFallbackApplied && typeof job.retryOriginalContent !== 'string')) throw new TypeError('补答兜底状态已损坏');
    if (job.replyAttemptHistory !== undefined && (!Array.isArray(job.replyAttemptHistory) || job.replyAttemptHistory.length > 30 || job.replyAttemptHistory.some(row => !plain(row) || !Number.isFinite(row.at) || row.at < 0 || row.sha !== null && !/^[0-9a-f]{64}$/.test(row.sha) || !['none', 'invisible', 'time', 'time-tag', 'unknown'].includes(row.suffixMode) || typeof row.error !== 'string' || row.error.length > 2000 || row.bodySpaceCount !== undefined && row.bodySpaceCount !== 3))) throw new TypeError('答复重试历史已损坏');
    ids.add(job.id);
  }
  for (const [key, entry] of Object.entries(value.ledger.orders)) {
    if (!plain(entry) || typeof entry.jobId !== 'string' || typeof entry.claimed !== 'boolean' || !plain(entry.event)) throw new TypeError('订单去重账本已损坏');
    const event = entry.event;
    if (typeof event.shopId !== 'string' || !event.shopId || typeof event.orderId !== 'string' || !event.orderId || typeof event.itemId !== 'string' || typeof event.buyerId !== 'string' || !event.buyerId || ['paid', 'refunded', 'cancelled'].some((field) => typeof event[field] !== 'boolean') || key !== JSON.stringify([event.shopId, event.orderId, event.itemId])) throw new TypeError('订单去重账本事件已损坏');
  }
  if (Object.values(value.ledger.messages).some((entry) => !plain(entry) || !Number.isFinite(entry.at))) throw new TypeError('消息去重账本已损坏');
  if (Object.values(value.ledger.greeted).some((entry) => entry !== true)) throw new TypeError('首次咨询账本已损坏');
  if (Object.values(value.ledger.lastReply).some((entry) => !Number.isFinite(entry) || entry < 0)) throw new TypeError('回复冷却账本已损坏');
  if (Object.values(value.ledger.lastAsk).some(entry => !Number.isFinite(entry) || entry < 0)) throw new TypeError('咨询时间账本已损坏');
  if (Object.values(value.ledger.replyHistory).some(entry => !Array.isArray(entry) || entry.some(row => !plain(row) || typeof row.content !== 'string' || !Number.isFinite(row.at)))) throw new TypeError('答复历史账本已损坏');
  for (const [key, entry] of Object.entries(value.ledger.shipments)) if (!plain(entry) || typeof entry.jobId !== 'string' || typeof entry.confirmed !== 'boolean' || !Array.isArray(JSON.parse(key))) throw new TypeError('发货确认账本已损坏');
  for (const [key, entry] of Object.entries(value.ledger.refunds)) if (!plain(entry) || typeof entry.jobId !== 'string' || !plain(entry.event) || key !== JSON.stringify([entry.event.shopId, entry.event.refundId]) || typeof entry.event.orderId !== 'string' || !entry.event.orderId || !['pending','processing','approved','refunded','closed'].includes(entry.event.status)) throw new TypeError('退款账本已损坏');
  return value;
}

function writeSynced(file, contents) {
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, contents, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function atomicSave(filePath, state) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const backupTemporary = `${temporary}.bak`;
  try {
    writeSynced(temporary, `${JSON.stringify(state, null, 2)}\n`);
    if (fs.existsSync(filePath)) {
      writeSynced(backupTemporary, fs.readFileSync(filePath));
      fs.renameSync(backupTemporary, `${filePath}.bak`);
    }
    fs.renameSync(temporary, filePath);
  } finally {
    for (const leftover of [temporary, backupTemporary]) {
      try { fs.unlinkSync(leftover); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

const reasonText = {
  paused: '工作台已暂停', delivery_disabled: '自动发货未开启', reply_disabled: '自动回复未开启',
  unpaid: '订单尚未付款', refunded: '订单已退款', cancelled: '订单已取消',
  no_match: '商品标题未匹配发货内容', ambiguous_match: '标题命中多个独立商品，请人工核对',
  ambiguous_reply: '消息命中多个独立回复规则', no_content: '没有可发送的回复正文',
  cooldown: '该买家仍在回复冷却时间内', duplicate: '已处理过相同事件',
  rate_limit: '达到每分钟发送上限，任务等待人工或后续调度',
  send_error: '发送调用异常，结果不明，请人工核实',
  invalid_confirmation: '发送未返回明确确认，请人工核实',
  startup_recovery: '上次退出时正在发送，请人工核实结果',
  manual_confirmed: '已人工确认发送成功', manual_cancelled: '已人工结案，不再发送',
  manual_intervention: '人工客服已回复，取消尚未执行的自动答复',
  refund_pending: '已收到退款申请，停止此订单后续发货',
  refund_disabled: '自动退款未开启', refund_closed: '退款申请已结束',
  shipment_disabled: '自动确认发货未开启', reply_delay: '等待设定的答复延迟',
  adapter_unavailable: '该平台操作尚未完成接入校验', operation_rejected: '平台明确拒绝此次操作',
  connection_wait: '尚未提交平台操作，等待官方连接恢复',
  delivery_retry_wait: '发货未完成，已安排自动重试',
  attachment_retry_wait: '链接或图片未完成，已安排自动重试',
  order_changed: '订单状态或发货内容已变化，停止旧任务',
  reply_retry_wait: '平台判定重复消息，正在等待自动补答',
  dependency_changed: '关联订单状态已变化，停止后续操作',
};

class Engine {
  constructor({ filePath, sendMessage, markShipped, agreeRefund, now = Date.now, random = Math.random } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim()) throw new TypeError('需要本地数据文件路径');
    if (typeof sendMessage !== 'function') throw new TypeError('需要 sendMessage 发送适配器');
    if (typeof now !== 'function') throw new TypeError('now 必须是函数');
    this.filePath = path.resolve(filePath);
    this.sendMessage = sendMessage;
    this.markShipped = markShipped;
    this.agreeRefund = agreeRefund;
    this.random = random;
    this.now = now;
    this._dispatchTail = Promise.resolve();
    let exists = false, migrated = false;
    try {
      exists = fs.existsSync(this.filePath);
      const raw = exists ? JSON.parse(fs.readFileSync(this.filePath, 'utf8')) : null;
      migrated = raw?.version === 1 || !!raw?.config && (raw.config.catchUpUnrepliedEnabled !== true || raw.config.replyBodySpaceRetryEnabled !== true);
      this._state = exists ? validateState(raw) : newState();
    } catch (error) {
      throw new Error(`无法读取工作台数据，原文件已保留：${this.filePath}。${error.message}`, { cause: error });
    }
    let changed = !exists || migrated || this._state.config.running;
    this._state.config.running = false;
    for (const job of this._state.jobs) {
      if (job.type === 'reply' && job.status === 'queued') { job.needsReplyVerification = true; changed = true; }
      if (job.status === 'sending') {
        job.status = 'uncertain';
        job.reason = 'startup_recovery';
        job.updatedAt = this._time();
        this._log('warning', reasonText.startup_recovery, { jobId: job.id, code: 'startup_recovery' });
        changed = true;
      }
      if (restoreLegacyReplyBody(job, this._time())) {
        this._log('info', '已恢复待补答任务原始正文，后续仅在末尾添加消息标记', { jobId: job.id, code: 'reply_body_restored' });
        changed = true;
      }
    }
    if (changed) atomicSave(this.filePath, this._state);
  }

  _time() {
    const time = this.now();
    if (!Number.isFinite(time) || time < 0) throw new TypeError('时钟返回值无效');
    return Math.floor(time);
  }

  _replyCooldownUntil(event, content) {
    const body = normalized(content);
    const buyerKey = JSON.stringify([event.shopId, event.buyerId]);
    // Queue history still selects alternative rules, but only successful
    // receipts start cooldowns. Legacy sent jobs retain their completion time.
    const times = (this._state.ledger.replyHistory[buyerKey] || [])
      .filter(row => Number.isFinite(row.confirmedAt) && normalized(row.content) === body)
      .map(row => row.confirmedAt);
    for (const job of this._state.jobs) {
      if (job.type === 'reply' && !job.simulation && !job.parentJobId && job.status === 'sent'
        && job.shopId === event.shopId && job.buyerId === event.buyerId && normalized(job.content) === body) {
        times.push(job.replyConfirmedAt ?? job.updatedAt);
      }
    }
    return times.length ? Math.max(...times) + this._state.config.cooldownSeconds * 1000 : 0;
  }

  _log(level, message, extra = {}) {
    this._state.logs.push({ id: randomUUID(), at: this._time(), level, message, ...extra });
    this._state.logs = this._state.logs.slice(-MAX_LOGS);
  }

  _mutate(action) {
    const previous = clone(this._state);
    try {
      const result = action();
      this._prune();
      atomicSave(this.filePath, this._state);
      return result;
    } catch (error) {
      this._state = previous;
      throw error;
    }
  }

  _prune() {
    const terminalIds = new Set(this._state.jobs.filter((job) => !ACTIVE.has(job.status)).slice(-MAX_TERMINAL_JOBS).map((job) => job.id));
    const needed=this._state.jobs.filter(job=>ACTIVE.has(job.status)).flatMap(job=>[job.parentJobId,...(job.dependencies || [])]).filter(Boolean),visited=new Set();
    while (needed.length) {const id=needed.pop();if(visited.has(id))continue;visited.add(id);terminalIds.add(id);const job=this._state.jobs.find(row=>row.id===id);if(job)needed.push(...(job.dependencies || []),...(job.partJobIds || []),...(job.parentJobId?[job.parentJobId]:[]));}
    this._state.jobs = this._state.jobs.filter((job) => ACTIVE.has(job.status) || terminalIds.has(job.id));
    this._state.logs = this._state.logs.slice(-MAX_LOGS);
    const cutoff = this._time() - 60000;
    this._state.ledger.attempts = this._state.ledger.attempts.filter((attempt) => attempt.at > cutoff);
  }

  snapshot() {
    const live = this._state.jobs.filter((job) => !job.simulation);
    return clone({
      config: this._state.config,
      jobs: this._state.jobs,
      logs: this._state.logs,
      stats: {
        ...this._state.counts,
        queued: live.filter((job) => job.status === 'queued').length,
        sending: live.filter((job) => job.status === 'sending').length,
        uncertain: live.filter((job) => job.status === 'uncertain').length,
        simulated: this._state.jobs.filter((job) => job.simulation).length,
      },
    });
  }

  updateConfig(fullConfig) {
    const config = validateConfig(fullConfig);
    this._mutate(() => {
      const previous = this._state.config;
      const replyKeys = ['replyRules','greeting','fallback','greetingEnabled','replySuffixEnabled','replySuffixMode','separateLinksEnabled','greetingImages','fallbackImages','cooldownSeconds','firstReplyDelaySeconds','replyDelaySeconds'];
      const replyChanged = replyKeys.some(key => JSON.stringify(previous[key]) !== JSON.stringify(config[key]));
      this._state.config = config;
      for(const job of this._state.jobs)if(!job.simulation&&!job.parentJobId){
        if(job.status==='sending')job.settingsRefreshPending=true;
        else if(replyChanged&&job.type==='reply'&&job.status==='queued')this._refreshQueuedReply(job,previous,config);
      }
      for (const job of this._state.jobs) if (!job.simulation && job.status==='queued' && job.type==='delivery' && !job.parentJobId) {
        const entry=this._state.ledger.orders[JSON.stringify([job.shopId,job.orderId,job.itemId])];
        const match=entry && planDelivery(entry.event,config);
        if (!match?.deliverable || match.productId!==job.productId || match.fallback!==!!job.deliveryFallback || match.content!==job.content || JSON.stringify(job.messageParts || []) !== JSON.stringify(messageParts(match.content,match.images,config.separateLinksEnabled))) {
          job.status='cancelled';job.reason='rules_changed';job.updatedAt=this._time();this._state.counts.cancelled++;
          if (entry && !entry.delivered) entry.claimed=false;
        }
      }
      this._log('info', '已保存本地规则设置', { code: 'config_updated' });
    });
    return clone(config);
  }

  _refreshQueuedReply(job, previous, config) {
    const contentKeys=['replyRules','greeting','fallback','greetingEnabled','greetingImages','fallbackImages','separateLinksEnabled'];
    const contentChanged=contentKeys.some(key=>JSON.stringify(previous?.[key])!==JSON.stringify(config[key]));
    const formattingChanged=!previous||previous.replySuffixEnabled!==config.replySuffixEnabled||previous.replySuffixMode!==config.replySuffixMode;
    let plan;
    if(contentChanged){
      if(job.strategy==='greeting')plan=config.greetingEnabled&&config.greeting?{content:config.greeting,matchName:'首次欢迎语',strategy:'greeting'}:null;
      else if(typeof job.sourceText==='string')plan=planReplies({...job,text:job.sourceText},{...config,greetingEnabled:false},{now:this._time(),previousAskAt:this._time(),random:()=>0})[0];
      else if(job.strategy==='fallback'&&previous&&JSON.stringify(previous.replyRules)===JSON.stringify(config.replyRules))plan=config.fallback?{content:config.fallback,matchName:'默认回复',strategy:'fallback'}:null;
      if(!plan){job.status='cancelled';job.reason='rules_changed';job.updatedAt=this._time();this._state.counts.cancelled++;return;}
      job.content=plan.content;job.matchName=plan.matchName;job.strategy=plan.strategy;
      if(plan.replyRuleId)job.replyRuleId=plan.replyRuleId;else delete job.replyRuleId;
      const images=job.replyRuleId?config.replyRules.find(row=>row.id===job.replyRuleId)?.images:job.strategy==='greeting'?config.greetingImages:config.fallbackImages;
      job.messageParts=messageParts(job.content,images||[],config.separateLinksEnabled);
      if(typeof job.retryOriginalContent==='string')job.retryOriginalContent=job.content;
    }
    if(contentChanged||formattingChanged)clearReplyWire(job);
    const delay=job.strategy==='greeting'?config.firstReplyDelaySeconds:(config.replyRules.find(row=>row.id===job.replyRuleId)?.delaySeconds??config.replyDelaySeconds);
    job.replyCooldownUntil=this._replyCooldownUntil(job,job.content);
    job.notBefore=Math.max(job.createdAt+delay*1000,job.replyCooldownUntil);
    job.needsReplyVerification=true;job.updatedAt=this._time();
    this._log('info','待发答复已应用最新设置，发送前继续核验会话',{jobId:job.id,code:'reply_settings_refreshed'});
  }

  setRunning(running) {
    if (typeof running !== 'boolean') throw new TypeError('运行状态必须是布尔值');
    this._mutate(() => {
      this._state.config.running = running;
      this._log('info', running ? '工作台已启动，等待新事件' : '工作台已暂停', { code: running ? 'started' : 'paused' });
    });
    return clone(this._state.config);
  }

  _baseEvent(event, requireBuyer = true) {
    if (!plain(event)) throw new TypeError('事件必须是对象');
    const result = {
      shopId: textField(event.shopId, '店铺 ID', { max: 512, nonempty: true }),
      buyerId: textField(event.buyerId, '买家 ID', { fallback: '', max: 512, nonempty: requireBuyer }),
      buyerName: textField(event.buyerName, '买家名称', { fallback: '', max: 512 }),
      observedAt: event.observedAt === undefined ? this._time() : event.observedAt,
    };
    if (!Number.isFinite(result.observedAt) || result.observedAt < 0) throw new TypeError('事件时间无效');
    return result;
  }

  _job(type, event, { simulation, reason = null, content = '', matchName = '', productId, replyRuleId } = {}) {
    const time = this._time();
    const job = {
      id: randomUUID(), type,
      shopId: event.shopId, buyerId: event.buyerId, buyerName: event.buyerName,
      content, status: simulation ? 'simulated' : reason ? 'blocked' : 'queued',
      reason, createdAt: time, updatedAt: time, simulation: Boolean(simulation), matchName,
    };
    for (const key of ['orderId', 'itemId', 'title', 'sku', 'messageId', 'refundId', 'refundVersion']) if (event[key] !== undefined) job[key] = event[key];
    if (type === 'reply') {
      job.sourceSentAt = event.sentAt ?? null;
      if(typeof event.text==='string')job.sourceText=event.text;
      if (!simulation) job.needsReplyVerification = true;
    }
    if (productId) job.productId = productId;
    if (replyRuleId) job.replyRuleId = replyRuleId;
    if (['reply','delivery'].includes(type) && !reason) {
      const config=this._state.config;
      const images=type==='delivery' ? (productId ? config.products.find(row=>row.id===productId)?.images : config.deliveryFallbackImages) :
        replyRuleId ? config.replyRules.find(row=>row.id===replyRuleId)?.images : content===config.greeting ? config.greetingImages : config.fallbackImages;
      const parts=messageParts(content,images || [],config.separateLinksEnabled);
      if (parts.length) job.messageParts=parts;
    }
    this._state.jobs.push(job);
    if (!simulation) {
      this._state.counts.total += 1;
      if (reason) this._state.counts.blocked += 1;
    }
    this._log(reason ? 'warning' : 'info', simulation ? `模拟${type === 'delivery' ? '发货' : '回复'}：${reason ? reasonText[reason] : '规则匹配成功，不会实际发送'}` : reason ? reasonText[reason] : '已生成待发送任务', { jobId: job.id, code: reason || (simulation ? 'simulation' : 'queued') });
    return job;
  }

  ingestOrder(input, { simulation = false } = {}) {
    if (typeof simulation !== 'boolean') throw new TypeError('simulation 必须是布尔值');
    const event = {
      ...this._baseEvent(input),
      orderId: textField(input.orderId, '订单 ID', { max: 512, nonempty: true }),
      itemId: textField(input.itemId, '订单商品 ID', { fallback: '', max: 512 }),
      title: textField(input.title, '商品标题', { fallback: '', max: 20000 }),
      sku: textField(input.sku ?? input.spec ?? input.skuName, 'SKU', { fallback: '', max: 20000 }),
      itemCount: integerField(input.itemCount, '订单商品行数', 1, 1, 1000),
      paid: booleanField(input.paid, '付款状态', false),
      refunded: booleanField(input.refunded, '退款状态', false),
      cancelled: booleanField(input.cancelled, '取消状态', false),
    };
    const key = JSON.stringify([event.shopId, event.orderId, event.itemId]);
    let result = null;
    this._mutate(() => {
      const existing = simulation ? null : this._state.ledger.orders[key];
      if (!simulation && (event.refunded || event.cancelled)) this._stopOrder(event,event.refunded?'refunded':'cancelled');
      const hasRefund = Object.values(this._state.ledger.refunds).some(entry => entry.event.shopId === event.shopId && entry.event.orderId === event.orderId && entry.event.status !== 'closed');
      const orderReason = hasRefund ? 'refund_pending' : event.refunded ? 'refunded' : event.cancelled ? 'cancelled' : !event.paid ? 'unpaid' : null;
      if (existing) {
        const pending = this._state.jobs.find((job) => job.id === existing.jobId);
        if (pending && pending.status === 'queued' && orderReason) {
          pending.status = 'blocked';
          pending.reason = orderReason;
          pending.updatedAt = this._time();
          this._state.counts.blocked += 1;
          this._log('warning', reasonText[orderReason], { jobId: pending.id, code: orderReason });
        }
        existing.event = event;
        if (!orderReason && existing.delivered) this._maybeShipment(event);
        if (event.refunded || event.cancelled || hasRefund) existing.claimed = true;
        // Only an unpaid, never-claimed order may advance to paid. An event
        // already claimed for dispatch remains consumed for the lifetime of its ledger.
        const recoverable=pending?.status==='blocked' && ['paused','delivery_disabled','no_match','ambiguous_match'].includes(pending.reason) && this._state.config.running && this._state.config.autoDeliveryEnabled && !orderReason && planDelivery(event,this._state.config).deliverable;
        if (recoverable) {pending.status='cancelled';pending.reason='rematched';pending.updatedAt=this._time();this._state.counts.cancelled++;}
        if (existing.claimed && !recoverable || orderReason) {
          this._log('info', reasonText.duplicate, { code: 'duplicate', jobId: existing.jobId });
          return;
        }
      }
      const config = this._state.config;
      const match = planDelivery(event, config);
      let reason = orderReason;
      if (!reason && !simulation && !config.running) reason = 'paused';
      if (!reason && !simulation && !config.autoDeliveryEnabled) reason = 'delivery_disabled';
      if (!reason && match.status === 'ambiguous') reason = 'ambiguous_match';
      if (!reason && !match.deliverable) reason = 'no_match';
      const content = reason ? '' : match.content;
      result = this._job('delivery', event, { simulation, reason, content, matchName: match.matchName, productId: match.productId });
      if(match.fallback)result.deliveryFallback=true;
      if (!simulation) this._state.ledger.orders[key] = { jobId: result.id, claimed: reason !== 'unpaid', delivered: false, event };
    });
    return result ? clone(result) : null;
  }

  ingestMessage(input, { simulation = false } = {}) {
    if (typeof simulation !== 'boolean') throw new TypeError('simulation 必须是布尔值');
    const event = {
      ...this._baseEvent(input),
      ...messageMetadata(input),
      messageId: textField(input.messageId, '消息 ID', { max: 512, nonempty: true }),
      text: textField(input.text, '消息正文', { fallback: '', max: 100000 }),
      systemCode: textField(input.systemCode, '系统消息类型', { fallback: '', max: 128 }),
      direction: input.direction,
    };
    if (!['incoming', 'outgoing'].includes(event.direction)) throw new TypeError('消息方向必须是 incoming 或 outgoing');
    const key = JSON.stringify([event.shopId, event.messageId]);
    const buyerKey = JSON.stringify([event.shopId, event.buyerId]);
    let result = null;
    this._mutate(() => {
      if (!simulation && this._state.ledger.messages[key]) {
        this._log('info', reasonText.duplicate, { code: 'duplicate' });
        return;
      }
      if (!simulation) this._state.ledger.messages[key] = messageLedgerEntry(event, this._time());
      const config = this._state.config;
      if (event.direction === 'outgoing') {
        const hint = event.history || event.systemHint || event.noUnreplyHint || event.officialAutoReply || ['31', '56'].includes(event.type);
        const own = input.source === 'assistant' || this._state.jobs.some(job => job.shopId === event.shopId && job.buyerId === event.buyerId && (job.sentMessageId === event.messageId || job.status === 'sending' && [job.content, job.wireContent, job.wireContent?.trim()].includes(event.text)));
        if (!simulation && !hint && !own && config.manualInterventionEnabled) {
          for (const job of this._state.jobs) if (job.type === 'reply' && !job.simulation && job.status === 'queued' && job.shopId === event.shopId && job.buyerId === event.buyerId) {
            const evidence = { messageId: event.messageId, sentAt: event.sentAt, sourceSentAt: job.sourceSentAt ?? null,
              observedAt: event.observedAt, type: event.type, subType: event.subType };
            if (event.sentAt === null || !Number.isFinite(job.sourceSentAt) || event.sentAt === job.sourceSentAt) {
              job.needsReplyVerification = true;
              job.replyVerificationReason = 'outgoing_time_ambiguous';
              job.replyVerificationEvidence = evidence;
              job.updatedAt = this._time();
              this._log('info', '商家消息与买家咨询的先后关系不明确，将先核验官方待回复状态', { jobId: job.id, code: 'outgoing_time_ambiguous' });
              continue;
            }
            if (event.sentAt < job.sourceSentAt) {
              this._log('info', '已忽略早于本次买家咨询的商家消息', { jobId: job.id, code: 'older_outgoing_ignored', outgoingSentAt: event.sentAt, sourceSentAt: job.sourceSentAt });
              continue;
            }
            job.manualInterventionEvidence = evidence;
            job.status = 'cancelled'; job.reason = 'manual_intervention'; job.updatedAt = this._time(); this._state.counts.cancelled++;
            this._log('info', reasonText.manual_intervention, { jobId: job.id, code: 'manual_intervention', outgoingMessageId: event.messageId, outgoingSentAt: event.sentAt, sourceSentAt: job.sourceSentAt });
          }
        }
        return;
      }
      let reason = null;
      if (!simulation && !config.running) reason = 'paused';
      if (!simulation && !config.autoReplyEnabled && !reason) reason = 'reply_disabled';
      const history = this._state.ledger.replyHistory[buyerKey] || [];
      const plans = planReplies(event, config, { now: this._time(), previousAskAt: simulation ? undefined : this._state.ledger.lastAsk[buyerKey], lastRuleId: history.at(-1)?.replyRuleId, random: this.random });
      if (!simulation) this._state.ledger.lastAsk[buyerKey] = this._time();
      if (reason || !plans.length) {
        result = this._job('reply', event, { simulation, reason: reason || 'no_content' });
        return;
      }
      const plannedBodies = new Set();
      for (const plan of plans) {
        if (plannedBodies.has(normalized(plan.content))) continue;
        plannedBodies.add(normalized(plan.content));
        // Only repeated content is cooled down. A trial answer can follow a
        // welcome immediately, even when the buyer asks within a few seconds.
        const same = simulation ? [] : history.filter(row => normalized(row.content) === normalized(plan.content));
        const reservedUntil = same.length ? Math.max(...same.map(row => row.at)) + config.cooldownSeconds * 1000 : 0;
        const cooldownUntil = simulation ? 0 : Math.max(reservedUntil, this._replyCooldownUntil(event, plan.content));
        // Keep the first waiting deadline when a newer inquiry replaces an
        // unsent cooldown task; a continuous burst must not extend that deadline.
        const waiting = simulation ? [] : this._state.jobs.filter(job => job.type === 'reply' && !job.simulation && job.status === 'queued'
          && job.shopId === event.shopId && job.buyerId === event.buyerId && job.messageId !== event.messageId
          && job.replyCooldownUntil !== undefined && job.attemptedAt === undefined && job.wireContent === undefined
          && job.replyRuleId === plan.replyRuleId && job.strategy === plan.strategy && normalized(job.content) === normalized(plan.content));
        const deadline = Math.min(cooldownUntil, ...waiting.map(job => job.replyCooldownUntil));
        const job = this._job('reply', event, { ...plan, simulation });
        job.strategy = plan.strategy;
        job.notBefore = Math.max(this._time() + plan.delaySeconds * 1000, deadline);
        if (!simulation && (deadline > this._time() || waiting.length)) {
          job.replyCooldownUntil = deadline;
          if (deadline > this._time()) job.reason = 'cooldown';
          this._log('info', '相同答复已进入等待队列，冷却结束后自动核验并发送', { code: 'cooldown_queued', jobId: job.id, notBefore: job.notBefore });
        }
        for (const older of waiting) {
          older.status = 'cancelled'; older.reason = 'conversation_changed'; older.updatedAt = this._time(); this._state.counts.cancelled++;
          this._log('info', '冷却期间收到更新咨询，沿用原定时间答复最新消息', { code: 'cooldown_superseded', jobId: older.id, replacementJobId: job.id });
        }
        if (!result) result = job;
        if (!simulation) history.push({ at: this._time(), content: plan.content, replyRuleId: plan.replyRuleId || '' });
      }
      if (!simulation) this._state.ledger.replyHistory[buyerKey] = history.slice(-100);
    });
    return result ? clone(result) : null;
  }

  ingestRefund(input, { simulation = false } = {}) {
    if (typeof simulation !== 'boolean') throw new TypeError('simulation 必须是布尔值');
    const event = {
      ...this._baseEvent(input, false),
      orderId: textField(input.orderId, '订单号', { nonempty: true, max: 512 }),
      refundId: textField(input.refundId, '售后申请编号', { nonempty: true, max: 512 }),
      refundVersion: input.refundVersion === undefined ? '' : String(input.refundVersion),
      status: enumField(input.status, '退款申请状态', ['pending', 'processing', 'approved', 'refunded', 'closed'], 'pending'),
      title: textField(input.title, '商品名', { fallback: '', max: 20000 }),
    };
    const key = JSON.stringify([event.shopId, event.refundId]);
    let result = null;
    this._mutate(() => {
      const existing = simulation ? null : this._state.ledger.refunds[key];
      if (existing && existing.event.orderId !== event.orderId) throw new Error('同一退款申请编号对应的订单发生变化');
      if (!simulation && event.status !== 'closed') this._stopOrder(event, 'refund_pending');
      if (existing) {
        existing.event = event;
        const job = this._state.jobs.find(row => row.id === existing.jobId);
        if (job?.status === 'queued' && event.status !== 'pending') {
          job.status = 'cancelled'; job.reason = 'refund_closed'; job.updatedAt = this._time(); this._state.counts.cancelled++;
        }
        if (job?.status === 'blocked' && ['paused', 'refund_disabled'].includes(job.reason) && event.status === 'pending' && this._state.config.running && this._state.config.autoRefundEnabled) {
          job.status = 'queued'; job.reason = null; job.refundVersion = event.refundVersion; job.updatedAt = this._time();
          result = job;
        }
        if (job || event.status !== 'pending') return;
      }
      if (!simulation && event.status !== 'pending') {
        this._state.ledger.refunds[key] = {jobId:'',event};
        return;
      }
      const config = this._state.config;
      const reason = event.status !== 'pending' ? 'refund_closed' : !simulation && !config.running ? 'paused' : !simulation && !config.autoRefundEnabled ? 'refund_disabled' : null;
      result = this._job('refund', event, { simulation, reason, content: '同意此订单的当前退款申请', matchName: '全部退款申请自动同意' });
      if (!simulation) this._state.ledger.refunds[key] = { jobId: result.id, event };
    });
    return result ? clone(result) : null;
  }

  _stopOrder(event, reason) {
    for (const entry of Object.values(this._state.ledger.orders)) if (entry.event.shopId === event.shopId && entry.event.orderId === event.orderId) entry.claimed = true;
    for (const job of this._state.jobs) if (job.shopId === event.shopId && job.orderId === event.orderId && !job.simulation && ['delivery', 'shipment'].includes(job.type) && job.status === 'queued') {
      job.status = 'blocked'; job.reason = reason; job.updatedAt = this._time(); this._state.counts.blocked++;
      this._log('warning', reasonText[reason], { jobId: job.id, code: reason });
    }
  }

  _maybeShipment(delivery) {
    if (!this._state.config.autoConfirmShipmentEnabled) return;
    const key = JSON.stringify([delivery.shopId, delivery.orderId]);
    if (this._state.ledger.shipments[key]) return;
    if (Object.values(this._state.ledger.refunds).some(entry => entry.event.shopId === delivery.shopId && entry.event.orderId === delivery.orderId && entry.event.status !== 'closed')) return;
    const items = Object.values(this._state.ledger.orders).filter(entry => entry.event.shopId === delivery.shopId && entry.event.orderId === delivery.orderId);
    const expected = Math.max(1, ...items.map(entry => entry.event.itemCount || 1));
    if (items.length !== expected || items.some(entry => !entry.delivered || entry.event.cancelled || entry.event.refunded)) return;
    const job = this._job('shipment', { ...items[0].event, itemId: '' }, { content: items.map(entry => entry.deliveredContent || '').filter(Boolean).join('\n\n'), matchName: '内容发送成功后确认发货' });
    job.dependencies = items.flatMap(entry => [entry.jobId,...(this._state.jobs.find(row=>row.id===entry.jobId)?.partJobIds || [])]);
    this._state.ledger.shipments[key] = { jobId: job.id, confirmed: false };
  }

  prepareRepliesForResume() {
    if (!this._state.jobs.some(job => job.type==='reply' && job.status==='queued' && !job.needsReplyVerification)) return;
    this._mutate(() => {
      for (const job of this._state.jobs) if (job.type==='reply' && job.status==='queued') job.needsReplyVerification=true;
    });
  }

  prepareDeliveriesForResume() {
    const config=this._state.config;
    if(!config.autoDeliveryEnabled)return 0;
    const pending=this._state.jobs.filter(job=>!job.simulation&&['delivery','shipment'].includes(job.type)&&(job.type!=='shipment'||config.autoConfirmShipmentEnabled)&&
      (job.status==='queued'&&job.reason==='delivery_retry_wait'||job.status==='blocked'&&job.reason==='operation_rejected'));
    if(!pending.length)return 0;
    this._mutate(()=>{for(const job of pending){job.status='queued';job.reason='delivery_retry_wait';job.nextAttemptAt=this._time();job.updatedAt=this._time();}});
    return pending.length;
  }

  prepareAttachmentsForResume() {
    const config=this._state.config,pending=this._state.jobs.filter(job=>job.parentJobId && job.status==='queued' &&
      (job.type==='delivery'?config.autoDeliveryEnabled:config.autoReplyEnabled) && (job.attachmentRetryCount || job.nextAttemptAt));
    if (!pending.length) return 0;
    this._mutate(()=>{for (const job of pending) {job.nextAttemptAt=this._time();job.updatedAt=this._time();}});
    return pending.length;
  }

  preparePendingReplyRetries() {
    const pending = this._state.jobs.filter(job => !job.simulation && job.type === 'reply' && job.status === 'queued' && job.replyRetryCount > 0);
    if (!pending.length) return 0;
    this._mutate(() => {
      for (const job of pending) {
        job.nextAttemptAt = this._time();
        job.needsReplyVerification = true;
        job.updatedAt = this._time();
      }
    });
    return pending.length;
  }

  // The source event must come from the platform's dedicated unreplied list.
  // This does not replay the local failure queue or clear its deduplication data.
  recoverUnrepliedMessage(input, { reviewedCancellationJobId, retryRejectedJobId } = {}) {
    const event = { ...this._baseEvent(input),
      ...messageMetadata(input),
      messageId: textField(input.messageId, '消息 ID', { max: 512, nonempty: true }),
      text: textField(input.text, '消息正文', { fallback: '', max: 100000 }), direction: 'incoming' };
    if (input.direction !== 'incoming' || input.pending !== true || !Number.isFinite(input.sentAt) || input.sentAt < this._time() - 7 * 86400000 || input.sentAt > this._time() + 60000) throw new Error('补答需要近七天官方待回复的买家消息');
    const automaticEvidence = input.officialAutoReplyPending;
    if (automaticEvidence !== undefined && (!plain(automaticEvidence) || automaticEvidence.historyVerified !== true || automaticEvidence.sourceMessageId !== event.messageId || typeof automaticEvidence.automaticMessageId !== 'string' || !automaticEvidence.automaticMessageId || automaticEvidence.automaticMessageId.length > 512 || automaticEvidence.automaticMessageId === event.messageId || !Number.isFinite(automaticEvidence.pendingSince) || automaticEvidence.pendingSince <= 0 || automaticEvidence.pendingSince > event.sentAt)) throw Error('官方自动回复后的待回复证据无效');
    const hintEvidence = input.platformHintPending;
    if (hintEvidence !== undefined && (!plain(hintEvidence) || hintEvidence.historyVerified !== true || hintEvidence.sourceMessageId !== event.messageId || typeof hintEvidence.hintMessageId !== 'string' || !hintEvidence.hintMessageId || hintEvidence.hintMessageId.length > 512 || hintEvidence.hintMessageId === event.messageId || !Number.isFinite(hintEvidence.pendingSince) || hintEvidence.pendingSince <= 0 || hintEvidence.pendingSince > event.sentAt)) throw Error('官方系统提示后的待回复证据无效');
    if (automaticEvidence && hintEvidence) throw Error('待回复来源证据不能混用');
    const pendingEvidence = automaticEvidence || hintEvidence;
    const markerMessageId = automaticEvidence?.automaticMessageId || hintEvidence?.hintMessageId;
    const config = this._state.config;
    if (!config.running || !config.autoReplyEnabled || !config.catchUpUnrepliedEnabled) return { status: 'disabled' };
    const key = JSON.stringify([event.shopId, event.messageId]);
    const buyerKey = JSON.stringify([event.shopId, event.buyerId]);
    // Catch-up chooses the primary rule/fallback once, without another welcome.
    const plans = planReplies(event, { ...config, greetingEnabled: false }, { now: this._time(), previousAskAt: this._time(), random: () => 0 });
    if (!plans.length) return { status: 'no_content' };
    const plan = plans[0];
    const identity=[plan.content, plan.replyRuleId || '', config.replySuffixEnabled, config.replySuffixMode];
    if(config.replySuffixEnabled && config.replySuffixMode==='invisible')identity.push(INVISIBLE_PROFILE);
    identity.push(REPLY_TRANSPORT_PROFILE);
    const fingerprint = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    if (reviewedCancellationJobId !== undefined) reviewedCancellationJobId = textField(reviewedCancellationJobId, '复核取消任务 ID', { max: 128, nonempty: true });
    if (retryRejectedJobId !== undefined) retryRejectedJobId = textField(retryRejectedJobId, '重试拒绝任务 ID', { max: 128, nonempty: true });
    if (reviewedCancellationJobId !== undefined && retryRejectedJobId !== undefined) throw Error('一次补答只能指定一种复核来源');
    const previous = this._state.jobs.filter(job => !job.simulation && job.type === 'reply' && job.shopId === event.shopId && job.buyerId === event.buyerId && job.messageId === event.messageId);
    if (previous.some(job => ['sending','uncertain','sent'].includes(job.status))) return { status: 'already_handled' };
    if (previous.some(job => job.status === 'queued')) return { status: 'queued' };
    // A preflight skip never submits a message. Only fresh official history
    // proving that the source remains unanswered behind a robot or notice can
    // recover these cancellations. Genuine manual replies remain protected.
    const pendingCancellations = pendingEvidence ? previous.filter(job => !job.parentJobId && job.status === 'cancelled' && !job.outbound && !job.sentMessageId && !job.replyAttemptHistory?.length &&
      (job.reason === 'conversation_changed' || job.reason === 'manual_intervention' && job.manualInterventionEvidence?.messageId === markerMessageId)) : [];
    const pendingCancelled = pendingCancellations.at(-1);
    // An old permanent recovery claim must not strand a platform-confirmed
    // duplicate rejection. Select only the latest untouched explicit rejection.
    if (reviewedCancellationJobId === undefined && retryRejectedJobId === undefined) {
      const lastRejected = previous.findLast(job => isLegacyDuplicateReply(job) && !Object.hasOwn(job, 'retryQueuedAt') && !Object.hasOwn(job, 'retryJobId'));
      if (lastRejected) retryRejectedJobId = lastRejected.id;
    }
    const claimParts = [event.shopId, event.buyerId, event.messageId, fingerprint];
    if (reviewedCancellationJobId !== undefined) claimParts.push('reviewed_cancellation', reviewedCancellationJobId);
    if (retryRejectedJobId !== undefined) claimParts.push('retry_rejected', retryRejectedJobId);
    if (pendingCancelled) claimParts.push(hintEvidence ? 'platform_hint' : 'official_automatic_reply', pendingCancelled.id);
    const claimKey = JSON.stringify(claimParts);
    if (this._state.ledger.replyRecovery[claimKey]) return { status: 'already_attempted' };
    const reviewed = reviewedCancellationJobId === undefined ? null : previous.find(job => job.id === reviewedCancellationJobId);
    const retried = retryRejectedJobId === undefined ? null : previous.find(job => job.id === retryRejectedJobId);
    if (retryRejectedJobId !== undefined && (!retried || !isLegacyDuplicateReply(retried) || Object.hasOwn(retried, 'retryQueuedAt') || Object.hasOwn(retried, 'retryJobId'))) return { status: 'needs_review' };
    if (reviewedCancellationJobId !== undefined && (!reviewed || reviewed.status !== 'cancelled' || reviewed.reason !== 'manual_intervention' || Object.hasOwn(reviewed, 'attemptedAt') || Object.hasOwn(reviewed, 'wireContent') || Object.hasOwn(reviewed, 'reviewedAt') || Object.hasOwn(reviewed, 'recoveryJobId'))) return { status: 'needs_review' };
    // Observing a message does not prove it was answered: older versions could
    // record it and then skip it due to cooldown. Missing jobs may recover only
    // through the official pending scan plus the mandatory latest-message check.
    if (previous.some(job => job !== reviewed && job.status === 'cancelled' && job.reason !== 'rules_changed' && !pendingCancellations.includes(job) || job.status === 'blocked' && !['paused','reply_disabled','no_content','operation_rejected','adapter_unavailable'].includes(job.reason))) return { status: 'needs_review' };
    let job;
    this._mutate(() => {
      const history = this._state.ledger.replyHistory[buyerKey] || [];
      const same = history.filter(row => normalized(row.content) === normalized(plan.content));
      const reservedUntil = same.length ? Math.max(...same.map(row => row.at)) + config.cooldownSeconds * 1000 : 0;
      const cooldownUntil = Math.max(reservedUntil, this._replyCooldownUntil(event, plan.content));
      job = this._job('reply', event, { ...plan, simulation: false });
      Object.assign(job, { strategy: plan.strategy, catchUp: true, needsReplyVerification: true, sourceSentAt: input.sentAt,
        notBefore: Math.max(this._time() + plan.delaySeconds * 1000, cooldownUntil) });
      if (pendingCancelled) {
        pendingCancelled.reviewedAt=this._time();pendingCancelled.recoveryJobId=job.id;
        if (hintEvidence) job.platformHintRecoveryJobId=pendingCancelled.id;
        else job.officialAutoReplyRecoveryJobId=pendingCancelled.id;
        this._log('info','官方仍标记待回复，已核验提示后的原始咨询并恢复未发送任务',{code:hintEvidence?'platform_hint_reply_recovered':'official_auto_reply_recovered',jobId:job.id,previousJobId:pendingCancelled.id,markerMessageId});
      }
      if (reviewed) {
        reviewed.reviewedAt = this._time(); reviewed.recoveryJobId = job.id;
        job.reviewedCancellationJobId = reviewed.id;
        this._log('info', '已复核指定的未发送取消任务，保留原记录并安排一次补答', { code: 'manual_intervention_reviewed', jobId: job.id, reviewedCancellationJobId: reviewed.id });
      }
      if (retried) {
        retried.retryQueuedAt = this._time(); retried.retryJobId = job.id;
        job.retryRejectedJobId = retried.id;
        job.replyRetryCount = Math.max(1, retried.replyRetryCount || 0);
        job.replyRetrySuffixMode = job.replyRetryCount >= 2 ? 'time-tag' : 'time';
        if (job.replyRetryCount >= 2) job.replyRetryTag = true;
        job.replyRetryBodySpaces = config.replyBodySpaceRetryEnabled && job.replyRetryCount >= 3;
        const attempts = [...(retried.replyAttemptHistory || [])], rejected = rejectedReplyAttempt(retried, retried.detail);
        if (attempts.at(-1)?.at !== rejected.at || attempts.at(-1)?.sha !== rejected.sha) attempts.push(rejected);
        job.replyAttemptHistory = attempts.slice(-30);
        job.nextAttemptAt = this._time();
        this._log('info', '官方仍标为待回复，已重新安排指定拒绝记录的答复', { code: 'rejected_reply_retried', jobId: job.id, retryRejectedJobId: retried.id });
      }
      this._state.ledger.messages[key] = messageLedgerEntry(event, this._time());
      this._state.ledger.replyRecovery[claimKey] = { at: this._time(), jobId: job.id };
      this._state.ledger.lastAsk[buyerKey] = this._time();
      this._state.ledger.replyHistory[buyerKey] = [...history, { at: this._time(), content: plan.content, replyRuleId: plan.replyRuleId || '' }].slice(-100);
      if (hintEvidence) this._log('info','已从平台系统提示前找回待回复咨询，按当前规则安排补答',{code:'platform_hint_pending_queued',jobId:job.id,hintMessageId:hintEvidence.hintMessageId,sourceMessageId:event.messageId,pendingSince:hintEvidence.pendingSince});
      this._log('info', '官方确认会话仍待回复，已按当前规则安排补答', { code: 'catch_up_queued', jobId: job.id });
    });
    return { status: 'created', job: clone(job) };
  }

  nextJob({ excludeTypes = [] } = {}) {
    const config = this._state.config;
    if (!config.running) return null;
    const priority = { refund: 0, shipment: 1, delivery: 2, reply: 3 };
    const jobs = this._state.jobs.filter(job => !excludeTypes.includes(job.type) && !job.simulation && job.status === 'queued' && this._dependenciesSent(job) && (!job.notBefore || job.notBefore <= this._time()) && (!job.nextAttemptAt || job.nextAttemptAt <= this._time()) && (job.type === 'refund' ? config.autoRefundEnabled : job.type === 'shipment' ? config.autoDeliveryEnabled && config.autoConfirmShipmentEnabled : job.type === 'delivery' ? config.autoDeliveryEnabled : config.autoReplyEnabled));
    jobs.sort((a, b) => priority[a.type] - priority[b.type] || a.createdAt - b.createdAt);
    return jobs.length ? clone(jobs[0]) : null;
  }

  reconcileOperation(jobId, observed) {
    const job=this._state.jobs.find(row=>row.id===jobId);
    if (!job || job.status!=='uncertain' || !['shipment','refund'].includes(job.type)) return null;
    if (!['confirmed','not_sent'].includes(observed?.status) || observed.status==='not_sent'&&(job.type!=='shipment'||observed.eligible!==true) || observed.shopId!==job.shopId || observed.orderId!==job.orderId || job.type==='refund' && observed.refundId!==job.refundId) throw new Error('平台查询结果不能确认此任务');
    this._mutate(()=>{
      if(observed.status==='not_sent'){
        job.status='queued';job.reason='delivery_retry_wait';job.deliveryRetryCount=Math.min(Number.MAX_SAFE_INTEGER,(job.deliveryRetryCount||0)+1);job.nextAttemptAt=this._time()+5000;job.updatedAt=this._time();
        this._log('warning','已核实订单仍待发货，继续尝试确认发货',{jobId:job.id,code:'delivery_retry_wait'});
      }else{
        job.status='sent'; job.reason='platform_reconciled'; job.updatedAt=this._time(); this._countSent(job);
        this._log('info','已通过平台最新状态核实操作成功',{jobId:job.id,code:'platform_reconciled'});
      }
    });
    return clone(job);
  }

  reconcileDelivery(jobId,observed) {
    const job=this._state.jobs.find(row=>row.id===jobId);
    if(!job||job.status!=='uncertain'||job.type!=='delivery')return null;
    if(!['confirmed','not_sent'].includes(observed?.status)||observed.shopId!==job.shopId||observed.orderId!==job.orderId||observed.buyerId!==job.buyerId||observed.status==='confirmed'&&!/^[1-9]\d*$/.test(observed.messageId||''))throw new Error('平台消息核验不能确认此发货任务');
    this._mutate(()=>{
      if(observed.status==='confirmed'){
        job.status='sent';job.reason='platform_reconciled';job.sentMessageId=observed.messageId;this._countSent(job);
      }else{
        job.status='queued';job.reason='delivery_retry_wait';job.deliveryRetryCount=Math.min(Number.MAX_SAFE_INTEGER,(job.deliveryRetryCount||0)+1);job.nextAttemptAt=this._time()+5000;
      }
      job.updatedAt=this._time();this._log('info',observed.status==='confirmed'?'已从官方会话核实发货内容送达':'已核实发货内容未送达，已安排重试',{jobId:job.id,code:job.reason});
    });return clone(job);
  }

  dispatch(jobId) {
    const pending = this._dispatchTail.then(() => this._dispatch(jobId));
    this._dispatchTail = pending.catch(() => undefined);
    return pending;
  }

  _dependenciesSent(job) {
    return (job.dependencies || []).every(id => this._state.jobs.some(row => row.id===id && row.status==='sent' && row.shopId===job.shopId && row.buyerId===job.buyerId));
  }

  reconcileAttachment(jobId, observed) {
    const job=this._state.jobs.find(row=>row.id===jobId);
    if (!job?.parentJobId || job.status!=='uncertain') return null;
    if (!['confirmed','not_sent'].includes(observed?.status) || observed.shopId!==job.shopId || observed.buyerId!==job.buyerId || observed.status==='confirmed' && !/^[1-9]\d*$/.test(observed.messageId || '')) throw new Error('平台核验不能确认此附加消息');
    this._mutate(()=>{
      if (observed.status==='confirmed') {job.status='sent';job.reason='platform_reconciled';job.sentMessageId=observed.messageId;this._countSent(job);}
      else {job.status='queued';job.reason='attachment_retry_wait';job.nextAttemptAt=this._time()+5000;}
      job.updatedAt=this._time();
      this._log('info',observed.status==='confirmed'?'已从官方会话核实附加消息送达':'附加消息未送达，已安排重试',{jobId,code:job.reason});
    });
    return clone(job);
  }

  async _dispatch(jobId) {
    let job = this._state.jobs.find((candidate) => candidate.id === jobId);
    if (!job) throw new Error('找不到指定任务');
    if (job.simulation || job.status !== 'queued') return clone(job);
    if (!this._dependenciesSent(job)) return clone(job);
    if (job.nextAttemptAt > this._time()) return clone(job);
    const config = this._state.config;
    const gate = !config.running ? 'paused' : ['delivery', 'shipment'].includes(job.type) && !config.autoDeliveryEnabled ? 'delivery_disabled' : job.type === 'shipment' && !config.autoConfirmShipmentEnabled ? 'shipment_disabled' : job.type === 'refund' && !config.autoRefundEnabled ? 'refund_disabled' : job.type === 'reply' && !config.autoReplyEnabled ? 'reply_disabled' : job.notBefore > this._time() ? 'reply_delay' : null;
    if (gate) {
      this._mutate(() => {
        job.reason = gate;
        job.updatedAt = this._time();
        this._log('info', reasonText[gate], { jobId: job.id, code: gate });
      });
      return clone(job);
    }
    if (job.type === 'reply' && !job.parentJobId) {
      const cooldownUntil = this._replyCooldownUntil(job, job.content);
      if (cooldownUntil > this._time()) {
        this._mutate(() => {
          job.notBefore = Math.max(job.notBefore || 0, cooldownUntil);
          job.replyCooldownUntil = cooldownUntil;
          job.reason = 'cooldown'; job.updatedAt = this._time();
          this._log('info', '相同原文尚未到发送间隔，按上一条成功回执继续等待', { jobId: job.id, code: 'cooldown_queued', notBefore: job.notBefore });
        });
        return clone(job);
      }
    }
    const adapter = job.type === 'shipment' ? this.markShipped : job.type === 'refund' ? this.agreeRefund : this.sendMessage;
    if (typeof adapter !== 'function') {
      this._mutate(() => { job.status = 'blocked'; job.reason = 'adapter_unavailable'; job.updatedAt = this._time(); this._state.counts.blocked++; });
      return clone(job);
    }
    if (['delivery', 'shipment'].includes(job.type) && Object.values(this._state.ledger.refunds).some(entry => entry.event.shopId === job.shopId && entry.event.orderId === job.orderId && entry.event.status !== 'closed')) {
      this._mutate(() => this._stopOrder(job, 'refund_pending'));
      return clone(this._state.jobs.find(row => row.id === jobId));
    }
    const time = this._time();
    const attempts = this._state.ledger.attempts.filter((attempt) => attempt.at > time - 60000 && (!attempt.type || ['reply', 'delivery'].includes(attempt.type)));
    if (['reply', 'delivery'].includes(job.type) && attempts.length >= this._state.config.maxPerMinute) {
      this._mutate(() => {
        job.reason = 'rate_limit';
        job.updatedAt = time;
        job.nextAttemptAt = Math.max(time, Math.min(...attempts.map((attempt) => attempt.at)) + 60000);
        this._log('info', reasonText.rate_limit, { jobId: job.id, code: 'rate_limit' });
      });
      return clone(job);
    }
    this._mutate(() => {
      if(job.type==='delivery'&&job.deliveryWireContent===undefined){
        job.deliveryWireContent=!job.parentJobId&&job.deliveryDuplicateCount>0?formatReplyContent(job.content,{enabled:true,mode:'time-tag',now:time}).content:job.content;
        job.deliveryWireContentSha256=createHash('sha256').update(job.deliveryWireContent).digest('hex');
      }
      if(job.type==='reply' && job.wireContent===undefined) {
        const bodySpaces = !job.parentJobId && config.replyBodySpaceRetryEnabled && job.replyRetryCount >= 3;
        if (bodySpaces) { job.replyRetrySuffixMode = 'time-tag'; job.replyRetryTag = true; }
        const payload=formatReplyContent(job.content,{enabled:!job.parentJobId&&(!!job.replyRetrySuffixMode||config.replySuffixEnabled),mode:job.replyRetrySuffixMode||config.replySuffixMode,now:time,bodySpaces});
        if (!isValidReplyPayload(job.content, payload.content, payload.bodySpaceOffsets)) throw Error('生成的答复正文或空格位置无法通过校验');
        job.wireContent=payload.content;job.replySuffixApplied=payload.mode;
        job.replyRetryBodySpaces = bodySpaces;
        if (payload.bodySpaceOffsets !== undefined) job.replyBodySpaceOffsets = [...payload.bodySpaceOffsets];
        if(payload.note)job.replySuffixNote=payload.note;
      }
      if(job.type==='reply') {
        job.wireContentSha256=createHash('sha256').update(job.wireContent).digest('hex');
        job.wireContentLength=job.wireContent.length;
        job.replyTransportProfile=REPLY_TRANSPORT_PROFILE;
        if(job.replySuffixApplied==='invisible')job.replySuffixProfile=INVISIBLE_PROFILE;
      }
      job.status = 'sending';
      job.reason = null;
      job.attemptedAt = time;
      job.updatedAt = time;
      delete job.nextAttemptAt;
      this._state.ledger.attempts.push({ jobId: job.id, type: job.type, at: time });
      this._log('info', '已持久化发送意图，开始调用页面适配器', { jobId: job.id, code: 'sending' });
    });
    let response;
    let reason;
    try {
      response = await adapter(clone(job));
      reason = response?.status === 'confirmed' ? null : response?.status === 'skipped' ? ['delivery','shipment'].includes(job.type)?'order_changed':'conversation_changed' : response?.status === 'deferred' ? 'connection_wait' : response?.status === 'rejected' ? job.parentJobId?'attachment_retry_wait':['delivery','shipment'].includes(job.type)?'delivery_retry_wait':job.type === 'reply' && typeof response.reason === 'string' && response.reason.includes(DUPLICATE_REPLY_ERROR) ? 'reply_retry_wait' : 'operation_rejected' : 'invalid_confirmation';
    } catch {
      reason = 'send_error';
    }
    try {
      this._mutate(() => {
        // Re-read after await; other synchronous mutations may have replaced state.
        job = this._state.jobs.find((candidate) => candidate.id === jobId);
        job.status = ['conversation_changed','order_changed'].includes(reason) ? 'cancelled' : ['connection_wait', 'reply_retry_wait','delivery_retry_wait','attachment_retry_wait'].includes(reason) ? 'queued' : reason === 'operation_rejected' ? 'blocked' : reason ? 'uncertain' : 'sent';
        job.reason = reason;
        if (typeof response?.reason==='string') job.detail=response.reason.slice(0,2000);
        if(response?.outbound && typeof response.outbound.sha256==='string')job.outbound={sha256:response.outbound.sha256,length:response.outbound.length,stage:response.outbound.transport==='official_m_ws'?'official_socket_send':'official_send_argument',transport:response.outbound.transport||'official_sdk'};
        if (reason === 'operation_rejected') { this._state.counts.blocked++; job.detail = String(response?.reason || '平台未接受操作').slice(0, 2000); }
        if (reason === 'attachment_retry_wait') {
          job.attachmentRetryCount=Math.min(Number.MAX_SAFE_INTEGER,(job.attachmentRetryCount || 0)+1);
          job.nextAttemptAt=this._time()+DELIVERY_RETRY_DELAYS[Math.min(job.attachmentRetryCount-1,DELIVERY_RETRY_DELAYS.length-1)];
        }
        if(reason==='delivery_retry_wait'){
          job.deliveryRetryCount=Math.min(Number.MAX_SAFE_INTEGER,(job.deliveryRetryCount||0)+1);
          job.nextAttemptAt=this._time()+DELIVERY_RETRY_DELAYS[Math.min(job.deliveryRetryCount-1,DELIVERY_RETRY_DELAYS.length-1)];
          if(job.type==='delivery'&&typeof response?.reason==='string'&&response.reason.includes(DUPLICATE_REPLY_ERROR)){
            job.deliveryDuplicateCount=Math.min(Number.MAX_SAFE_INTEGER,(job.deliveryDuplicateCount||0)+1);
            delete job.deliveryWireContent;delete job.deliveryWireContentSha256;
          }
        }
        if (reason === 'reply_retry_wait') {
          job.replyAttemptHistory = [...(job.replyAttemptHistory || []), rejectedReplyAttempt(job, job.detail)].slice(-30);
          job.replyRetryCount = Math.min(Number.MAX_SAFE_INTEGER, (job.replyRetryCount || 0) + 1);
          job.replyRetrySuffixMode = job.replyRetryCount >= 2 ? 'time-tag' : 'time';
          if (job.replyRetryCount >= 2) job.replyRetryTag = true;
          job.replyRetryBodySpaces = this._state.config.replyBodySpaceRetryEnabled && job.replyRetryCount >= 3;
          job.needsReplyVerification = true;
          job.nextAttemptAt = this._time() + REPLY_RETRY_DELAYS[Math.min(job.replyRetryCount - 1, REPLY_RETRY_DELAYS.length - 1)];
          // Only a matching explicit rejection permits replacing an attempted
          // payload. A missing receipt or a disconnect keeps the old wire intact.
          clearReplyWire(job);
        }
        if (['conversation_changed','order_changed'].includes(reason)) this._state.counts.cancelled++;
        if (reason === 'connection_wait' || reason === 'conversation_changed') {
          job.nextAttemptAt=this._time()+3000;
          this._state.ledger.attempts=this._state.ledger.attempts.filter(attempt=>attempt.jobId!==jobId || attempt.at!==time);
        }
        job.updatedAt = this._time();
        if (!reason && typeof response?.messageId === 'string') job.sentMessageId = response.messageId.slice(0, 1024);
        if (!reason) { delete job.detail; this._countSent(job); }
        if(job.settingsRefreshPending&&job.status==='queued'&&job.type==='reply'&&!job.parentJobId)this._refreshQueuedReply(job,null,this._state.config);
        if(job.settingsRefreshPending&&job.status==='queued'&&job.type==='delivery'&&!job.parentJobId){
          const entry=this._state.ledger.orders[JSON.stringify([job.shopId,job.orderId,job.itemId])],match=entry&&planDelivery(entry.event,this._state.config);
          if(!match?.deliverable||match.productId!==job.productId||match.fallback!==!!job.deliveryFallback||match.content!==job.content||JSON.stringify(job.messageParts||[])!==JSON.stringify(messageParts(match.content,match.images,this._state.config.separateLinksEnabled))){job.status='cancelled';job.reason='rules_changed';this._state.counts.cancelled++;if(entry&&!entry.delivered)entry.claimed=false;}
        }
        delete job.settingsRefreshPending;
        const finalReason=job.reason;
        this._log(finalReason ? 'warning' : 'info', finalReason ? reasonText[finalReason] || '任务已按最新状态处理' : '已获得发送成功确认', { jobId: job.id, code: finalReason || 'sent' });
      });
    } catch (error) {
      // The disk still says sending and will recover as uncertain on next start.
      // Keep memory conservative as well; a persistence error is never a retry signal.
      job = this._state.jobs.find((candidate) => candidate.id === jobId);
      job.status = 'uncertain';
      job.reason = 'persistence_after_send';
      throw new Error('发送之后未能保存结果，必须人工核实，禁止自动重试', { cause: error });
    }
    return clone(job);
  }

  _countSent(job) {
    if (job.type === 'reply' && !job.parentJobId) {
      job.replyConfirmedAt = this._time();
      const buyerKey = JSON.stringify([job.shopId, job.buyerId]);
      const history = this._state.ledger.replyHistory[buyerKey] || [];
      this._state.ledger.replyHistory[buyerKey] = [...history, { at: job.replyConfirmedAt,
        confirmedAt: job.replyConfirmedAt, content: job.content, replyRuleId: job.replyRuleId || '' }].slice(-100);
    }
    this._state.counts.sent += 1;
    if (!job.parentJobId) this._state.counts[({ delivery: 'deliverySent', reply: 'replySent', shipment: 'shipmentSent', refund: 'refundSent' })[job.type]] += 1;
    if (!job.parentJobId && job.messageParts?.length && !job.partJobIds) {
      job.partJobIds=[];
      for (const part of job.messageParts) {
        const child=this._job(job.type,job,{content:part.content,matchName:part.kind==='link'?'单独发送纯链接':'附加图片 / 二维码',productId:job.productId,replyRuleId:job.replyRuleId});
        delete child.messageParts;
        Object.assign(child,{parentJobId:job.id,partKind:part.kind,dependencies:[job.partJobIds.at(-1) || job.id],sourceSentAt:job.sourceSentAt ?? null});
        if (part.kind==='image') child.image=clone(part.image);
        if (job.deliveryFallback) child.deliveryFallback=true;
        job.partJobIds.push(child.id);
      }
    }
    if (job.type === 'delivery') {
      const entry = this._state.ledger.orders[JSON.stringify([job.shopId, job.orderId, job.itemId])];
      const parent=job.parentJobId ? this._state.jobs.find(row=>row.id===job.parentJobId) : job;
      if (entry && parent && entry.jobId===parent.id) {
        entry.delivered = parent.status==='sent' && (parent.partJobIds || []).every(id=>this._state.jobs.some(row=>row.id===id && row.status==='sent'));
        entry.deliveredContent = parent.content;
      }
      this._maybeShipment(job);
    } else if (job.type === 'shipment') {
      const entry = this._state.ledger.shipments[JSON.stringify([job.shopId, job.orderId])];
      if (entry) entry.confirmed = true;
    } else if (job.type === 'refund') {
      const entry = this._state.ledger.refunds[JSON.stringify([job.shopId, job.refundId])];
      if (entry) entry.event.status = 'approved';
    }
  }

  resolveUncertain(jobId, resolution) {
    if (!['sent', 'cancelled'].includes(resolution)) throw new TypeError('核实结果必须是 sent 或 cancelled');
    const job = this._state.jobs.find((candidate) => candidate.id === jobId);
    if (!job || job.simulation || job.status !== 'uncertain') throw new Error('只有结果不明的真实任务可以人工结案');
    this._mutate(() => {
      job.status = resolution;
      job.reason = resolution === 'sent' ? 'manual_confirmed' : 'manual_cancelled';
      job.updatedAt = this._time();
      if (resolution === 'sent') this._countSent(job);
      else this._state.counts.cancelled += 1;
      this._log('info', reasonText[job.reason], { jobId: job.id, code: job.reason });
    });
    return clone(job);
  }

  clearLogs() {
    this._mutate(() => { this._state.logs = []; });
    return this.snapshot();
  }
}

module.exports = { Engine, defaults, matchProduct, planDelivery, validateConfig };
