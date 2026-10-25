'use strict';

// Read the official React page's loaded order rows. No requests or UI actions.
function ordersRuntime() {
  const id = value => {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return '';
    const result = ['number', 'string'].includes(typeof value) && String(value).length <= 160 ? String(value).trim() : '';
    return /^(Infinity|NaN|undefined|null)$/i.test(result) ? '' : result;
  };
  const text = (value, max = 2000) => typeof value === 'string' ? value.slice(0, max) : '';
  const code = value => ['number', 'string'].includes(typeof value) ? String(value).slice(0, 80) : '';
  const seconds = value => {
    const n = typeof value === 'number' || typeof value === 'string' && value !== '' ? Number(value) : NaN;
    return Number.isFinite(n) && n > 946684800 && n < 4102444800 ? Math.round(n * 1000) : null;
  };
  const lists = new Set(), visited = new Set();
  const wrapper = document.querySelector('#__mms_order_list_wrapper');
  const nodes = wrapper ? [wrapper, ...Array.from(wrapper.querySelectorAll('._list-table-wrapper, [data-testid="beast-core-table-middle-tbody"]')).slice(0, 59)] : [];
  for (const node of nodes) {
    const key = Object.keys(node).find(key => key.startsWith('__reactInternalInstance$') || key.startsWith('__reactFiber$'));
    let fiber = key && node[key];
    for (let depth = 0; fiber && depth < 100; depth += 1, fiber = fiber.return) {
      if (visited.has(fiber)) break;
      visited.add(fiber);
      const data = fiber.memoizedProps?.data;
      if (Array.isArray(data?.pageItems)) lists.add(data.pageItems);
      if (Array.isArray(fiber.memoizedProps?.dataSource)) lists.add(fiber.memoizedProps.dataSource);
      // The list owner is a hook component; inspect only this named state shape.
      let hook = fiber.memoizedState;
      for (let index = 0; hook && index < 50; index += 1, hook = hook.next) {
        if (Array.isArray(hook.memoizedState?.pageItems)) lists.add(hook.memoizedState.pageItems);
      }
    }
  }
  const orders = new Map();
  for (const list of lists) for (const row of list.slice(0, 500)) {
    const orderId = id(row?.order_sn);
    if (!orderId || typeof row.goods_name !== 'string') continue;
    const buyerId = id(row.uid);
    const state = { order: code(row.order_status), payment: code(row.pay_status), shipping: code(row.shipping_status), group: code(row.group_status), afterSales: code(row.after_sales_status) };
    const tuple = [state.order, state.payment, state.group, state.shipping].join('/');
    const statuses = { '1/2/1/0': '待发货', '1/2/1/1': '已发货，待签收', '1/3/1/0': '未发货，退款中', '1/4/1/0': '未发货，退款成功' };
    const status = statuses[tuple] || text(row.order_status_str, 160) || '订单状态待核验';
    const issues = [];
    if (!buyerId) issues.push('订单未提供稳定买家编号');
    if (tuple !== '1/2/1/0') issues.push('当前状态不在已核验的待发货组合内');
    if (state.afterSales && !['0', '-1', '6', '7', '13'].includes(state.afterSales)) issues.push('存在售后状态，需人工核对');
    // confirm_time is the transaction/group time, not a proved payment time.
    issues.push('本页尚无已核验的付款时间，不自动处理');
    const projection = { orderId, buyerId, title: text(row.goods_name), goodsId: id(row.goods_id), spec: text(row.spec, 500),
      status,
      state, orderAt: seconds(row.order_time), confirmedAt: seconds(row.confirm_time), paidAt: null, eligible: false, issues };
    const previous = orders.get(orderId);
    if (previous && (previous.buyerId !== buyerId || previous.title !== projection.title)) previous.issues.push('同一订单出现冲突数据');
    else if (!previous) orders.set(orderId, projection);
  }
  const pageText = text(document.body?.innerText, 200000);
  const ready = lists.size > 0 && pageText.includes('订单查询');
  return { source: 'pdd-official-react-orders', readOnly: true, ready, issue: ready ? '' : '尚未识别到官方订单查询列表',
    orders: [...orders.values()], arrayCount: lists.size, inspectedNodes: nodes.length,
    coverage: '仅订单查询页当前已加载的列表，不含其他分页；只读取，不发货、不发送消息。' };
}

function makeOrdersScript() { return `(${ordersRuntime.toString()})()`; }
module.exports = { makeOrdersScript };
