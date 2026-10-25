const ALLOWED_ROOTS = ['pinduoduo.com', 'yangkeduo.com'];
function allowedUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && ALLOWED_ROOTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h)); } catch { return false; }
}
function defaultProfile() {
  return { shopId: '我的店铺', verifiedAt: null, chat: { buyer: '', buyerIdAttribute: 'data-uid', incoming: '', messageIdAttribute: 'data-msg-id', input: '', send: '', outgoing: '', outgoingMessageIdAttribute: 'data-msg-id', receipt: '' }, orders: { row: '', itemIdAttribute: 'data-order-item-id', orderId: '', title: '', buyer: '', buyerIdAttribute: 'data-uid', status: '', paidText: '待发货', paidAt: '', contact: '' } };
}
function validateProfile(value) {
  const result = defaultProfile();
  if (!value || typeof value !== 'object') throw new Error('页面连接设置无效');
  result.shopId = String(value.shopId || '').trim().slice(0, 80);
  if (!result.shopId) throw new Error('请填写店铺标识');
  for (const section of ['chat', 'orders']) for (const key of Object.keys(result[section])) {
    const v = value[section]?.[key] ?? result[section][key];
    if (typeof v !== 'string' || v.length > 512 || /[\u0000-\u001f]/.test(v)) throw new Error('页面定位信息格式无效');
    result[section][key] = v.trim();
  }
  for (const field of [result.chat.buyerIdAttribute, result.chat.messageIdAttribute, result.chat.outgoingMessageIdAttribute, result.orders.buyerIdAttribute, result.orders.itemIdAttribute]) if (field && !/^[a-zA-Z_:][\w:.-]*$/.test(field)) throw new Error('标识属性名称无效');
  return result;
}

// This function is serialized into the official page. It has no Node access,
// credentials API, private HTTP endpoints, or access to the local application.
async function pageRuntime(action, profile, payload) {
  const normalize = text => String(text || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const text = node => normalize(node?.textContent || '');
  const visible = node => !!node && !!(node.getBoundingClientRect().width && node.getBoundingClientRect().height) && getComputedStyle(node).visibility !== 'hidden';
  const all = (selector, root = document) => { if (!selector) return []; try { return [...root.querySelectorAll(selector)].filter(visible); } catch { throw new Error('页面定位已失效，请重新选择'); } };
  const one = (selector, root = document) => { const nodes = all(selector, root); if (nodes.length !== 1) throw new Error(`页面元素应唯一，实际为 ${nodes.length} 个`); return nodes[0]; };
  const identifier = (node, attribute) => { const v = attribute && node?.getAttribute(attribute); return v ? String(v).trim() : ''; };
  const hasReceipt = node => {
    if (!profile.chat.receipt) return false;
    let receipt;
    try { receipt = node.matches(profile.chat.receipt) ? node : node.querySelector(profile.chat.receipt); } catch { throw new Error('发送回执定位格式无效'); }
    if (!visible(receipt)) return false;
    return [text(receipt), receipt.getAttribute('aria-label'), receipt.getAttribute('title'), receipt.getAttribute('data-status')].filter(Boolean).some(value => /^(已送达|已发送|发送成功|sent|delivered|success)$/i.test(normalize(value)));
  };
  const currentBuyer = () => { const node = one(profile.chat.buyer); const id = identifier(node, profile.chat.buyerIdAttribute); if (!id) throw new Error('无法读取稳定的买家标识，已停止自动发送'); return { buyerId: id, buyerName: text(node).slice(0, 100) }; };
  const chatSnapshot = () => {
    const buyer = currentBuyer();
    const incoming = all(profile.chat.incoming).map(node => ({ messageId: identifier(node, profile.chat.messageIdAttribute), text: text(node).slice(0, 12000), direction: 'incoming', ...buyer })).filter(m => m.text);
    if (incoming.some(m => !m.messageId)) throw new Error('买家消息缺少唯一编号，不能可靠去重');
    const input = one(profile.chat.input); const send = one(profile.chat.send);
    const outgoing = all(profile.chat.outgoing);
    if (!outgoing.length) throw new Error('请用一条历史商家消息校验发送气泡');
    if (!profile.chat.receipt) throw new Error('尚未校验平台发送成功标记，自动发送保持关闭');
    if (outgoing.some(node => !identifier(node, profile.chat.outgoingMessageIdAttribute))) throw new Error('商家消息缺少稳定唯一编号，不能核验本次回执');
    if (!outgoing.some(hasReceipt)) throw new Error('未找到可见的成功回执，自动发送保持关闭');
    if (!incoming.length) throw new Error('请用一条历史买家消息校验唯一编号');
    if (!(input instanceof HTMLTextAreaElement || (input instanceof HTMLInputElement && !['password','hidden'].includes(input.type)) || input.isContentEditable)) throw new Error('选择的消息输入框不可编辑');
    if (send.matches(':disabled,[aria-disabled="true"]')) throw new Error('发送按钮尚未就绪');
    if (all(profile.chat.incoming).some(node => all(profile.chat.outgoing).includes(node))) throw new Error('买家和商家消息定位重叠，需重新选择');
    return { ...buyer, messages: incoming, ready: true };
  };
  const orderSnapshot = () => {
    const singleOrders = new Set();
    return all(profile.orders.row).map(row => {
    const orderId = text(one(profile.orders.orderId, row)).replace(/^(订单号|订单编号)[：:\s]*/, '').trim();
    const title = text(one(profile.orders.title, row));
    const buyerNode = one(profile.orders.buyer, row);
    const buyerId = identifier(buyerNode, profile.orders.buyerIdAttribute);
    const status = text(one(profile.orders.status, row));
    if (!orderId || !title || !buyerId) throw new Error('订单号、标题或买家标识缺失，已停止处理');
    const payment = profile.orders.paidAt ? text(one(profile.orders.paidAt, row)) : '';
    const date = payment.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})[日\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    const paidAt = date ? Date.parse(`${date[1]}-${date[2].padStart(2,'0')}-${date[3].padStart(2,'0')}T${date[4].padStart(2,'0')}:${date[5]}:${date[6]||'00'}+08:00`) : null;
    const stableItemId = identifier(row, profile.orders.itemIdAttribute);
    if (!stableItemId && singleOrders.has(orderId)) throw new Error('同一订单有多个商品行但缺少稳定行编号，已停止处理');
    if (!stableItemId) singleOrders.add(orderId);
    return { orderId, itemId: stableItemId || 'single-order', title, buyerId, buyerName: text(buyerNode), paid: status === profile.orders.paidText, refunded: /退款|售后/.test(status), cancelled: /关闭|取消/.test(status), status, paidAt: Number.isFinite(paidAt) ? paidAt : null };
    });
  };
  if (/\/login\b|passport\.|\/passport\b/.test(location.href)) return { ready: false, issue: '请先在官方页面手动登录' };
  if (action === 'probe' || action === 'read') {
    const response = { url: location.href, title: document.title, chat: null, orders: [], issues: [] };
    if (payload.kind === 'chat') { try { response.chat = chatSnapshot(); } catch (e) { response.issues.push(e.message); } }
    else { try { response.orders = orderSnapshot(); if (!response.orders.length) response.issues.push('当前页面未读取到订单，请打开有订单的列表再校验'); } catch (e) { response.issues.push(e.message); } }
    response.ready = response.issues.length === 0;
    return response;
  }
  if (action === 'route') {
    for (const row of all(profile.orders.row)) {
      const id = text(one(profile.orders.orderId, row)).replace(/^(订单号|订单编号)[：:\s]*/, '').trim();
      if (id !== payload.orderId || text(one(profile.orders.title, row)) !== normalize(payload.title)) continue;
      const buyer = identifier(one(profile.orders.buyer, row), profile.orders.buyerIdAttribute);
      if (buyer !== payload.buyerId) throw new Error('订单所属买家不一致');
      const contact = one(profile.orders.contact, row);
      const href = contact.getAttribute('href');
      if (!href || href.startsWith('javascript:')) throw new Error('当前页面尚未适配联系买家的跳转，请先手动打开对应买家会话');
      return { url: new URL(href, location.href).href, buyerId: buyer };
    }
    throw new Error('当前订单页找不到待发货订单，已停止发送');
  }
  if (action === 'send') {
    const before = currentBuyer();
    if (before.buyerId !== payload.buyerId) throw new Error('当前聊天对象与任务买家不同');
    const input = one(profile.chat.input); const button = one(profile.chat.send);
    const outgoing = all(profile.chat.outgoing);
    if (outgoing.some(node => !identifier(node, profile.chat.outgoingMessageIdAttribute))) throw new Error('缺少稳定的商家消息编号，未点击发送');
    const previousOutgoing = new Set(outgoing.map(node => identifier(node, profile.chat.outgoingMessageIdAttribute)));
    const previousText = input.isContentEditable ? input.textContent : input.value;
    if (normalize(previousText)) throw new Error('输入框中有尚未发送的手工内容，已保留并暂停此任务');
    if (input.isContentEditable) { input.focus(); input.textContent = payload.content; input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: payload.content })); }
    else { const descriptor = Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value'); descriptor.set.call(input, payload.content); input.dispatchEvent(new Event('input', { bubbles: true })); }
    await new Promise(resolve => setTimeout(resolve, 150));
    if (payload.runNonce !== undefined && globalThis.__localDeliveryRunNonce !== payload.runNonce) throw new Error('监听已暂停，未点击发送');
    if (currentBuyer().buyerId !== payload.buyerId) throw new Error('填入后聊天对象改变，未点击发送');
    const filled = input.isContentEditable ? input.textContent : input.value;
    if (normalize(filled) !== normalize(payload.content)) throw new Error('输入内容未成功写入，未点击发送');
    if (button.matches(':disabled,[aria-disabled="true"]')) throw new Error('发送按钮不可用');
    button.click();
    const deadline = Date.now() + 8000;
    let sawEcho = false;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 300));
      if (currentBuyer().buyerId !== payload.buyerId) return { status: 'uncertain', reason: '发送后聊天对象改变，需人工核实' };
      const matching = all(profile.chat.outgoing).find(node => {
        const id = identifier(node, profile.chat.outgoingMessageIdAttribute);
        const body = node.cloneNode(true);
        try { body.querySelectorAll(profile.chat.receipt).forEach(n => n.remove()); } catch {}
        return id && !previousOutgoing.has(id) && text(body) === normalize(payload.content);
      });
      if (matching) {
        sawEcho = true;
        if (/发送失败|重新发送|重发/.test(text(matching.parentElement))) return { status: 'uncertain', reason: '页面显示发送异常，需人工核实' };
        if (hasReceipt(matching)) return { status: 'confirmed', messageId: identifier(matching, profile.chat.outgoingMessageIdAttribute) };
        // A DOM echo alone proves neither server acceptance nor buyer delivery.
      }
    }
    return { status: 'uncertain', reason: sawEcho ? '已出现发送气泡，尚未取得平台确认回执，请核实后结案' : '未取得可核验的发送回执，请勿重复点击发送' };
  }
  if (action === 'pick') {
    return await new Promise(resolve => {
      const badge = document.createElement('div');
      badge.textContent = '网盘发货工作台：点击选择「' + payload.label + '」；Esc 取消。此次点击不会提交页面。';
      badge.style.cssText = 'position:fixed;z-index:2147483647;top:8px;left:8px;right:8px;background:#164e63;color:white;padding:12px;border-radius:8px;font:14px sans-serif;pointer-events:none';
      document.documentElement.appendChild(badge);
      let previous; let previousOutline;
      function clear() { document.removeEventListener('mouseover', hover, true); document.removeEventListener('click', pick, true); document.removeEventListener('keydown', key, true); badge.remove(); if (previous) previous.style.outline = previousOutline; clearTimeout(timer); }
      function hover(event) { if (previous) previous.style.outline = previousOutline; previous = event.target; previousOutline = previous.style.outline; previous.style.outline = '2px solid #0891b2'; }
      function key(event) { if (event.key === 'Escape') { clear(); resolve({ cancelled: true }); } }
      function pick(event) {
        event.preventDefault(); event.stopImmediatePropagation();
        const target = event.target;
        if (target.matches('input[type=password]')) { clear(); resolve({ error: '不能选择密码输入框' }); return; }
        const candidates = [];
        for (const attr of ['data-testid', 'data-test-id']) if (target.getAttribute(attr)) candidates.push('[' + attr + '="' + CSS.escape(target.getAttribute(attr)) + '"]');
        if (target.id && !/\d{8,}/.test(target.id)) candidates.push('#' + CSS.escape(target.id));
        const classes = [...target.classList].filter(c => !/^(active|selected|hover|focus)$/.test(c));
        if (classes.length) candidates.push(target.tagName.toLowerCase() + classes.slice(0, 3).map(c => '.' + CSS.escape(c)).join(''));
        const unique = candidates.find(selector => document.querySelectorAll(selector).length === 1);
        let selector = unique || candidates[0];
        if (!selector) { const parts = []; let node = target; while (node && node !== document.documentElement && parts.length < 7) { const siblings = [...node.parentElement.children].filter(n => n.tagName === node.tagName); parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')'); node = node.parentElement; } selector = parts.join(' > '); }
        const attrs = Object.fromEntries([...target.attributes].filter(a => /^(data-(uid|user-id|buyer-id|msg-id|message-id|conversation-id)|id)$/.test(a.name)).map(a => [a.name, a.value.slice(0, 150)]));
        const value = { selector, repeatedSelector: candidates.find(c => c.includes('.')) || selector, sample: text(target).slice(0, 120), attributes: attrs };
        clear(); resolve(value);
      }
      document.addEventListener('mouseover', hover, true); document.addEventListener('click', pick, true); document.addEventListener('keydown', key, true);
      const timer = setTimeout(() => { clear(); resolve({ cancelled: true }); }, 90000);
    });
  }
  throw new Error('未知页面操作');
}
function makeScript(action, profile, payload = {}) { return `(${pageRuntime.toString()})(${JSON.stringify(action)},${JSON.stringify(profile)},${JSON.stringify(payload)})`; }
module.exports = { allowedUrl, defaultProfile, validateProfile, makeScript, pageRuntime };
