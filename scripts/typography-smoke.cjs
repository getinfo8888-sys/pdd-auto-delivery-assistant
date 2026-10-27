'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run({window,engine}) {
  const js=code=>window.webContents.executeJavaScript(code);
  const click=async selector=>{await js(`document.querySelector(${JSON.stringify(selector)}).click();void 0;`);await wait(120);};
  const out=path.resolve(__dirname,'../work/typography');fs.mkdirSync(out,{recursive:true});
  const results=[];
  const audit=async(label,selectors)=>{
    const rows=await js(`(()=>{
      const rgb=value=>(value.match(/[\\d.]+/g)||[]).map(Number);
      const over=(fg,bg)=>{const alpha=fg[3]??1;return fg.slice(0,3).map((x,i)=>x*alpha+bg[i]*(1-alpha));};
      const background=element=>{let result=[255,255,255];const chain=[];for(let node=element;node;node=node.parentElement)chain.unshift(node);for(const node of chain)result=over(rgb(getComputedStyle(node).backgroundColor),result);return result;};
      const luminance=channels=>channels.map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((total,x,i)=>total+x*[.2126,.7152,.0722][i],0);
      return ${JSON.stringify(selectors)}.map(selector=>{const element=document.querySelector(selector);if(!element)throw Error('Missing typography role: '+selector);const style=getComputedStyle(element),bg=background(element),fg=over(rgb(style.color),bg),a=luminance(fg),b=luminance(bg);return {selector,fontSize:parseFloat(style.fontSize),weight:Number(style.fontWeight),color:style.color,background:bg,contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};});
    })()`);
    for(const row of rows){assert.ok(row.contrast>=4.5,`${label} ${row.selector}: text contrast ${row.contrast}`);assert.ok([12,14,16,20,24,32].includes(row.fontSize),`${label}: unexpected type size ${row.fontSize}`);}
    results.push({label,roles:rows});return rows;
  };
  for(const [width,height]of [[1120,740],[1440,920],[1720,1050]]){
    window.setSize(width,height);await wait(100);await click('[data-nav="settings"]');
    const rows=await audit(`runtime-${width}`,['.page-heading h1','.nav-item:not(.active)','.section-tab[aria-selected="false"]','.section-tab[aria-selected="true"]','.panel-head h2','.toggle-row strong','.toggle-row p','.small-note','.field>span','.button']);
    assert.equal(rows[0].fontSize,24);assert.equal(rows[1].fontSize,16);assert.equal(rows[2].fontSize,16);assert.equal(rows[3].fontSize,16);assert.equal(rows[4].fontSize,14);assert.ok(rows[4].weight<rows[3].weight);assert.equal(rows[5].fontSize,14);assert.equal(rows[6].fontSize,12);
    assert.equal(await js(`document.querySelector('.panel-head h2').textContent`),'启动与托盘');
    const fit=await js(`(()=>{const bar=document.querySelector('.section-tabs').getBoundingClientRect();return {overflow:document.scrollingElement.scrollWidth>innerWidth,tabs:[...document.querySelectorAll('.section-tab')].every(el=>{const r=el.getBoundingClientRect();return r.left>=bar.left&&r.right<=bar.right+1;})};})()`);
    assert.equal(fit.overflow,false);assert.equal(fit.tabs,true);
    if(width===1440)fs.writeFileSync(path.join(out,'settings-runtime.png'),(await window.webContents.capturePage()).toPNG());
  }
  await click('[data-nav="products"]');
  await audit('delivery-list',['.search input','.section-tab[aria-selected="false"]','.button.primary']);
  const searchFit=await js(`(()=>{const input=document.querySelector('.search input'),icon=document.querySelector('.search svg');return input.getBoundingClientRect().left+parseFloat(getComputedStyle(input).paddingLeft)>=icon.getBoundingClientRect().right+6;})()`);assert.equal(searchFit,true,'search text clears the search icon');
  await click('[data-action="add-product"]');
  await audit('rule-editor',['.modal-head h2','.field>span','.field input','.field textarea','.modal-footer .button']);
  const placeholder=await js(`(()=>{const el=document.querySelector('.field input');return getComputedStyle(el,'::placeholder').color;})()`);assert.equal(placeholder,'rgb(95, 111, 130)');
  await click('[data-action="close-modal"]');await click('[data-section="delivery"]');
  await audit('delivery-settings',['.section-tab[aria-selected="false"]','.section-tab[aria-selected="true"]','.panel-head h2','.toggle-row strong','.toggle-row p','.content-preview','.badge','.field>span']);
  fs.writeFileSync(path.join(out,'delivery-settings.png'),(await window.webContents.capturePage()).toPNG());
  await click('[data-nav="replies"]');await click('[data-section="strategy"]');
  await audit('reply-strategy',['.section-tab[aria-selected="false"]','.panel-head h2','.toggle-row strong','.toggle-row p','.field>span','.field input']);
  fs.writeFileSync(path.join(out,'reply-strategy.png'),(await window.webContents.capturePage()).toPNG());
  await click('[data-nav="settings"]');await click('[data-section="alerts"]');
  await audit('alerts',['.section-tab[aria-selected="true"]','.panel-head h2','.toggle-row strong','.toggle-row p','.field>span','.field input','[data-action="phone-alert-save"]']);
  fs.writeFileSync(path.join(out,'alerts.png'),(await window.webContents.capturePage()).toPNG());
  await js(`document.querySelector('#content').insertAdjacentHTML('beforeend','<div id="type-status-fixture"><span class="badge green">样本正常状态</span><span class="badge orange">样本等待状态</span><span class="badge red">样本异常状态</span><span class="badge teal">样本预览状态</span><strong class="product-name">示例商品</strong></div>');void 0;`);
  await audit('status-labels',['#type-status-fixture .badge.green','#type-status-fixture .badge.orange','#type-status-fixture .badge.red','#type-status-fixture .badge.teal','#type-status-fixture .product-name']);
  await js(`document.getElementById('type-status-fixture').remove();void 0;`);
  assert.equal(engine.snapshot().config.running,false);
  const result={ok:true,samples:results,minimumTextContrast:Math.min(...results.flatMap(row=>row.roles.map(role=>role.contrast))),actualPlatformWrites:0};
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));
  return {ok:true,roleChecks:results.reduce((sum,row)=>sum+row.roles.length,0),minimumTextContrast:result.minimumTextContrast,actualPlatformWrites:0};
}
module.exports={run};
