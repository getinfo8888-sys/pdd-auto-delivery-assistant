'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {WebContentsView}=require('electron');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function createView(kind){
  const view=new WebContentsView({webPreferences:{partition:'layout-fixture',nodeIntegration:false,contextIsolation:true,sandbox:true}});
  void view.webContents.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(`<meta charset="utf-8"><style>body{margin:0;font:16px sans-serif;background:#f0f8fa}header{padding:20px;background:#126f83;color:white}p{padding:15px;border-bottom:1px solid #ccd}</style><header>${kind==='chat'?'客服页面':'订单页面'} · 隔离布局测试</header>${Array.from({length:60},(_,i)=>'<p>页面内容 '+i+'</p>').join('')}`));
  return view;
}
async function run({app,window,views,engine,configureTestPlatform}){
  configureTestPlatform(require('./fixture-platform.cjs').createPlatform());
  const js=source=>window.webContents.executeJavaScript(source),checks=[],sizes=[];
  const until=async fn=>{const deadline=Date.now()+6000;while(Date.now()<deadline){if(await fn())return;await wait(60);}throw Error('Native layout timeout');};
  const attached=()=>window.contentView.children.filter(view=>[...views.values()].includes(view));
  const click=async selector=>{await js(`document.querySelector(${JSON.stringify(selector)}).click();void 0;`);await wait(100);};
  const assertFit=async kind=>{
    await until(()=>attached().length===1&&attached()[0]===views.get(kind)&&views.get(kind).getVisible());
    const expected=await js(`(()=>{const r=document.querySelector('#browser-stage').getBoundingClientRect();return {x:Math.ceil(r.left+1),y:Math.ceil(r.top+1),width:Math.floor(r.width-2),height:Math.floor(r.height-2),headerBottom:document.querySelector('.shop-toolbar').getBoundingClientRect().bottom,sideLeft:document.querySelector('.connection-panel').getBoundingClientRect().left,scroll:document.scrollingElement.scrollTop}})()`);
    const actual=views.get(kind).getBounds();
    assert.deepEqual(actual,{x:expected.x,y:expected.y,width:expected.width,height:expected.height});
    assert.ok(actual.y>=expected.headerBottom);assert.ok(actual.x+actual.width<=expected.sideLeft);assert.ok(actual.y+actual.height<=window.getContentSize()[1]);assert.equal(expected.scroll,0);
    return actual;
  };
  await wait(350);
  assert.equal(await js('document.title'),'拼多多自动发货助手');assert.equal(engine.snapshot().config.products.length,0);checks.push('fresh install uses the requested name and contains no merchant rules');
  await click('[data-nav="products"]');await click('[data-action="add-product"]');
  const inputs=await js(`Array.from(document.querySelectorAll('.modal input[name],.modal textarea[name]')).map(el=>({name:el.name,value:el.value,placeholder:el.placeholder}))`);
  for(const name of ['name','keywords','content']){const item=inputs.find(row=>row.name===name);assert.equal(item.value,'');assert.ok(item.placeholder.startsWith('输入'));assert.equal(item.placeholder.includes('示例商品'),false);}
  checks.push('new rule inputs describe the requested value and do not seed merchant examples');await click('[data-action="close-modal"]');
  await click('[data-nav="shop"]');await assertFit('chat');
  for(const [width,height]of [[1120,740],[1440,920],[1720,1050],[1200,800]]){
    window.setSize(width,height);await wait(200);const bounds=await assertFit('chat');sizes.push({width,height,bounds});
    await js('window.scrollTo(0,700);document.querySelector(".connection-panel").scrollTop=250;void 0;');await wait(150);assert.deepEqual(await assertFit('chat'),bounds);
    await views.get('chat').webContents.executeJavaScript('window.scrollTo(0,850);void 0;');await wait(100);assert.deepEqual(await assertFit('chat'),bounds);
  }
  checks.push('native customer-service bounds fit four window sizes without covering toolbar or connection panel','outer and connection-panel scroll do not move the embedded customer-service view','inner merchant-page scrolling leaves the host view in place');
  const chatId=views.get('chat').webContents.id;
  for(let i=0;i<5;i++){await js('refresh(true)');await wait(80);await assertFit('chat');}assert.equal(views.get('chat').webContents.id,chatId);checks.push('background state renders preserve one stable native view');
  await click('[data-action="browser-kind"][data-kind="orders"]');await assertFit('orders');
  await views.get('orders').webContents.executeJavaScript('window.scrollTo(0,600);void 0;');await wait(100);await assertFit('orders');checks.push('order tab uses the same contained layout and independent inner scroll');
  await js(`openModal('布局测试','隔离窗口','<textarea></textarea>','');void 0;`);await until(()=>attached().length===0);await js('closeModal();void 0;');await assertFit('orders');checks.push('opening a local dialog hides the native page and closing restores its correct bounds');
  await js(`api.call('browser:show',{kind:'orders',visible:true,bounds:{x:250,y:-50,width:800,height:500}})`);await until(()=>attached().length===0);checks.push('invalid native bounds detach the page instead of leaving a stale overlay');
  await js(`lastBrowserLayout='';updateBrowser()`);await assertFit('orders');
  await click('[data-nav="products"]');await until(()=>attached().length===0);checks.push('leaving the store page removes both native merchant views from the window');
  const typography=await require('./typography-smoke.cjs').run({window,engine});
  const result={ok:true,assertions:checks,windowSizes:sizes,typography,actualPlatformWrites:0,network:'data URL fixture only',merchantPagesConnected:false};
  fs.writeFileSync(path.resolve(__dirname,'../work/layout-smoke-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));app.quit();
}
module.exports={run,createView};
