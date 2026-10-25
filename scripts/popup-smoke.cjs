'use strict';
const assert = require('node:assert/strict');
const { app, BrowserWindow, WebContentsView, session } = require('electron');
const { makePopupGuardScript, attachPopupGuard } = require('../src/platform/pdd-popups.cjs');
const { makePageStatusScript } = require('../src/platform/page-status.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
  const partition = session.fromPartition('popup-fixture-' + Date.now());
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{font:16px sans-serif;margin:0}button{padding:8px}.tip-content{position:fixed;top:180px;left:30px;padding:12px;background:#eee}
    #driver-page-overlay{position:fixed;inset:0;background:#0008;z-index:10}
    #driver-popover-item{position:fixed;top:60px;left:180px;width:330px;padding:18px;background:#7671ec;color:white;z-index:11}
    .driver-popover-footer{margin-top:20px}.driver-close-btn{display:inline-block}
    .notice-mask{position:fixed;inset:0;background:#0008;z-index:30}.modal-box{position:absolute;left:150px;top:120px;width:550px;background:white;padding:20px;box-sizing:border-box}.modal-header{font-size:20px}.btn-box span{display:block;padding:12px;cursor:pointer}
    </style><button id="refund">同意退款</button><div role="dialog"><p>账户安全验证</p><button id="security">我知道了</button><input placeholder="验证码"></div>
    <div class="negative_forbidden_to_send_msg"><button id="forbidden" class="negative_forbidden_to_send_msg_btn">我知道了</button></div>
    <button id="agreement">同意并继续</button><button id="payment">确认付款</button><div id="messages"></div>
    <script>
    window.fixture={businessClicks:0,closes:0,next:0,tips:0,notices:0,notificationAttempts:0};
    for(const id of ['refund','security','forbidden','agreement','payment'])document.getElementById(id).onclick=()=>fixture.businessClicks++;
    window.addTour=(title='工作台支持发送安装师傅联系方式了！',extra='')=>{
      const overlay=document.createElement('div');overlay.id='driver-page-overlay';document.body.append(overlay);
      const node=document.createElement('div');node.id='driver-popover-item';
      node.innerHTML='<div class="driver-popover-title">'+title+'</div><div class="driver-popover-description">介绍功能'+extra+'</div><div class="driver-popover-footer"><button class="driver-close-btn">我知道了</button><button class="driver-next-btn">下一步</button></div>';
      document.body.append(node);
    };
    window.addTip=()=>{
      const wrap=document.createElement('span');wrap.className='icon-pc-container';
      wrap.innerHTML='<i class="icon-pc">开启Win工作台</i><p class="tip-content">开启Win工作台<i class="icon-close">×</i></p>';
      // The real tip uses an empty icon; its visible text remains the exact title.
      wrap.querySelector('.icon-close').textContent='';wrap.querySelector('.icon-close').style='display:inline-block;width:18px;height:18px;background:#999';
      wrap.querySelector('.icon-close').onclick=()=>{fixture.tips++;wrap.querySelector('.tip-content').remove();};
      wrap.querySelector('.icon-pc').onclick=()=>fixture.businessClicks++;
      document.body.append(wrap);
    };
    window.addNotice=(title='浏览器未开启通知',label='今天不再提示',extra='')=>{
      const mask=document.createElement('div');mask.className='modal notice-mask';
      mask.innerHTML='<div class="modal-box"><div class="modal-header">'+title+'</div><div class="modal-body"><div class="content-box"><div class="content"><p>开启消息通知后，可以收到新消息通知和回复超时预警</p><div class="btn-box"><span class="open">去开启</span><span class="cancel">'+label+'</span></div>'+extra+'</div></div></div></div>';
      mask.querySelector('.open').onclick=()=>fixture.businessClicks++;
      mask.querySelector('.cancel').onclick=()=>{fixture.notificationAttempts++;if(window.keepNotice)return;fixture.notices++;localStorage.setItem('fixture-notification-day','dismissed-today');mask.remove();};
      document.body.append(mask);
    };
    window.addEventListener('click',event=>{
      if(event.target.classList.contains('driver-close-btn')){
        fixture.closes++;
        if(!window.keepTour)setTimeout(()=>{document.getElementById('driver-popover-item')?.remove();document.getElementById('driver-page-overlay')?.remove();},150);
      }else if(event.target.classList.contains('driver-next-btn'))fixture.next++;
    });
    </script>`;
  const requests = [];
  await partition.protocol.handle('https', request => { requests.push(new URL(request.url).pathname); return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }); });
  const view = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { session: partition, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const wc = view.webContents, assertions = [];
  const js = source => wc.executeJavaScript(source);
  const check = async (label, fn) => { await fn(); assertions.push(label); };
  const until = async condition => { const end = Date.now() + 6000; while (Date.now() < end) { if (await condition()) return; await wait(100); } throw new Error('Popup fixture timeout'); };
  const load = async (url = 'https://mms.pinduoduo.com/chat-merchant/index.html') => { await view.loadURL(url); };
  try {
    await load();
    await check('page security status is separate from whether a popup can be dismissed', async () => {
      const status=await js(makePageStatusScript());assert.equal(status.verification,true);assert.equal(status.login,false);
      assert.equal(await js('fixture.businessClicks'),0);
    });
    await check('buyer text mentioning verification does not mark an otherwise normal page as a challenge', async () => {
      await js('document.querySelector("[role=dialog]").hidden=true;document.getElementById("messages").textContent="请向右滑块完成拼图";void 0;');
      assert.equal((await js(makePageStatusScript())).verification,false);
    });
    await check('existing feature guide closes through its own handler and removes its mask', async () => {
      await js('addTour();void 0;'); await js(makePopupGuardScript());
      await until(async () => (await js(makePopupGuardScript('status'))).counts.dismissed === 1);
      assert.equal(await js('!!document.getElementById("driver-page-overlay")'), false);
    });
    await check('delayed guides are discovered by DOM observation without reinstalling', async () => {
      await js('setTimeout(()=>addTour("新版本功能介绍"),300);void 0;');
      await until(async () => (await js(makePopupGuardScript('status'))).counts.dismissed === 2);
    });
    await check('desktop tooltip clicks only its close icon and does not launch desktop software', async () => {
      await js('addTip();void 0;'); await until(async () => (await js('fixture.tips')) === 1);
      assert.equal(await js('fixture.businessClicks'), 0);
    });
    await check('reinstall is idempotent and event draining does not repeat records', async () => {
      await js('window.previousGuard=window.__localWorkbenchPopupGuard;void 0;'); await js(makePopupGuardScript());
      assert.equal(await js('previousGuard===window.__localWorkbenchPopupGuard'), true);
      assert.ok((await js(makePopupGuardScript('drain'))).events.length >= 2);
      assert.equal((await js(makePopupGuardScript('drain'))).events.length, 0);
    });
    await check('security, payment, refund, agreement and prohibited-send acknowledgements remain untouched', async () => {
      await js('document.getElementById("messages").textContent="我知道了，确认付款";void 0;'); await wait(400);
      assert.equal(await js('fixture.businessClicks'), 0); assert.equal(await js('fixture.next'), 0);
    });
    await check('sensitive guide text is preserved for the user', async () => {
      await js('addTour("请完成安全验证");void 0;');
      await until(async () => (await js(makePopupGuardScript('status'))).counts.blocked === 1);
      assert.equal(await js('fixture.closes'), 2);
    });
    await load();
    await check('guide containing editable fields is not dismissed', async () => {
      await js('addTour("功能提示","<input placeholder=验证码>");void 0;'); await js(makePopupGuardScript()); await wait(500);
      assert.equal(await js('fixture.closes'), 0);
    });
    await load();
    await check('next-step control is never used if a guide has no explicit close', async () => {
      await js('addTour();document.querySelector(".driver-close-btn").remove();void 0;'); await js(makePopupGuardScript()); await wait(400);
      assert.equal(await js('fixture.next'), 0); assert.equal((await js(makePopupGuardScript('status'))).events[0].outcome, 'missing_close');
    });
    await load();
    await check('hidden and disabled close controls wait until enabled', async () => {
      await js('addTour();document.querySelector(".driver-close-btn").hidden=true;void 0;'); await js(makePopupGuardScript()); await wait(400);
      assert.equal(await js('fixture.closes'), 0);
      await js('document.querySelector(".driver-close-btn").hidden=false;document.querySelector(".driver-close-btn").disabled=true;void 0;'); await wait(400);
      assert.equal(await js('fixture.closes'), 0);
      await js('document.querySelector(".driver-close-btn").disabled=false;void 0;');
      await until(async () => (await js('fixture.closes')) === 1);
    });
    await load();
    await check('notification prompt uses Today dismiss, removes its overlay and persists the official choice', async () => {
      await js('addNotice();void 0;');await js(makePopupGuardScript());
      await until(async () => (await js(makePopupGuardScript('status'))).counts.dismissed === 1);
      assert.equal(await js('fixture.notices'),1);assert.equal(await js('fixture.businessClicks'),0);
      assert.equal(await js('!!document.querySelector(".notice-mask")'),false);
      assert.equal(await js('localStorage.getItem("fixture-notification-day")'),'dismissed-today');
      assert.equal((await js(makePopupGuardScript('status'))).recent.at(-1).type,'notification_tip');
    });
    await check('late and recurring notification prompts are dismissed without reload or reinstall', async () => {
      await js('setTimeout(()=>addNotice(),200);void 0;');await until(async () => (await js('fixture.notices')) === 2);
      await js('addNotice();void 0;');await until(async () => (await js('fixture.notices')) === 3);
      assert.equal(await js('fixture.businessClicks'),0);
    });
    await check('a known optional feature modal closes through its own acknowledgement', async () => {
      await js('addNotice("新功能介绍","我知道了");document.querySelector(".notice-mask .cancel").className="btn-ok";void 0;');
      await until(async () => (await js('fixture.notices')) === 4);
    });
    await check('buyer text resembling a notification prompt is never clicked', async () => {
      await js('document.getElementById("messages").innerHTML="<div class=content-box>浏览器未开启通知<span class=cancel>今天不再提示</span></div>";document.querySelector("#messages .cancel").onclick=()=>fixture.businessClicks++;void 0;');
      await wait(400);assert.equal(await js('fixture.businessClicks'),0);
    });
    await check('notification permission action is never used when the dismiss choice is missing', async () => {
      await js('addNotice();document.querySelector(".notice-mask .cancel").remove();void 0;');await wait(500);
      assert.equal(await js('fixture.businessClicks'),0);assert.equal(await js('!!document.querySelector(".notice-mask")'),true);
      await js('document.querySelector(".notice-mask").remove();void 0;');
    });
    await check('business confirmations and editable fields inside a guide remain untouched', async () => {
      for(const extra of ['<input placeholder="设置">','确认退款','安全验证']) {
        await js(`addNotice('新功能介绍','我知道了',${JSON.stringify(extra)});void 0;`);await wait(350);
        assert.equal(await js('fixture.notices'),4);await js('document.querySelector(".notice-mask").remove();void 0;');
      }
    });
    await check('an unchanged close control can recover after three unsuccessful attempts', async () => {
      await js('window.realNow=Date.now;window.fakeNow=realNow();Date.now=()=>fakeNow;window.keepNotice=true;addNotice();void 0;');
      await until(async () => (await js('fixture.notificationAttempts')) === 5);
      for(let attempt=6;attempt<=7;attempt++) {
        await wait(800);await js('fakeNow+=31000;document.querySelector(".notice-mask").setAttribute("style","--attempt:"+fakeNow);void 0;');
        await until(async () => (await js('fixture.notificationAttempts')) === attempt);
      }
      await wait(800);await js('window.keepNotice=false;fakeNow+=31000;document.querySelector(".notice-mask").setAttribute("style","--attempt:"+fakeNow);void 0;');
      await until(async () => (await js('fixture.notices')) === 5);
      await js('Date.now=realNow;void 0;');
    });
    for (const url of ['https://mms.pinduoduo.com/orders/list', 'https://mms.pinduoduo.com/login/', 'https://example.test/chat-merchant/index.html']) {
      await check('does not operate outside customer service: ' + new URL(url).host + new URL(url).pathname, async () => {
        await load(url); await js('addTour();void 0;');
        assert.equal((await js(makePopupGuardScript())).active, false); await wait(250);
        assert.equal(await js('fixture.closes'), 0);
      });
    }
    await check('background customer-service view closes a guide before its tab is first shown', async () => {
      const background = new WebContentsView({ webPreferences: { session: partition, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
      background.setBounds({ x: 0, y: 0, width: 1200, height: 800 });
      try {
        await background.webContents.loadURL('https://mms.pinduoduo.com/chat-merchant/index.html');
        await background.webContents.executeJavaScript('addTour();void 0;');
        await background.webContents.executeJavaScript(makePopupGuardScript());
        await until(async () => (await background.webContents.executeJavaScript(makePopupGuardScript('status'))).counts.dismissed === 1);
      } finally { background.webContents.close(); }
    });
    await check('host reinstalls the guard after reload and disposes its timer on destruction', async () => {
      const reports = [];
      const stop = attachPopupGuard(wc, value => reports.push(value));
      await load(); await js('addTour();void 0;');
      await until(async () => (await js('fixture.closes')) === 1);
      await js('addNotice();void 0;');await until(async () => (await js('fixture.notices')) === 1);
      assert.equal(await js('fixture.businessClicks'),0);
      await load(); await js('setTimeout(()=>addTour(),250);void 0;');
      await until(async () => (await js('fixture.closes')) === 1);
      await wait(800); assert.equal((await js(makePopupGuardScript('status'))).counts.dismissed, 1);
      stop(); view.destroy(); stop();
    });
    return { ok: true, assertions, actualPlatformWrites: 0, network: 'all HTTPS requests served by isolated in-memory fixture', fixtureLoads: requests.length };
  } finally { if (!view.isDestroyed()) view.destroy(); partition.protocol.unhandle('https'); }
}

if (require.main === module || /(?:^|[\\/])popup-smoke\.cjs$/.test(process.argv[1] || '')) {
  app.disableHardwareAcceleration();
  app.whenReady().then(run).then(result => { console.log(JSON.stringify(result)); app.quit(); }).catch(error => { console.error(error); app.exit(1); });
}
module.exports = { run };
