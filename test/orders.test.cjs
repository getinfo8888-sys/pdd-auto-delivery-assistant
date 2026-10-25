const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { makeOrdersScript } = require('../src/platform/pdd-orders.cjs');

function inspect(rows, options = {}) {
  const data = { pageItems: rows, totalItemNum: rows.length };
  Object.defineProperty(data, 'token', { get() { throw new Error('credential access'); } });
  const owner = { memoizedProps: options.hook ? {} : { data }, memoizedState: options.hook ? { memoizedState: data, next: null } : null };
  const element = { '__reactInternalInstance$fixture': { memoizedProps: {}, return: owner }, querySelectorAll: () => [] };
  const document = { querySelector: () => options.noWrapper ? null : element, body: { innerText: '订单查询 共查询到订单' } };
  return JSON.parse(JSON.stringify(vm.runInNewContext(makeOrdersScript(), { document })));
}
const row = changes => ({ order_sn: 'ORDER-1', uid: 'BUYER-1', goods_id: 'GOODS-1', goods_name: '时光大爆炸BT版', spec: '标准版',
  order_status: 1, pay_status: 2, group_status: 1, shipping_status: 1, after_sales_status: 0, confirm_time: 1792000000, ...changes });

test('React order projection reads named props and hook state without unrelated fields', () => {
  for (const hook of [false, true]) {
    const result = inspect([row({})], { hook });
    assert.equal(result.ready, true);
    assert.equal(result.orders[0].buyerId, 'BUYER-1');
    assert.equal(result.orders[0].status, '已发货，待签收');
    assert.equal(result.orders[0].confirmedAt, 1792000000000);
    assert.equal(JSON.stringify(result).includes('token'), false);
  }
});
test('transaction time never masquerades as payment time and history cannot deliver', () => {
  for (const changes of [{}, { shipping_status: 0 }, { pay_status: 3, shipping_status: 0 }, { uid: undefined }, { after_sales_status: 2 }]) {
    const order = inspect([row(changes)]).orders[0];
    assert.equal(order.eligible, false);
    assert.equal(order.paidAt, null);
    assert.ok(order.issues.length);
  }
});
test('order list identity is unique and unknown pages fail closed', () => {
  assert.equal(inspect([row({}), row({})]).orders.length, 1);
  assert.equal(inspect([]).ready, true);
  assert.equal(inspect([], { noWrapper: true }).ready, false);
  assert.equal(inspect([row({ uid: 9007199254740992 })]).orders[0].buyerId, '');
});
