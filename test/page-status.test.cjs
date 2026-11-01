'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {makePageStatusScript}=require('../src/platform/page-status.cjs');
function fixture(pathname='/goods/goods_edit'){
  const listeners={},draft={isConnected:true,value:'',getClientRects:()=>[{}]};
  const context=vm.createContext({location:{pathname},document:{readyState:'complete',querySelector:selector=>selector==='#replyTextarea'?draft:null,querySelectorAll:()=>[],addEventListener:(name,fn)=>{listeners[name]=fn;}},getComputedStyle:()=>({visibility:'visible',display:'block'})});
  return {context,draft,read:()=>vm.runInContext(makePageStatusScript(),context),edit:()=>listeners.input({target:{matches:()=>true}})};
}
test('merchant edits are protected until navigation or a user reload creates a fresh document',()=>{
  const f=fixture();assert.equal(f.read().hasDraft,false);f.edit();assert.equal(f.read().hasDraft,true);assert.equal(f.read().hasDraft,true);
  f.context.location.pathname='/orders/list';assert.equal(f.read().hasDraft,false);
  assert.equal(fixture().read().hasDraft,false);
});
test('order search inputs do not block recovery; customer-service drafts still do',()=>{
  const f=fixture('/orders/list');f.read();f.edit();assert.equal(f.read().hasDraft,false);
  const chat=fixture('/chat-merchant/index.html');chat.draft.value='未发送的人工回复';assert.equal(chat.read().hasDraft,true);
});
test('an edit immediately after SPA navigation is not mistaken for a clean new route',()=>{
  const f=fixture('/orders/list');f.read();f.context.location.pathname='/goods/goods_edit';f.edit();assert.equal(f.read().hasDraft,true);
});
