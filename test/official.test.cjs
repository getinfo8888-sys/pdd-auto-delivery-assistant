const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { makeOfficialScript, summarizeOfficial } = require('../src/platform/pdd-official.cjs');

function fixture({ chatList = [], order, text = '', identity = {} } = {}) {
  const userInfo = { mall_id: 'shop-1', uid: 'merchant-1', ...identity };
  Object.defineProperty(userInfo, 'access_token', { get() { throw new Error('must not read credentials'); } });
  const store = { state: { userInfo, chatList, currentUserInfo: chatList[0] } };
  const root = { $store: store, $children: order ? [{ $options: { name: 'OrderItem' }, $props: { order } }] : [] };
  const document = { querySelector: () => ({ __vue__: root }), querySelectorAll: () => [], body: { innerText: text } };
  return JSON.parse(JSON.stringify(vm.runInNewContext(makeOfficialScript(), { document })));
}
const buyer = (messages, extra = {}) => ({ userInfo: { uid: 'buyer-1', nickname: '测试买家' }, messageList: messages, ...extra });
const message = (msg_id, extra = {}) => ({ msg_id, content: '怎么发货', ts: 1792000000, type: 0,
  from: { uid: 'buyer-1', role: 'user' }, to: { uid: 'merchant-1', role: 'mall_cs' }, ...extra });
const order = extra => ({ orderSn: 'order-1', uid: 'buyer-1', listStatus: '待发货', payTime: 1792000000,
  orderGoodsList: { goodsId: 'goods-1', goodsName: '示例商品BT版', spec: '标准版' },
  afterSalesInfo: { afterSalesType: 0, afterSalesStatus: 0 }, ...extra });

test('official robot markers survive projection even when is_aut is zero',()=>{
  const outbound=(extra)=>message('merchant-'+JSON.stringify(extra),{from:{uid:'merchant-1',role:'mall_cs'},to:{uid:'buyer-1',role:'user'},...extra});
  const result=fixture({chatList:[buyer([outbound({show_auto:true,is_aut:0,need_reply:1}),outbound({from:{uid:'merchant-1',role:'mall_cs',csid:'自动回复'}}),outbound({show_auto:false,is_aut:0,manual_reply:1})])]});
  assert.deepEqual(result.conversations[0].messages.map(row=>row.officialAutoReply),[true,true,false]);
});

test('official read-only projection uses stable IDs without reading credentials', () => {
  const result = fixture({ chatList: [buyer([message('m-1'), message('m-1'), message(Infinity), message(9007199254740992)])] });
  assert.equal(result.ready, true);
  assert.equal(result.shopId, 'shop-1');
  assert.equal(result.conversations[0].messages.length, 1);
  assert.equal(result.conversations[0].messages[0].sentAt, 1792000000000);
  assert.equal(JSON.stringify(result).includes('access_token'), false);
});
test('platform, mediation, and malformed direction do not become buyer messages', () => {
  const result = fixture({ chatList: [buyer([
    message('platform', { from: { uid: 'buyer-1', role: 'platform' } }),
    message('service', { from: { uid: 'buyer-1', role: 'user', user_type: 6 } }),
    message('other', { from: { uid: 'other-buyer', role: 'user' } }),
    message('history', { is_history: true }),
    message('outgoing', { from: { uid: 'merchant-1', role: 'mall_cs' }, to: { uid: 'buyer-1', role: 'user' } })
  ]), buyer([message('mediation')], { chat_type: 'conciliation' })] });
  assert.deepEqual(result.conversations[0].messages.map(m => m.messageId), ['history', 'outgoing']);
  assert.equal(result.conversations[0].messages[0].history, true);
  assert.equal(result.conversations[0].messages[1].direction, 'outgoing');
});
test('order projection blocks unknown, unpaid, refund, mismatched buyer, and invalid time', () => {
  const eligible = fixture({ chatList: [buyer([])], order: order({}) }).orders[0];
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.paidAt, 1792000000000);
  for (const changes of [{ listStatus: '未发货' }, { payTime: null }, { payTime: 1792000000000 },
    { uid: 'other-buyer' }, { afterSalesInfo: null }, { afterSalesInfo: { afterSalesStatus: 3 } }]) {
    assert.equal(fixture({ chatList: [buyer([])], order: order(changes) }).orders[0].eligible, false);
  }
  assert.equal(fixture({ order: order({ orderGoodsList: [{ goodsName: 'unexpected multiple goods' }] }) }).orders.length, 0);
});
test('session conflict and incomplete identity keep read-only readiness false', () => {
  assert.equal(fixture({ text: '账户在别处登录' }).ready, false);
  assert.equal(fixture({ identity: { mall_id: '' } }).ready, false);
  assert.equal(vm.runInNewContext(makeOfficialScript(), { document: { querySelector: () => null, querySelectorAll: () => [] } }).ready, false);
});
test('platform notice flags stay distinct from merchant replies', () => {
  const outbound=extra=>message('notice-'+extra.type,{from:{uid:'merchant-1',role:'mall_cs'},to:{uid:'buyer-1',role:'user'},...extra});
  const result=fixture({chatList:[buyer([
    outbound({type:56,no_unreply_hint:1}),outbound({type:31,is_system_hint_mall:true}),
    outbound({type:0,manual_reply:1,no_unreply_hint:0,is_system_hint_mall:false}),
  ])]});
  const rows=result.conversations[0].messages;
  assert.deepEqual(rows.map(row=>[row.type,row.noUnreplyHint,row.systemHint]),[['56',true,false],['31',false,true],['0',false,false]]);
});
test('summary removes message bodies and merchant identifiers', () => {
  const summary = summarizeOfficial(fixture({ chatList: [buyer([message('m-1')])], order: order({}) }));
  assert.equal(summary.messageCount, 1);
  assert.equal(summary.incomingCount, 1);
  assert.equal(summary.orderCount, 1);
  assert.equal(summary.merchantUid, undefined);
  assert.equal(summary.conversations, undefined);
  assert.equal(JSON.stringify(summary).includes('怎么发货'), false);
});
test('order cards bind an exact order number to its user endpoint and detect conflicts', () => {
  const card = message('card-1', { sub_type: 1, info: { orderSequenceNo: 'ORDER-1', goodsName: '示例商品BT版' } });
  const result = fixture({ chatList: [buyer([card])] });
  assert.equal(result.orderReferences[0].orderId, 'ORDER-1');
  assert.equal(result.orderReferences[0].buyerId, 'buyer-1');
  const invalid = fixture({ chatList: [buyer([message('card-other', { from: { role: 'platform', uid: 'platform' }, to: { role: 'mall_cs', uid: 'merchant-1' }, info: card.info })])] });
  assert.equal(invalid.orderReferences.length, 0);
  const conflict = fixture({ chatList: [buyer([card, { ...card, msg_id: 'card-2', info: { ...card.info, goodsName: '另一个商品标题' } }])] });
  assert.equal(conflict.orderReferences[0].conflict, true);
});
