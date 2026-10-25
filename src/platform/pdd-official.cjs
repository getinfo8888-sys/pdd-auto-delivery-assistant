'use strict';

// Our own read-only projection of the official page's already loaded Vue state.
// Keep this function self-contained: it runs in the page without Node access.
function officialRuntime() {
  const clean = (value, max = 12000) => typeof value === 'string' ? value.replace(/\u0000/g, '').slice(0, max) : '';
  const id = value => {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return '';
    if (!['number', 'string'].includes(typeof value)) return '';
    const result = String(value).trim();
    return result && result.length <= 160 && !/^(Infinity|NaN|undefined|null)$/i.test(result) ? result : '';
  };
  const seconds = value => {
    if (!['number', 'string'].includes(typeof value) || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n > 946684800 && n < 4102444800 ? Math.round(n * 1000) : null;
  };
  const primitive = value => ['number', 'boolean', 'string'].includes(typeof value) ? String(value).slice(0, 160) : '';
  const roots = [];
  const rootElement = document.querySelector('#app');
  if (rootElement?.__vue__) roots.push(rootElement.__vue__);
  if (!roots.length) {
    // Vue may put __vue__ on the replaced root element rather than #app.
    for (const node of Array.from(document.querySelectorAll('body > *')).slice(0, 40)) if (node.__vue__) roots.push(node.__vue__);
  }
  const components = [], visited = new Set(), pending = [...roots];
  while (pending.length && components.length < 1200) {
    const component = pending.shift();
    if (!component || visited.has(component)) continue;
    visited.add(component); components.push(component);
    if (Array.isArray(component.$children)) pending.push(...component.$children.slice(0, 150));
  }
  const store = components.map(component => component.$store).find(candidate => candidate?.state && Array.isArray(candidate.state.chatList));
  if (!store) return { source: 'pdd-official-vue', readOnly: true, ready: false, issue: '尚未识别到已登录的官方客服会话数据', componentCount: components.length };
  const state = store.state;
  const shopId = id(state.userInfo?.mall_id);
  const merchantUid = id(state.userInfo?.uid);
  const currentBuyerId = id(state.currentUserInfo?.userInfo?.uid);
  const list = state.chatList.slice(0, 2000);
  if (state.currentUserInfo && !list.includes(state.currentUserInfo)) list.push(state.currentUserInfo);
  const conversations = new Map();
  const orderReferences = new Map();
  const messageKeys = new Set();
  let ignoredMessages = 0;
  for (const conversation of list) {
    const buyerId = id(conversation?.userInfo?.uid);
    if (!buyerId || buyerId === merchantUid || conversation.chat_type === 'conciliation' || Number(conversation.chat_type_id) === 9) continue;
    const buyerName = clean(conversation.userInfo?.nickname, 100);
    const result = conversations.get(buyerId) || { buyerId, buyerName, messages: [] };
    conversations.set(buyerId, result);
    const messages = Array.isArray(conversation.messageList) ? conversation.messageList.slice(-500) : [];
    if (conversation.lastMessage && !messages.includes(conversation.lastMessage)) messages.push(conversation.lastMessage);
    for (const message of messages) {
      const messageId = id(message?.msg_id);
      const role = message?.from?.role;
      const fromUid = id(message?.from?.uid), toUid = id(message?.to?.uid);
      const referenceId = id(message?.info?.orderSequenceNo);
      const referenceTitle = clean(message?.info?.goodsName, 2000);
      const userEndpointMatches = role === 'user' && fromUid === buyerId || message?.to?.role === 'user' && toUid === buyerId;
      const isOrderCard = Number(message?.type) === 0 && Number(message?.sub_type) === 1;
      if (conversation === state.currentUserInfo && buyerId === currentBuyerId && isOrderCard && messageId && referenceId && referenceTitle && userEndpointMatches) {
        const existing = orderReferences.get(referenceId);
        if (!existing) orderReferences.set(referenceId, { orderId: referenceId, buyerId, title: referenceTitle, messageId });
        else if (existing.buyerId !== buyerId || existing.title !== referenceTitle) existing.conflict = true;
      }
      const incoming = role === 'user' && Number(message?.from?.user_type) !== 6 && fromUid === buyerId;
      const outgoing = role === 'mall_cs' && fromUid === merchantUid && toUid === buyerId;
      if (!messageId || (!incoming && !outgoing)) { ignoredMessages += 1; continue; }
      const key = buyerId + '\0' + messageId;
      if (messageKeys.has(key)) continue;
      messageKeys.add(key);
      result.messages.push({ messageId, buyerId, buyerName, direction: incoming ? 'incoming' : 'outgoing',
        text: clean(message.content), sentAt: seconds(message.ts), history: message.is_history === true,
        systemHint: message.is_system_hint_mall === true || message.is_system_hint_mall === 1,
        noUnreplyHint: message.no_unreply_hint === true || message.no_unreply_hint === 1,
        officialAutoReply: outgoing && (message.show_auto === true || message.show_auto === 1 || message.show_auto === '1' || message.from?.csid === '自动回复'),
        type: primitive(message.type), subType: primitive(message.sub_type) });
    }
  }
  const orders = new Map();
  for (const component of components) {
    // Read exactly the documented OrderItem prop, never serialize a Vue instance.
    if (component.$options?.name !== 'OrderItem') continue;
    const order = component.$props?.order;
    const orderId = id(order?.orderSn), buyerId = id(order?.uid);
    const goods = order?.orderGoodsList;
    if (!orderId || !buyerId || !goods || Array.isArray(goods) || typeof goods !== 'object') continue;
    const status = clean(order.listStatus, 160), paidAt = seconds(order.payTime);
    const afterSales = order.afterSalesInfo;
    const afterSalesType = primitive(afterSales?.afterSalesType);
    const afterSalesStatus = primitive(afterSales?.afterSalesStatus);
    const orderAfterSalesStatus = primitive(order.orderAfterSalesStatus);
    const afterSalesKnown = afterSales !== null && typeof afterSales === 'object' && afterSalesType !== '' && afterSalesStatus !== '' || orderAfterSalesStatus === '0';
    const hasAfterSales = [afterSalesType, afterSalesStatus, orderAfterSalesStatus].some(value => value !== '' && value !== '0');
    const title = clean(goods.goodsName, 2000);
    const issues = [];
    if (status !== '待发货') issues.push('状态并非明确待发货');
    if (!paidAt) issues.push('缺少有效付款时间');
    if (hasAfterSales) issues.push('存在售后状态，需人工核对');
    if (!afterSalesKnown) issues.push('售后状态尚未确认');
    if (!title) issues.push('缺少商品标题');
    if (currentBuyerId && currentBuyerId !== buyerId) issues.push('订单买家与当前会话不一致');
    const projection = { orderId, buyerId, title, goodsId: id(goods.goodsId), status, paidAt,
      spec: clean(goods.spec, 500), hasAfterSales, eligible: issues.length === 0, issues };
    const previous = orders.get(orderId);
    if (previous && (previous.buyerId !== buyerId || previous.title !== title || previous.status !== status)) {
      previous.eligible = false; previous.issues.push('同一订单出现冲突数据');
    } else if (!previous) orders.set(orderId, projection);
  }
  const visibleText = clean(document.body?.innerText, 100000);
  const sessionConflict = visibleText.includes('账户在别处登录') || visibleText.includes('账号在别处登录');
  const ready = !!shopId && !!merchantUid && !sessionConflict;
  return { source: 'pdd-official-vue', readOnly: true, ready, shopId, merchantUid, currentBuyerId,
    issue: sessionConflict ? '官方页面提示账户在别处登录' : ready ? '' : '店铺或客服身份尚未完整加载',
    conversations: [...conversations.values()], orders: [...orders.values()], orderReferences: [...orderReferences.values()], ignoredMessages,
    componentCount: components.length, coverage: '仅官方客服页已加载的会话和右侧订单；只读取，不发送消息。' };
}

function makeOfficialScript() { return `(${officialRuntime.toString()})()`; }

function summarizeOfficial(value) {
  const conversations = value.conversations || [], orders = value.orders || [];
  return { source: value.source, readOnly: true, ready: !!value.ready, issue: value.issue || '',
    shopId: value.shopId || '', currentBuyerId: value.currentBuyerId || '',
    conversationCount: conversations.length, messageCount: conversations.reduce((n, c) => n + c.messages.length, 0),
    incomingCount: conversations.reduce((n, c) => n + c.messages.filter(m => m.direction === 'incoming').length, 0),
    orderCount: orders.length, eligibleOrderCount: orders.filter(order => order.eligible).length,
    boundOrderCount: orders.filter(order => order.buyerId).length,
    linkedOrderCount: (value.orderReferences || []).filter(reference => !reference.conflict).length,
    ignoredMessages: value.ignoredMessages || 0, componentCount: value.componentCount || 0,
    orderSamples: orders.slice(0, 8).map(({ title, status, paidAt, eligible, issues }) => ({ title, status, paidAt, eligible, issues })),
    coverage: value.coverage || '仅检测已加载的官方客服页面。', checkedAt: Date.now() };
}

module.exports = { makeOfficialScript, summarizeOfficial };
