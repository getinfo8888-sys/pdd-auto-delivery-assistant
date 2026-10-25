'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { validateConfig } = require('./engine.cjs');

const FORMAT = 'local-commerce-content';
const SETTING_KEYS = ['greetingEnabled', 'greeting', 'fallback', 'suffix', 'deliveryFallbackEnabled', 'deliveryFallback'];
const COMMON_KEYS = ['id', 'name', 'keywords', 'content', 'enabled'];
const PRODUCT_KEYS = [...COMMON_KEYS, 'excludeKeywords', 'matchTarget'];
const REPLY_KEYS = [...COMMON_KEYS, 'matchType', 'priority', 'delaySeconds', 'weekSlots'];
const GROUPS = [
  { scope: 'greeting', label: '欢迎语', keys: ['greetingEnabled', 'greeting'], images: 'greetingImages' },
  { scope: 'fallback', label: '默认答复', keys: ['fallback'], images: 'fallbackImages' },
  { scope: 'deliveryFallback', label: '默认发货', keys: ['deliveryFallbackEnabled', 'deliveryFallback'], images: 'deliveryFallbackImages' },
];
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, structuredClone(value[key])]));
const same = isDeepStrictEqual;
const digest = config => createHash('sha256').update(JSON.stringify(validateConfig(config))).digest('hex');

function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new TypeError(`${label}格式不正确或包含不支持的字段`);
}
function list(value, max, label) {
  if (!Array.isArray(value) || value.length > max) throw new TypeError(`${label}数量超出限制或格式不正确`);
}
function shortText(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TypeError(`${label}格式不正确`);
  return value.trim();
}

// This format contains content only. Platform sessions, tasks, receipts and media
// upload URLs never enter the portable document.
function exportSharedContent(input, { platform = 'pdd', now = new Date().toISOString() } = {}) {
  const config = validateConfig(input);
  const row = (value, keys) => ({ ...pick(value, keys), needsMedia: value.images.length > 0 });
  return validateSharedContent({
    format: FORMAT, version: 1, exportedAt: now, source: { platform },
    content: {
      settings: pick(config, SETTING_KEYS),
      products: config.products.map(value => row(value, PRODUCT_KEYS)),
      replyRules: config.replyRules.filter(value => value.matchType !== 'system').map(value => row(value, REPLY_KEYS)),
    },
    review: {
      mediaSettings: GROUPS.filter(group => config[group.images].length).map(group => group.scope),
      excludedRules: config.replyRules.filter(value => value.matchType === 'system').map(value => ({ id: value.id, name: value.name, reason: 'platform_system' })),
    },
  });
}

function validateSharedContent(value) {
  object(value, ['format', 'version', 'exportedAt', 'source', 'content', 'review'], '共享文件');
  if (value.format !== FORMAT || value.version !== 1) throw new TypeError('不支持的共享文字规则格式或版本');
  if (typeof value.exportedAt !== 'string' || value.exportedAt.length > 40 || !Number.isFinite(Date.parse(value.exportedAt))) throw new TypeError('导出时间格式不正确');
  object(value.source, ['platform'], '来源');
  if (!['pdd', 'taobao'].includes(value.source.platform)) throw new TypeError('不支持的来源平台');
  object(value.content, ['settings', 'products', 'replyRules'], '共享内容');
  object(value.content.settings, SETTING_KEYS, '通用文案');
  if (SETTING_KEYS.some(key => !Object.hasOwn(value.content.settings, key))) throw new TypeError('通用文案字段不完整');
  const normalizeRows = (rows, keys, kind) => {
    list(rows, 5000, kind);
    for (const row of rows) {
      object(row, [...keys, 'needsMedia'], kind);
      if (typeof row.needsMedia !== 'boolean' || COMMON_KEYS.some(key => !Object.hasOwn(row, key))) throw new TypeError(`${kind}字段不完整`);
      if (row.matchType === 'system') throw new TypeError('平台系统规则不能作为共享文字规则执行');
    }
    const normalized = validateConfig({ [kind === '商品' ? 'products' : 'replyRules']: rows });
    return normalized[kind === '商品' ? 'products' : 'replyRules'].map((row, index) => ({ ...pick(row, keys), needsMedia: rows[index].needsMedia }));
  };
  const config = validateConfig(value.content.settings);
  object(value.review, ['mediaSettings', 'excludedRules'], '待处理项目');
  list(value.review.mediaSettings, 3, '图片文案');
  if (value.review.mediaSettings.some(scope => !GROUPS.some(group => group.scope === scope)) || new Set(value.review.mediaSettings).size !== value.review.mediaSettings.length) throw new TypeError('图片文案范围不正确');
  list(value.review.excludedRules, 5000, '平台系统规则');
  const ids = new Set();
  const excludedRules = value.review.excludedRules.map(row => {
    object(row, ['id', 'name', 'reason'], '平台系统规则');
    const id = shortText(row.id, 128, '规则编号'), name = shortText(row.name, 200, '规则名称');
    if (ids.has(id) || row.reason !== 'platform_system') throw new TypeError('平台系统规则标记不正确');
    ids.add(id);
    return { id, name, reason: 'platform_system' };
  });
  const products = normalizeRows(value.content.products, PRODUCT_KEYS, '商品');
  const replyRules = normalizeRows(value.content.replyRules, REPLY_KEYS, '答复');
  if (replyRules.some(row => ids.has(row.id))) throw new TypeError('普通答复与平台系统规则编号不能重复');
  return {
    format: FORMAT, version: 1, exportedAt: value.exportedAt, source: { platform: value.source.platform },
    content: { settings: pick(config, SETTING_KEYS), products, replyRules },
    review: { mediaSettings: [...value.review.mediaSettings], excludedRules },
  };
}

function readSharedContent(value) {
  if (value?.format === 'link-workbench-rules' && [1, 2].includes(value.version)) return exportSharedContent(value.config);
  return validateSharedContent(value);
}

function previewSharedImport(input, currentInput, mode = 'merge') {
  if (!['merge', 'replace'].includes(mode)) throw new TypeError('请选择合并或替换');
  const pack = readSharedContent(input), current = validateConfig(currentInput), next = structuredClone(current);
  const changes = [], warnings = [];
  const addWarning = (name, reason) => warnings.push({ name, reason });
  for (const group of GROUPS) {
    if (pack.review.mediaSettings.includes(group.scope) || current[group.images].length) {
      addWarning(group.label, '保留本机文案及图片，请在目标店铺单独配置图片');
      continue;
    }
    for (const key of group.keys) {
      const after = pack.content.settings[key], before = current[key];
      changes.push({ kind: 'setting', id: key, name: group.label + (typeof after === 'boolean' ? '开关' : '正文'), action: same(before, after) ? 'unchanged' : 'update', before, after });
      next[key] = after;
    }
  }
  changes.push({ kind: 'setting', id: 'suffix', name: '统一发货尾缀', action: current.suffix === pack.content.settings.suffix ? 'unchanged' : 'update', before: current.suffix, after: pack.content.settings.suffix });
  next.suffix = pack.content.settings.suffix;
  for (const key of ['products', 'replyRules']) {
    const kind = key === 'products' ? 'product' : 'reply';
    const previous = new Map(current[key].map(row => [row.id, row]));
    const incoming = new Map();
    for (const row of pack.content[key]) {
      const before = previous.get(row.id);
      if (before?.matchType === 'system') {
        addWarning(row.name, '编号与本机平台系统规则相同，保留本机规则');
        continue;
      }
      const { needsMedia, ...textRow } = row;
      const needsReview = needsMedia || !!before?.images.length;
      const after = { ...textRow, enabled: needsReview ? false : row.enabled, images: [] };
      incoming.set(row.id, after);
      if (needsReview) addWarning(row.name, '已去除图片并停用，请补齐图片、核对正文后手动启用');
      changes.push({ kind, id: row.id, name: row.name, action: !before ? 'add' : same(before, after) ? 'unchanged' : 'update', before: before || null, after });
    }
    next[key] = current[key].flatMap(row => {
      if (incoming.has(row.id)) { const updated = incoming.get(row.id); incoming.delete(row.id); return [updated]; }
      if (mode === 'merge' || row.matchType === 'system') return [row];
      changes.push({ kind, id: row.id, name: row.name, action: 'remove', before: row, after: null });
      return [];
    }).concat([...incoming.values()]);
    // Combined lists are validated too: two individually valid files can exceed
    // the engine's capacity when merged.
  }
  for (const row of pack.review.excludedRules) addWarning(row.name, '来源平台的系统规则未导入，请在对应平台单独设置');
  Object.assign(next, { running: false, autoListenOnLaunch: false, autoReplyEnabled: false, autoDeliveryEnabled: false, autoRefundEnabled: false });
  const config = validateConfig(next);
  const summary = Object.fromEntries(['add', 'update', 'remove', 'unchanged'].map(action => [action, changes.filter(row => row.action === action && row.kind !== 'setting').length]));
  summary.settings = changes.filter(row => row.kind === 'setting' && row.action !== 'unchanged').length;
  summary.review = warnings.length;
  return { mode, source: pack.source.platform, summary, changes, warnings, config };
}

// Main-process-only draft: apply never accepts a renderer-supplied config or
// re-reads a file that might have changed since preview.
class SharedImportDraft {
  constructor() { this.draft = null; }
  prepare(value, current, mode = 'merge') {
    const pack = readSharedContent(value), preview = previewSharedImport(pack, current, mode);
    const token = randomUUID();
    this.draft = { token, pack, mode, baseline: digest(current), config: preview.config };
    const { config, ...publicPreview } = preview;
    return { ...publicPreview, token };
  }
  repreview(token, current, mode) {
    return this.prepare(this.require(token).pack, current, mode);
  }
  require(token) {
    if (!this.draft || this.draft.token !== token) throw new Error('导入预览已失效，请重新选择文件');
    return this.draft;
  }
  apply(token, current, { idle, backup, update }) {
    const draft = this.require(token);
    if (!idle || current.running) throw new Error('请先暂停监听，待当前平台操作结束后重新预览导入');
    if (digest(current) !== draft.baseline) throw new Error('本机规则或设置已变化，请刷新导入预览后再确认');
    const config = structuredClone(draft.config);
    backup(structuredClone(current));
    update(config);
    this.draft = null;
    return config;
  }
  cancel(token) { if (this.draft?.token === token) this.draft = null; }
}

module.exports = { FORMAT, exportSharedContent, validateSharedContent, readSharedContent, previewSharedImport, SharedImportDraft };
