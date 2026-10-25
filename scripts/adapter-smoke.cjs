const assert = require('node:assert/strict');
const { BrowserWindow } = require('electron');
const { defaultProfile, makeScript } = require('../src/platform/page-adapter.cjs');
async function run() {
  const view = new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
  try {
    const profile=defaultProfile();
    Object.assign(profile.chat,{buyer:'.buyer',incoming:'.incoming',input:'textarea',send:'button',outgoing:'.outgoing',receipt:'.receipt'});
    Object.assign(profile.orders,{row:'.order',orderId:'.order-id',title:'.title',buyer:'.order-buyer',status:'.status',paidAt:'.payment'});
    const html=`<style>body{font:14px sans-serif}.receipt{display:inline-block;padding:2px}.incoming,.outgoing,.order{padding:10px}</style><div class="buyer" data-uid="buyer-1">测试买家</div><div class="incoming" data-msg-id="in-1">测试咨询</div><div id="messages"><div class="outgoing" data-msg-id="old-message-id">测试发货正文<span class="receipt">已发送</span></div></div><textarea></textarea><button>发送</button><div class="order"><span class="order-id">订单号：ORDER-1</span><span class="title">原标题</span><span class="order-buyer" data-uid="buyer-1">测试买家</span><span class="status">待发货</span><span class="payment">2026-10-15 02:00:00</span></div>`;
    const load=()=>view.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
    const evaluate=(action,payload={},p=profile)=>view.webContents.executeJavaScript(makeScript(action,p,payload));
    await load();
    const probe=await evaluate('probe',{kind:'chat'});assert.equal(probe.ready,true);
    const invalid=structuredClone(profile);invalid.chat.receipt='.nonexistent';assert.equal((await evaluate('probe',{kind:'chat'},invalid)).ready,false);
    const initial=await evaluate('read',{kind:'orders'});
    await view.webContents.executeJavaScript(`document.querySelector('.title').textContent='改过的标题'; void 0;`);
    const renamed=await evaluate('read',{kind:'orders'});assert.equal(initial.orders[0].itemId,renamed.orders[0].itemId);
    await view.webContents.executeJavaScript(`document.body.appendChild(document.querySelector('.order').cloneNode(true)); void 0;`);
    assert.equal((await evaluate('read',{kind:'orders'})).ready,false);
    await load();
    await view.webContents.executeJavaScript(`document.querySelector('button').onclick=()=>{document.querySelector('#messages').innerHTML='<div class="outgoing" data-msg-id="old-message-id">测试发货正文<span class="receipt">已发送</span></div>'}; void 0;`);
    const stale=await evaluate('send',{buyerId:'buyer-1',content:'测试发货正文'});assert.equal(stale.status,'uncertain');
    await load();
    await view.webContents.executeJavaScript(`document.querySelector('button').onclick=()=>{const node=document.createElement('div');node.className='outgoing';node.setAttribute('data-msg-id','new-message-id');node.textContent=document.querySelector('textarea').value;const receipt=document.createElement('span');receipt.className='receipt';receipt.textContent='已发送';node.appendChild(receipt);document.querySelector('#messages').appendChild(node);}; void 0;`);
    const fresh=await evaluate('send',{buyerId:'buyer-1',content:'本次新正文'});assert.deepEqual(fresh,{status:'confirmed',messageId:'new-message-id'});
    await load();
    await view.webContents.executeJavaScript(`globalThis.__localDeliveryRunNonce=1;globalThis.clicks=0;document.querySelector('button').onclick=()=>clicks++;document.querySelector('textarea').addEventListener('input',()=>setTimeout(()=>globalThis.__localDeliveryRunNonce=2,20)); void 0;`);
    await assert.rejects(()=>evaluate('send',{buyerId:'buyer-1',content:'暂停前的草稿',runNonce:1}),/暂停/);
    assert.equal(await view.webContents.executeJavaScript('globalThis.clicks'),0);
    return {ok:true,assertions:['current fields probed','missing receipt blocked','title change keeps order identity','ambiguous order rows blocked','historical DOM rerender cannot confirm send','new message ID and receipt confirmed in fixture','pause before send prevents click']};
  } finally { view.destroy(); }
}
module.exports={run};
