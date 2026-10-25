'use strict';

// Independent implementation of the matching strategies documented in the REA
// report. Expressions are parsed as data; they never become JavaScript/RegExp.
function parseExpression(source) {
  if (typeof source !== 'string' || !source.trim() || source.length > 256) throw new TypeError('包含表达式需要 1 到 256 个字符');
  const tokens = source.match(/[(),+\-]|[^(),+\-]+/gu).map(s => s.trim()).filter(Boolean);
  let index = 0, depth = 0;
  function atom() {
    if (++depth > 24) throw new TypeError('包含表达式括号过深');
    let node;
    if (tokens[index] === '(') {
      index++; node = or();
      if (tokens[index++] !== ')') throw new TypeError('包含表达式括号不配对');
    } else if (tokens[index] === '-') { index++; node = { not: atom() }; }
    else {
      const word = tokens[index++];
      if (!word || ['+', ',', ')'].includes(word)) throw new TypeError('包含表达式缺少关键词');
      node = { word };
    }
    depth--; return node;
  }
  function and() {
    let node = atom();
    while (tokens[index] === '+' || tokens[index] === '-') {
      const op = tokens[index++]; const right = atom();
      node = { and: [node, op === '-' ? { not: right } : right] };
    }
    return node;
  }
  function or() {
    let node = and();
    while (tokens[index] === ',') { index++; node = { or: [node, and()] }; }
    return node;
  }
  const node = or();
  if (index !== tokens.length) throw new TypeError('包含表达式格式不正确');
  return node;
}

function expressionMatches(node, text) {
  if (node.word !== undefined) return text.toLowerCase().includes(node.word.toLowerCase());
  if (node.not) return !expressionMatches(node.not, text);
  if (node.and) return node.and.every(child => expressionMatches(child, text));
  return node.or.some(child => expressionMatches(child, text));
}

function wildcardMatches(pattern, text) {
  let p = 0, t = 0, star = -1, resume = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) { p++; t++; }
    else if (pattern[p] === '*') { star = p++; resume = t; }
    else if (star >= 0) { p = star + 1; t = ++resume; }
    else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

function activeAt(rule, now) {
  if (!rule.weekSlots?.length) return true;
  const china = new Date(now + 8 * 3600000);
  const day = (china.getUTCDay() + 6) % 7;
  return rule.weekSlots.includes(day * 48 + china.getUTCHours() * 2 + Math.floor(china.getUTCMinutes() / 30));
}

function selectReply(event, rules, { now, lastRuleId, random = Math.random } = {}) {
  const text = event.text;
  const modePriority = { system: 0, exact: 100, wildcard: 100, contains: 300, expression: 300 };
  let candidates = rules.filter(rule => rule.enabled && activeAt(rule, now) && rule.keywords.some(word => {
    switch (rule.matchType) {
      case 'system': return !!event.systemCode && event.systemCode === word;
      case 'exact': return text === word;
      case 'wildcard': return wildcardMatches(word, text);
      case 'expression': return expressionMatches(parseExpression(word), text);
      default: return text.toLowerCase().includes(word.toLowerCase());
    }
  }));
  if (!candidates.length) return null;
  const rank = rule => modePriority[rule.matchType] * 1000 + rule.priority;
  const first = Math.min(...candidates.map(rank));
  candidates = candidates.filter(rule => rank(rule) === first);
  const alternatives = candidates.filter(rule => rule.id !== lastRuleId);
  if (alternatives.length) candidates = alternatives;
  const value = Math.max(0, Math.min(0.999999999, Number(random()) || 0));
  return candidates[Math.floor(value * candidates.length)];
}

function planReplies(event, config, { now, previousAskAt, lastRuleId, random } = {}) {
  const first = previousAskAt === undefined || now - previousAskAt >= config.firstReplyIntervalMinutes * 60000;
  const rule = selectReply(event, config.replyRules, { now, lastRuleId, random });
  const plans = [];
  if (first && config.greetingEnabled && config.greeting) plans.push({ content: config.greeting, matchName: '首次欢迎语', strategy: 'greeting', delaySeconds: config.firstReplyDelaySeconds });
  if (rule) plans.push({ content: rule.content, matchName: rule.name, replyRuleId: rule.id, strategy: rule.matchType, delaySeconds: rule.delaySeconds ?? config.replyDelaySeconds });
  else if (!plans.length && config.fallback) plans.push({ content: config.fallback, matchName: '默认回复', strategy: 'fallback', delaySeconds: config.replyDelaySeconds });
  return plans;
}

module.exports = { parseExpression, expressionMatches, wildcardMatches, planReplies, selectReply };
