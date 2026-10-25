'use strict';
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// Developer-only: exercise our UI with the existing browser session and a
// separate configuration file. main.cjs prevents ingestion and every write.
async function run({app,window,engine,bridge,ensureView,shadowFile}) {
  const directory=path.resolve(__dirname,'..','work');
  const actualFile=path.join(app.getPath('appData'),'LinkDeliveryWorkbench','state.json');
  const hash=()=>createHash('sha256').update(fs.readFileSync(actualFile)).digest('hex');
  const beforeHash=hash();
  const report={ok:false,readOnly:true,actualPlatformWrites:0,originalStateHash:beforeHash,shadowStateUsed:path.resolve(shadowFile)!==path.resolve(actualFile),checks:[]};
  const evalUi=code=>window.webContents.executeJavaScript(code);
  const click=async selector=>{await evalUi(`document.querySelector(${JSON.stringify(selector)}).click();void 0;`);await wait(250);};
  const until=async(check,label,timeout=6000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await check())return;await wait(150);}throw Error('等待超时：'+label);};
  const readSnapshot=()=>evalUi(`window.workbench.call('snapshot')`);
  try {
    assert.equal(report.shadowStateUsed,true);
    await until(()=>evalUi(`!!document.querySelector('[data-nav="settings"]')`),'工作台界面');
    assert.equal((await readSnapshot()).readOnly,true);
    await assert.rejects(bridge('chat','send',{allowWrite:true}),/只读联调/);
    report.checks.push('business write guard verified');
    await click('[data-nav="settings"]');
    await evalUi(`for(const key of ['autoReplyEnabled','autoDeliveryEnabled','autoConfirmShipmentEnabled','autoRefundEnabled']){const input=document.getElementById(key);if(!input.checked)input.click();}void 0;`);
    await click('[data-nav="products"]');await click('[data-nav="settings"]');
    for(const key of ['autoReplyEnabled','autoDeliveryEnabled','autoConfirmShipmentEnabled','autoRefundEnabled']) {
      assert.equal(await evalUi(`document.getElementById(${JSON.stringify(key)}).checked`),true);
      assert.equal(engine.snapshot().config[key],true);
    }
    report.checks.push('switches auto-saved without Save across navigation');
    const baselineJobs=engine.snapshot().jobs.length;
    const baselineStats=engine.snapshot().stats;
    await click('[data-action="running"]');
    await until(async()=>{
      if(engine.snapshot().config.running)return true;
      const error=await evalUi(`document.querySelector('#toast.error')?.textContent || ''`);
      if(error)throw Error(error);
      return false;
    },'真实官方连接及开始监听',80000);
    report.checks.push('Start completed with the existing official session');
    await until(async()=>{
      const state=await readSnapshot();
      return state.connection.diagnostics.chat.message.includes('只读联调运行中');
    },'官方消息、订单及售后只读轮询',12000);
    const state=await readSnapshot();
    report.connection=Object.fromEntries(['chat','orders','refunds'].map(kind=>[kind,{ready:state.connection.bridge[kind].ready===true,total:state.connection.bridge[kind].total ?? null}]));
    for(const status of Object.values(report.connection))assert.equal(status.ready,true);
    assert.equal(engine.snapshot().jobs.length,baselineJobs);
    assert.deepEqual(engine.snapshot().stats,baselineStats);
    report.checks.push('official chat, waiting orders and aftersales reads succeeded');
    report.checks.push('read-only polling created no jobs or operations');
    await click('[data-action="running"]');
    assert.equal(engine.snapshot().config.running,false);
    report.checks.push('Pause completed and switches remained enabled in the shadow state');
    assert.equal(hash(),beforeHash);
    report.checks.push('original rules and switches unchanged byte for byte');
    report.ok=true;
  } catch(error) {
    report.error=error.message;
    try {
      const state=await readSnapshot();
      report.connection=Object.fromEntries(['chat','orders','refunds'].map(kind=>[kind,{ready:state.connection.bridge[kind].ready===true,total:state.connection.bridge[kind].total ?? null,reason:state.connection.bridge[kind].reason}]));
      report.diagnostic=state.connection.diagnostics.chat.message;
      report.pagePaths=Object.fromEntries(Object.entries(state.connection.urls).map(([kind,url])=>[kind,new URL(url).pathname]));
      report.pageSignals={};
      for(const kind of Object.keys(state.connection.urls))report.pageSignals[kind]=await ensureView(kind).webContents.executeJavaScript(`(()=>{const text=document.body?.innerText || '';return {title:document.title,readyState:document.readyState,textLength:text.length,signals:['验证码','安全验证','滑块','网络异常','请求过于频繁','账号在别处登录','账户在别处登录','重新登录','暂无订单','暂无数据'].filter(word=>text.includes(word))};})()`);
    }catch{}
  } finally {
    if(engine.snapshot().config.running)await evalUi(`window.workbench.call('running:set',false)`);
    report.originalStateUnchanged=hash()===beforeHash;
    fs.writeFileSync(path.join(directory,'workflow-readonly-result.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
    app.exit(report.ok?0:1);
  }
}
module.exports={run};
