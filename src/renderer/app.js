'use strict';
const api = window.workbench;
let state, page = 'shop', browserKind = 'chat', filter = '', modal = null, deferred = false, busy = false, starting = false;
let imageDraft=[];
let sharedPreview=null, sharedPage=0;
const imagePreviews=new Map();
function imageSource(image) {
  if (!imagePreviews.has(image.id)) {
    imagePreviews.set(image.id,null);
    api.call('media:preview',{id:image.id,mime:image.mime}).then(result=>{
      if (result.preview?.startsWith('data:image/')) {imagePreviews.set(image.id,result.preview);for(const element of document.querySelectorAll('img[data-media-id]'))if(element.dataset.mediaId===image.id)element.src=result.preview;}
    }).catch(()=>{});
  }
  return imagePreviews.get(image.id) || image.url;
}
const settingBooleanKeys=['autoReplyEnabled','autoDeliveryEnabled','autoConfirmShipmentEnabled','autoRefundEnabled','greetingEnabled','manualInterventionEnabled','replySuffixEnabled','autoListenOnLaunch','separateLinksEnabled','startup'];
const settingNumberKeys=['cooldownSeconds','maxPerMinute','firstReplyIntervalMinutes','firstReplyDelaySeconds','replyDelaySeconds'];
const settingKeys=new Set([...settingBooleanKeys,...settingNumberKeys,'suffix','replySuffixMode']);
let settingsDraft={},settingsSaveTail=Promise.resolve(),settingsPending=0,settingsSaveError=null,settingsTimer,navigationRevision=0;
let phoneAlertDraft=null;
let cloudWatchdogDraft=null;
const defaultSections={products:'list',replies:'content',settings:'runtime'};
const sections={...defaultSections};
let lastAutoPromptKey='';
const icons = { dashboard:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z', shop:'M3 10v11h18V10 M2 4h20l-2 6H4z M9 21v-7h6v7', box:'M3 7l9-5 9 5-9 5z M3 7v11l9 5 9-5V7 M12 12v11', chat:'M21 11a8 8 0 01-8 8H6l-4 3V8a7 7 0 017-7h5a7 7 0 017 7z M7 8h9 M7 12h6', queue:'M5 4h14v17H5z M9 2h6v4H9z M8 11h8 M8 15h5', log:'M5 3h12l3 3v15H5z M9 8h6 M9 12h7 M9 16h5', settings:'M12 8a4 4 0 100 8 4 4 0 000-8 M9 2h6l1 4 4 1 2 5-3 3 1 4-5 3-3-3-4 1-3-5 3-3-1-4z', plus:'M12 5v14 M5 12h14', search:'M10 3a7 7 0 110 14 7 7 0 010-14 M15 15l6 6', arrow:'M5 12h14 M14 7l5 5-5 5', link:'M9 15l6-6 M7 13l-2 2a4 4 0 006 6l4-4 M17 11l2-2a4 4 0 00-6-6L9 7', check:'M4 12l5 5L20 6', clock:'M12 2a10 10 0 100 20 10 10 0 000-20 M12 6v6l4 2', play:'M8 4l12 8-12 8z', pause:'M8 4v16 M16 4v16', export:'M12 3v12 M7 8l5-5 5 5 M4 14v7h16v-7', refresh:'M20 7a9 9 0 10.5 9 M20 2v6h-6' };
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${icons[name] || icons.box}"/></svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = value => new Date(value).toLocaleString('zh-CN', { hour12:false, month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit' });
const jobTypes = {reply:'自动答复',delivery:'发送发货内容',shipment:'平台确认发货',refund:'同意退款'};
const matchTargets = {either:'商品名或 SKU',title:'商品名称',sku:'SKU / 规格'};
const matchTypes = {contains:'包含关键词',exact:'完全相等',wildcard:'通配符',expression:'包含表达式',system:'系统消息'};
const statusText = { queued:'等待执行',sending:'执行中',sent:'平台已确认',uncertain:'待核实',blocked:'待处理',cancelled:'已结案',simulated:'本地预览' };
const reasonText = { conversation_changed:'会话已有回复或出现新消息，已取消旧补答',unpaid:'未付款，不发送',not_paid:'未付款，不发送',refunded:'订单已退款',cancelled:'订单已取消',product_unmatched:'没有匹配到商品',unmatched:'没有匹配到商品',ambiguous:'命中多个不同商品，请调整规则',product_ambiguous:'命中多个不同商品，请调整规则',paused:'监听已暂停',auto_delivery_disabled:'自动发货未开启',auto_reply_disabled:'自动回复未开启',rate_limited:'达到每分钟发送上限',greeting:'首次欢迎语',keyword:'关键词回复',fallback:'默认回复',matched:'规则匹配成功' };
Object.assign(reasonText,{delivery_disabled:'自动发货未开启',reply_disabled:'自动回复未开启',no_match:'商品标题未匹配发货内容',ambiguous_match:'标题命中多个独立商品，请人工核对',ambiguous_reply:'消息命中多个独立回复规则',no_content:'没有可发送的回复正文',cooldown:'该买家仍在回复间隔内',duplicate:'已处理过相同事件',rate_limit:'达到每分钟发送上限',send_error:'发送调用异常，结果不明，请人工核实',invalid_confirmation:'未取得明确发送确认，请人工核实',startup_recovery:'上次退出时正在发送，请核实结果',rules_changed:'规则已修改，旧内容已取消',rematched:'已按新规则重新匹配',connection_wait:'尚未提交操作，等待官方连接恢复',manual_confirmed:'已人工核实成功',platform_reconciled:'已查询平台确认成功',refund_pending:'已收到退款申请，停止后续发货',refund_disabled:'自动退款未开启',refund_closed:'退款申请已结束或当前无需同意',shipment_disabled:'自动确认发货未开启',reply_delay:'等待设定的答复延迟',manual_intervention:'人工客服已回复，取消等待中的自动答复',adapter_unavailable:'平台操作尚未完成接入校验',operation_rejected:'平台未接受操作，请查看详情',manual_cancelled:'已人工结案，不再发送',persistence_after_send:'发送后结果未能保存，请人工核实'});
const reason = value => reasonText[value] || String(value || '');
reasonText.reply_retry_wait='平台判为重复，正在安排补答';
reasonText.cooldown='等待上一条相同原文成功发送后的冷却间隔';
reasonText.delivery_retry_wait='发货未完成，已安排自动重试';
reasonText.order_changed='订单状态或发货内容已变化，停止旧任务';
reasonText.attachment_retry_wait='链接或图片未完成，已安排自动重试';
const label = job => `<span class="badge ${job.status==='sent'?'green':job.status==='uncertain'||job.status==='queued'&&(job.replyRetryCount||job.deliveryRetryCount)?'orange':job.status==='blocked'?'red':job.simulation?'teal':''}">${job.status==='queued'&&job.replyRetryCount?'等待补答':job.status==='queued'&&job.deliveryRetryCount?'等待重试':statusText[job.status] || esc(job.status)}</span>`;
const keywordList = values => (values || []).map(value=>`<span class="keyword">${esc(value)}</span>`).join('');
const splitKeywords = text => [...new Set(text.split(/[\n,，、;；]/).map(s=>s.trim()).filter(Boolean))];
const cloneConfig = () => JSON.parse(JSON.stringify(state.config));
const jobs = () => [...state.jobs].sort((a,b)=>b.createdAt-a.createdAt);
const navItems = [['dashboard','dashboard','工作台'],['shop','shop','店铺工作台'],['products','box','发货内容'],['replies','chat','智能答复'],['refunds','refresh','自动退款'],['queue','queue','待处理'],['records','log','运行记录'],['settings','settings','助手设置']];

function toast(message, error = false) {
  const element = document.querySelector('#toast'); element.textContent = message; element.className = 'visible' + (error ? ' error' : '');
  clearTimeout(toast.timer); toast.timer = setTimeout(()=>element.className='',5000);
}
async function call(name, value) {
  try { return await api.call(name, value); } catch (error) { const message=error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/,''); toast(message, true); throw new Error(message); }
}
async function refresh(force = false) {
  const next=await call('snapshot');
  if (!state || (next.revision ?? 0)>=(state.revision ?? 0)) state=next;
  const auto = state.autoStart;
  if (!auto?.pending) lastAutoPromptKey='';
  const promptKey=auto?.phase+':'+auto?.kind;
  if (!modal && ['login','verification'].includes(auto?.phase) && auto.pending && promptKey!==lastAutoPromptKey) {
    lastAutoPromptKey=promptKey;
    page='shop'; browserKind=auto.kind || 'chat';
  }
  if (!force && (modal || ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))) { deferred = true; updateHeader(); return; }
  deferred = false; render();
}
function updateSettingsStatus() {
  const element=document.querySelector('#settings-save-state');if(!element)return;
  element.textContent=settingsSaveError?'保存失败，请重试':settingsPending?'正在自动保存…':Object.keys(settingsDraft).length?'等待保存':'更改已自动保存';
  element.className='small-note'+(settingsSaveError?' inline-error':'');
}
function rememberSetting(element) {
  if (!element || !settingKeys.has(element.id)) return;
  const value=settingBooleanKeys.includes(element.id)?element.checked:settingNumberKeys.includes(element.id)?(element.value.trim()===''?NaN:Number(element.value)):element.value;
  const saved=element.id==='startup'?state.startup:state.config[element.id];
  if (Object.hasOwn(settingsDraft,element.id) || value!==saved) settingsDraft[element.id]=value;
  updateSettingsStatus();
}
async function flushSettings() {
  clearTimeout(settingsTimer);
  for(const key of settingKeys) rememberSetting(document.getElementById(key));
  if (!Object.keys(settingsDraft).length) {await settingsSaveTail;return;}
  for(const key of Object.keys(settingsDraft)) {
    const element=document.getElementById(key);
    if (element && !element.checkValidity() || settingNumberKeys.includes(key) && !Number.isFinite(settingsDraft[key])) {
      element?.reportValidity();throw new Error('请填写有效的设置数值');
    }
  }
  const patch={...settingsDraft};settingsPending++;settingsSaveError=null;updateSettingsStatus();
  const save=settingsSaveTail.catch(()=>{}).then(async()=>{
    const next=await call('settings:update',patch);
    if (!state || (next.revision ?? 0)>=(state.revision ?? 0)) state=next;
    for(const [key,value] of Object.entries(patch)) if (Object.is(settingsDraft[key],value)) delete settingsDraft[key];
    settingsSaveError=null;
  });
  settingsSaveTail=save;
  try {await save;} catch(error) {settingsSaveError=error;throw error;}
  finally {settingsPending--;updateSettingsStatus();updateHeader();}
}
function updateHeader() {
  const running = state.config.running;
  const autoPending=state.autoStart?.pending;
  const autoLabels={connecting:'正在自动连接…',reconnecting:'正在恢复页面与发送连接…',offline:'网络已断开，恢复后自动继续',login:'等待扫码登录，完成后自动继续',verification:'等待本人完成验证，之后自动继续',retrying:'连接暂不可用，正在等待自动恢复'};
  const scan=state.catchUp;
  const catchUpLabel=scan?.phase==='scanning'?` · 正在检查待回复（${scan.scanned} 条）`:scan?.phase==='complete'?` · 已检查，安排补答 ${scan.created} 条`:scan?.phase==='retrying'?' · 待回复检查重试中':'';
  const partial=[];
    if(state.config.autoDeliveryEnabled && state.connection.bridge?.orders.ready===false)partial.push('发货等待恢复');
    if(state.config.autoRefundEnabled && state.connection.bridge?.refunds.ready===false)partial.push('退款等待恢复');
    const partialLabel=partial.length?' · '+partial.join('，'):'';
    const status = document.querySelector('#running-status'); status.className='status-label'+(running?' running':''); status.innerHTML=`<i></i>${esc(starting?'正在检测官方连接…':running?(state.readOnly?'只读联调已启动':!state.config.autoReplyEnabled&&!state.config.autoDeliveryEnabled&&!state.config.autoRefundEnabled?'仅监听 · 自动功能均已关闭':state.connection.diagnostics.chat.ready?'自动处理已启动':'等待官方连接')+partialLabel+catchUpLabel:autoPending?(autoLabels[state.autoStart.phase] || '正在自动连接…'):state.readOnly?'只读联调 · 已暂停':'监听已暂停')}`;
  document.querySelector('#running-button').innerHTML=icon(running||autoPending?'pause':'play')+(starting?'正在连接…':running?'暂停监听':autoPending?'取消自动连接':'开始监听');
  document.querySelector('#breadcrumb').textContent=navItems.find(row=>row[0]===page)[2];
}
function heading(title, subtitle, actions='') { return `<div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div><div class="heading-actions">${actions}</div></div>`; }
function empty(title, subtitle, action='') { return `<div class="empty"><div class="empty-icon">${icon('box')}</div><h3>${title}</h3><p>${subtitle}</p>${action}</div>`; }
function button(text, action, primary=false, attrs='') { return `<button type="button" class="button ${primary?'primary':''}" data-action="${action}" ${attrs}>${text}</button>`; }
function sectionTabs(owner,items) {
  return `<div class="section-tabs" role="tablist" aria-label="${esc(navItems.find(row=>row[0]===owner)[2])}分类">${items.map(([key,title])=>`<button type="button" role="tab" id="${owner}-${key}-tab" aria-controls="${owner}-panel" aria-selected="${sections[owner]===key}" tabindex="${sections[owner]===key?0:-1}" data-section="${key}" class="section-tab ${sections[owner]===key?'active':''}">${title}${owner==='settings'&&key==='alerts'&&phoneAlertDraft?'<span class="tab-draft">待保存</span>':''}</button>`).join('')}</div>`;
}
function sectionPanel(owner,content) {return `<div role="tabpanel" id="${owner}-panel" aria-labelledby="${owner}-${sections[owner]}-tab">${content}</div>`;}
function settingSaveBar() {return `<div class="settings-save-bar"><span id="settings-save-state" class="small-note" role="status"></span></div>`;}
function numberSetting(c,key,label,min,max) {return `<label class="field"><span>${label}</span><input id="${key}" type="number" min="${min}" max="${max}" value="${c[key]}"></label>`;}
function jobTable(rows, controls=false) {
  if (!rows.length) return empty('这里还没有处理记录','添加规则后可以先在本机预览。连接店铺并完成页面校验后，实际处理记录会出现在这里。',button('预览一笔订单','simulate-order'));
  return `<div class="table-wrap"><table><thead><tr><th>任务 / 商品</th><th>买家</th><th>匹配规则</th><th>状态</th><th>时间</th><th></th></tr></thead><tbody>${rows.map(job=>`<tr><td><strong>${jobTypes[job.type] || '任务'}${job.simulation?' · 预览':''}</strong><small>${esc(job.title || job.orderId || '客服消息')}${job.sku?' · '+esc(job.sku):''}</small></td><td>${esc(job.buyerName || job.buyerId)}<small>${esc(job.shopId)}</small></td><td>${esc(job.matchName || '—')}</td><td>${label(job)}${job.reason?`<small>${esc(reason(job.reason))}</small>`:''}</td><td class="subtle">${fmt(job.createdAt)}</td><td class="row-actions"><button data-action="job" data-id="${esc(job.id)}">查看${controls&&job.status==='uncertain'?' / 核实':''}</button></td></tr>`).join('')}</tbody></table></div>`;
}
function dashboard() {
  const stats=state.stats;
  const today=jobs().filter(job=>new Date(job.createdAt).toDateString()===new Date().toDateString() && !job.simulation);
  const delivery=stats.deliverySent;
  const replies=stats.replySent;
  const pending=jobs().filter(j=>!j.simulation&&['blocked','uncertain','queued'].includes(j.status)).length;
  const ready=state.connection.diagnostics.chat.ready;
  return `${heading('把发货交给规则，把时间留给经营。','设置一次发货内容，商品名或 SKU 命中关键词后发送内容，再确认发货；退款申请单独自动处理。')}
  <div class="welcome"><div><div class="eyebrow">YOUR LOCAL WORKBENCH</div><h2>${state.config.products.length?'你的发货内容已准备好':'从第一条发货内容开始'}</h2><p>添加商品匹配关键词与对应的发货内容。<br>在本机预览匹配，再连接店铺启动需要的功能。</p><div class="steps"><div class="step"><b>1</b>添加内容</div><div class="step"><b>2</b>预览匹配</div><div class="step"><b>3</b>校验店铺页面</div></div></div><div class="welcome-art">${icon('link')}</div></div>
  <div class="stats">${[['平台已确认发货',stats.shipmentSent || 0,'笔','另有 '+delivery+' 条发货内容已确认','box'],['已确认自动答复',replies,'条','仅统计真实答复','chat'],['已确认同意退款',stats.refundSent || 0,'笔','以平台最新状态为准','refresh'],['待处理任务',pending,'项','未匹配或需核实的任务','queue']].map(([name,value,unit,foot,i])=>`<div class="stat"><div class="stat-name">${name}</div><div class="stat-icon">${icon(i)}</div><div class="stat-value">${value}<small>${unit}</small></div><div class="stat-foot">${foot}</div></div>`).join('')}</div>
  <div class="two-columns"><section class="panel"><div class="panel-head"><h2>最近处理</h2><button class="muted-link" data-nav="records">全部记录 ↗</button></div>${jobTable(jobs().slice(0,5))}</section><div><section class="panel"><div class="panel-head"><h2>开始配置</h2><span class="badge">本机</span></div><div class="panel-body">${[['box','添加发货内容','商品关键词与对应的网盘链接','add-product'],['chat','设置智能答复','欢迎语、试玩与默认回复','nav-replies'],['play','预览一笔订单','只在本机计算，不发送给买家','simulate-order']].map(([i,title,sub,action])=>`<button class="quick-action" data-action="${action}"><span class="tile">${icon(i)}</span><span><strong>${title}</strong><small>${sub}</small></span><span>›</span></button>`).join('')}</div></section><section class="panel"><div class="panel-head"><h2>店铺连接</h2><span class="badge ${ready?'green':'orange'}">${ready?'当前会话已校验':'待校验'}</span></div><div class="panel-body"><div class="subtle" style="line-height:1.9">${esc(state.connection.diagnostics.chat.message)}<br>首次使用需在官方页面扫码登录，并校验取数与发送回执。</div><div style="margin-top:16px">${button('打开店铺工作台','open-shop')}</div></div></section></div></div><div class="page-end">本地规则 · 独立网页登录会话 · 发送结果可追溯</div>`;
}
function products() {
  const navigation=sectionTabs('products',[['list','发货内容列表'],['delivery','发货设置']]);
  if(sections.products==='delivery')return heading('发货内容','默认内容、统一尾缀和发送方式都在这里管理。')+navigation+sectionPanel('products',deliverySettings());
  const rows=[...state.config.products].reverse().filter(p=>(p.name+' '+p.keywords.join(' ')).toLowerCase().includes(filter.toLowerCase()));
  return `${heading('发货内容','商品名称或 SKU / 规格包含设定关键词，就发送对应内容。',button(icon('plus')+'添加发货内容','add-product',true))}
  ${navigation}${sectionPanel('products',`<div class="banner">${icon('link')}<span>商品名称或 SKU 包含设置的关键词时，发送对应内容与统一尾缀。多个不同内容同时命中时，任务会转入待处理。</span></div>
  <div class="toolbar"><div class="search">${icon('search')}<input class="text-input" id="search" placeholder="搜索名称或关键词" value="${esc(filter)}"></div><span class="subtle">共 ${state.config.products.length} 条发货内容</span>${button('预览匹配','simulate-order')}</div>
  <section class="panel">${rows.length?`<div class="table-wrap"><table><thead><tr><th>内容名称</th><th>匹配范围 / 关键词</th><th>发货正文</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows.map(p=>`<tr><td><strong class="product-name">${esc(p.name)}</strong>${p.excludeKeywords.length?`<small>排除：${esc(p.excludeKeywords.join('、'))}</small>`:''}</td><td>${esc(matchTargets[p.matchTarget] || matchTargets.either)}<br>${keywordList(p.keywords)}</td><td><div class="cell-content">${esc(p.content)}</div></td><td><span class="badge ${p.enabled?'green':''}">${p.enabled?'启用中':'已停用'}</span></td><td class="row-actions"><button data-action="edit-product" data-id="${esc(p.id)}">编辑</button><button data-action="toggle-product" data-id="${esc(p.id)}">${p.enabled?'停用':'启用'}</button><button class="muted" data-action="remove-product" data-id="${esc(p.id)}">删除</button></td></tr>`).join('')}</tbody></table></div>`:empty('添加你的第一条发货内容','填上商品名称、标题中的关键词与网盘链接，统一的领取说明可在“发货设置”标签中添加。',button('添加发货内容','add-product',true))}</section>
  `)}`;
}
function replies() {
  const navigation=sectionTabs('replies',[['content','答复内容'],['strategy','答复策略']]);
  if(sections.replies!=='content')return heading('智能答复','欢迎语、答复时间与人工介入设置。')+navigation+sectionPanel('replies',replyStrategy());
  return `${heading('智能答复','让买家先收到清楚的介绍，再按关键词获取需要的信息。',button(icon('plus')+'添加关键词答复','add-reply',true))}${navigation}${sectionPanel('replies',`
  <div class="small-note">答复末尾附加内容：${state.config.replySuffixEnabled?(state.config.replySuffixMode==='time'?'当前时间':'随机不可见字符'):'未启用'}。可在“答复策略”标签中设置。</div>
  <div class="two-columns"><section class="panel"><div class="panel-head"><h2>首次欢迎语</h2><span class="badge ${state.config.greetingEnabled?'green':''}">${state.config.greetingEnabled?'已启用':'已关闭'}</span></div><div class="panel-body"><div class="content-preview">${esc(state.config.greeting)}</div><div class="small-note">距上次咨询超过 ${state.config.firstReplyIntervalMinutes} 分钟时重新欢迎。欢迎语与关键词答复分别按设定延迟发送。</div><div style="margin-top:15px">${button('编辑欢迎语','edit-greeting')}</div></div></section><section class="panel"><div class="panel-head"><h2>未匹配默认答复</h2></div><div class="panel-body"><div class="content-preview">${esc(state.config.fallback || '未设置默认答复')}</div><div class="small-note">未命中关键词时使用。一般答复延迟为人工处理留时间；相同原文按成功发送后的冷却间隔限制。</div><div style="margin-top:15px">${button('编辑默认答复','edit-fallback')}</div></div></section></div>
  <section class="panel"><div class="panel-head"><h2>关键词答复 <span class="rule-count">${state.config.replyRules.length} 条</span></h2>${button('预览咨询答复','simulate-message')}</div>${state.config.replyRules.length?`<div class="table-wrap"><table><thead><tr><th>规则名称</th><th>匹配词</th><th>回复正文</th><th>状态</th><th>操作</th></tr></thead><tbody>${state.config.replyRules.map(r=>`<tr><td><strong>${esc(r.name)}</strong></td><td>${esc(matchTypes[r.matchType] || matchTypes.contains)}<br>${keywordList(r.keywords)}</td><td><div class="cell-content">${esc(r.content)}</div></td><td><span class="badge ${r.enabled?'green':''}">${r.enabled?'已启用':'已停用'}</span></td><td class="row-actions"><button data-action="edit-reply" data-id="${esc(r.id)}">编辑</button><button data-action="toggle-reply" data-id="${esc(r.id)}">${r.enabled?'停用':'启用'}</button><button class="muted" data-action="remove-reply" data-id="${esc(r.id)}">删除</button></td></tr>`).join('')}</tbody></table></div>`:empty('设置“试玩”等关键词','例如买家说“想试玩”，自动回复你设置的试玩网盘链接。',button('添加关键词答复','add-reply',true))}</section>`)}`;
}
const chatFields=[['buyer','当前会话买家标识'],['incoming','一条买家消息气泡'],['input','消息输入框'],['send','发送按钮'],['outgoing','一条历史商家消息气泡'],['receipt','发送成功 / 送达标记']];
const orderFields=[['row','一条完整订单卡片'],['orderId','订单号'],['title','商品标题'],['buyer','订单中的买家标识'],['status','订单付款 / 发货状态'],['paidAt','付款时间'],['contact','联系买家链接']];
function shop() {
  const checks=state.connection.bridge || {};
  const network=state.connection.network || {}, currentPage=state.connection.pages?.[browserKind] || {};
  const networkLabels={offline:'网络已断开，恢复后将自动刷新页面',stabilizing:'网络已恢复，等待稳定后自动刷新页面…',refreshing:'网络已恢复，正在自动刷新官方页面…',waiting:'正在等待操作回执，随后自动刷新页面',failed:'网络已恢复，页面刷新尚未完成，请查看运行记录'};
  const pageLabels={needs_person:currentPage.login?'页面需要本人登录；完成后自动继续':'页面仍显示安全验证；功能连接状态见右侧，受验证限制的接口需本人完成验证',draft:'页面有未发送的草稿，已保留；可发送或清空后手动刷新',failed:'当前页面刷新失败，连接恢复检查将继续',loaded:'页面已加载；各项功能以右侧接口检测及实际处理回执为准'};
  const pageNotice=networkLabels[network.phase] || pageLabels[currentPage.phase];
  const status=(key,label)=>`<div class="pick-row"><div><strong>${label}</strong><small>${esc(checks[key]?.reason || (checks[key]?.ready?'已完成只读检测':'等待检测'))}${checks[key]?.total!==undefined?' · 当前 '+checks[key].total+' 笔':''}</small></div><span class="badge ${checks[key]?.ready?'green':'orange'}">${checks[key]?.ready?'已连接':checks[key]?.verification?'待验证':checks[key]?.retryAt?'自动重试中':'待检测'}</span></div>`;
  return `${heading('店铺工作台','使用官方商家网页扫码登录，规则和处理记录保存在本机。')}
  <div class="shop-toolbar"><div><button class="tab ${browserKind==='chat'?'active':''}" data-action="browser-kind" data-kind="chat">客服页面</button><button class="tab ${browserKind==='orders'?'active':''}" data-action="browser-kind" data-kind="orders">商家后台 / 订单</button></div><div class="heading-actions">${button(icon('refresh')+'刷新页面','browser-reload')}${button('回到入口','browser-home')}</div></div>
  ${pageNotice?`<div class="small-note" data-page-status role="status">${esc(pageNotice)}</div>`:''}
  <div class="shop-grid"><div id="browser-stage" class="browser-stage">${state.preview?'界面测试版不连接店铺；真实客服画面请查看正在运行的正式版。':'正在打开官方商家页面…'}</div><aside class="connection-panel"><h3>连接检测</h3><p>先登录，再检测当前所选自动功能的数据接入。</p>${status('chat','客服新消息与官方发送组件')}${status('orders','待发货订单与虚拟发货组件')}${status('refunds','官方售后申请列表')}<div class="form-footer" style="justify-content:flex-start">${button('检测官方连接','check-platform',true)}</div><div class="small-note">检测只读取数据，不发送消息、不确认发货、不退款。</div><hr><p>${esc(state.connection.coverage)}</p><p class="footnote">断线后自动恢复连接。登录过期或安全验证时，请在官方页面完成操作；真实发货与退款结果请结合处理记录核对。</p></aside></div><div class="shop-url">官方页面：${esc(state.connection.urls[browserKind] || 'https://mms.pinduoduo.com/')}</div>`;
}

function queue() {
  const rows=jobs().filter(job=>!job.simulation&&['queued','sending','blocked','uncertain'].includes(job.status));
  return `${heading('待处理','遇到未匹配、歧义或发送结果不明时，把任务留在这里核实。')}
  <div class="banner amber">${icon('clock')}<span>“待核实”的消息可能已经发送，请先在官方聊天窗口检查，再结案。程序不会自动重试结果不明的消息。</span></div><section class="panel">${jobTable(rows,true)}</section>`;
}
function records() {
  const coreLogs=[...state.logs].reverse(); const notes=[...state.connection.diagnostics.notes].reverse();
  return `${heading('运行记录','本地预览与真实发送分别标记，便于回看每一次处理结果。',button('刷新记录','refresh'))}<section class="panel"><div class="panel-head"><h2>消息与订单</h2><span class="subtle">最近 ${state.jobs.length} 项</span></div>${jobTable(jobs())}</section><section class="panel"><div class="panel-head"><h2>状态日志</h2></div><div class="panel-body">${coreLogs.length||notes.length?[...notes.map(n=>({time:n.time,message:n.message})),...coreLogs.map(l=>({time:l.time||l.createdAt||l.at,message:l.message||l.detail||l.event||JSON.stringify(l)}))].sort((a,b)=>(b.time||0)-(a.time||0)).slice(0,70).map(l=>`<div class="log-item"><time>${l.time?fmt(l.time):'本机记录'}</time><p>${esc(typeof l.message==='string'?l.message:JSON.stringify(l.message))}</p></div>`).join(''):'<div class="subtle">暂时没有运行日志。</div>'}</div></section>`;
}
function switchRow(title, description, key, checked) { return `<div class="toggle-row"><div><strong>${title}</strong><p>${description}</p></div><label class="switch"><input type="checkbox" id="${key}" ${checked?'checked':''}><i></i></label></div>`; }
function messageLinkSettings(c) {
  return `<section class="panel"><div class="panel-head"><h2>链接与图片发送</h2></div><div class="panel-body">${switchRow('正文后单独发送纯链接','介绍正文之后，将每条网址单独发送，便于手机长按复制。此开关同时适用于发货和智能答复。','separateLinksEnabled',c.separateLinksEnabled)}<p class="small-note">纯链接不添加说明、时间或不可见字符。图片 / 二维码在对应内容的编辑窗口中添加，发送顺序为正文 → 纯链接 → 图片；发货内容全部确认成功后，再按设置确认发货。</p></div></section>`;
}
function deliverySettings() {
  const c={...state.config,...settingsDraft};
  return `<div class="settings-stack">${settingSaveBar()}<p class="settings-hint">设置自动保存，保留当前监听状态；需要时可手动暂停。</p>
  <section class="panel"><div class="panel-head"><h2>自动发货</h2></div><div class="panel-body">${switchRow('自动发送发货内容','按商品名称或 SKU 匹配内容；启动时也会扫描尚未处理的待发货订单。','autoDeliveryEnabled',c.autoDeliveryEnabled)}${switchRow('发送后自动确认发货','内容取得发送成功回执后，才提交官方虚拟发货。','autoConfirmShipmentEnabled',c.autoConfirmShipmentEnabled)}</div></section>
  <section class="panel"><div class="panel-head"><h2>未匹配默认发货</h2><span class="badge ${c.deliveryFallbackEnabled?'green':''}">${c.deliveryFallbackEnabled?'已启用':'未启用'}</span></div><div class="panel-body"><div class="content-preview">${esc(c.deliveryFallback || '尚未设置默认发货内容')}</div><p class="small-note">商品名称和 SKU 均未命中时使用，也会附加统一尾缀。多个不同内容同时命中时，保留到待处理核实。</p>${button('设置默认发货内容','edit-delivery-fallback')}</div></section>
  <section class="panel"><div class="panel-head"><h2>统一发货尾缀</h2></div><div class="panel-body"><label class="field"><span>每条发货正文后附加的说明</span><textarea id="suffix" rows="4" placeholder="输入统一的领取说明或使用提示">${esc(c.suffix)}</textarea><small>匹配发货和默认发货都使用此尾缀；单独发送的纯链接不附加尾缀。</small></label></div></section>
  ${messageLinkSettings(c)}</div>`;
}
function replyStrategy() {
  const c={...state.config,...settingsDraft};
  return `<div class="settings-stack">${settingSaveBar()}<p class="settings-hint">设置自动保存，保留当前监听状态；需要时可手动暂停。</p>
  <section class="panel"><div class="panel-head"><h2>自动答复与人工介入</h2></div><div class="panel-body">${switchRow('启用智能答复','按欢迎语、关键词与默认答复处理新咨询。','autoReplyEnabled',c.autoReplyEnabled)}${switchRow('首次欢迎语','首次咨询，或超过设定的咨询间隔后重新发送。','greetingEnabled',c.greetingEnabled)}${switchRow('人工答复时停止等待中的自动答复','同一买家由人工接手后，取消尚未发送的自动答复。','manualInterventionEnabled',c.manualInterventionEnabled)}</div></section>
  <section class="panel"><div class="panel-head"><h2>答复时间</h2></div><div class="panel-body"><div class="form-grid">${numberSetting(c,'firstReplyDelaySeconds','欢迎语延迟（秒）',0,3600)}${numberSetting(c,'replyDelaySeconds','一般答复延迟（秒）',0,3600)}${numberSetting(c,'firstReplyIntervalMinutes','重新欢迎的咨询间隔（分钟）',1,1440)}${numberSetting(c,'cooldownSeconds','相同正文冷却（秒）',0,86400)}</div><p class="small-note">首次欢迎语按欢迎语延迟发送；关键词和默认答复先等待一般答复延迟，规则独立延迟优先。等待期间识别到人工已回复便取消待发答复。相同正文冷却从同一买家上一条相同原文成功发送时起算，不比较随机字符或时间尾缀，也不是每次咨询后的固定等待时间。</p></div></section>
  <section class="panel"><div class="panel-head"><h2>答复末尾附加内容</h2></div><div class="panel-body">${switchRow('启用答复末尾附加内容','仅作用于欢迎语、关键词答复和默认答复；仍受正文冷却和发送上限限制。','replySuffixEnabled',c.replySuffixEnabled)}<label class="field"><span>末尾内容</span><select id="replySuffixMode"><option value="invisible" ${c.replySuffixMode==='invisible'?'selected':''}>随机不可见字符</option><option value="time" ${c.replySuffixMode==='time'?'selected':''}>当前时间</option></select></label><p class="small-note">正文以网址结尾时跳过不可见字符，避免影响链接。平台是否接受消息，以实际回执为准。</p></div></section>
  ${messageLinkSettings(c)}<p class="small-note">自动补答保障已内置：启动和重连后检查待回复会话，运行中持续复查；失败后保留任务并重试，结果不明先核实。</p></div>`;
}
function runtimeSettings() {
  const c={...state.config,...settingsDraft};
  return `<div class="settings-stack">${settingSaveBar()}<p class="settings-hint">设置自动保存，保留当前监听状态；需要时可手动暂停。</p>
  <section class="panel"><div class="panel-head"><h2>启动与托盘</h2></div><div class="panel-body">${switchRow('打开软件自动监听','使用已开启的答复、发货和退款功能；需要登录或验证时，完成后自动继续。','autoListenOnLaunch',c.autoListenOnLaunch)}${switchRow('开机打开工作台','登录 Windows 后打开软件；是否自动监听由上面的开关决定。','startup',settingsDraft.startup ?? state.startup)}<div class="form-footer">${button('收起到托盘','background')}</div><p class="small-note">关闭窗口默认收起到托盘。电脑关机、休眠或退出程序后无法继续处理。</p></div></section>
  <section class="panel"><div class="panel-head"><h2>全局发送上限</h2></div><div class="panel-body"><div class="form-grid">${numberSetting(c,'maxPerMinute','每分钟最多发送消息（条）',1,120)}</div><p class="small-note">智能答复和发货消息共用此上限。各功能的开关与业务策略，请到左侧对应页面设置。</p></div></section></div>`;
}
function backupSettings() {
  return `<div class="settings-stack"><section class="panel"><div class="panel-head"><h2>规则备份</h2></div><div class="panel-body"><div class="heading-actions">${button('导出规则','backup')}${button('导入规则','import')}</div><p class="small-note">备份包含规则与设置；导入后自动处理关闭。</p><button class="link-button" data-action="data-folder">打开本机数据目录 ↗</button></div></section>
  <section class="panel"><div class="panel-head"><h2>规则迁移</h2></div><div class="panel-body"><p>通过分类文件迁移文字规则。导入一类内容，不会覆盖另一类的内容。</p>${[['replies','智能答复规则','关键词、匹配方式、答复正文、欢迎语与默认答复'],['delivery','发货规则','商品 / SKU 关键词、排除词、网盘正文与发货尾缀']].map(([scope,label,description])=>`<h3>${label}</h3><p class="small-note">${description}</p><div class="heading-actions">${button('导出'+label,'shared-export',false,`data-scope="${scope}"`)}${button('导入并预览','shared-import',false,`data-scope="${scope}"`)}</div>`).join('')}<p class="small-note">兼容旧规则备份，仅提取所选类别。图片和平台专属规则需单独处理。先暂停监听再确认导入，原规则自动备份。</p></div></section></div>`;
}
function connectionSettings() {
  return `<div class="settings-stack"><section class="panel"><div class="panel-head"><h2>官方连接</h2></div><div class="panel-body"><p>${esc(state.connection.diagnostics.chat.message)}</p><div class="heading-actions">${button('检测官方连接','check-platform')}${button('打开店铺页面','open-shop')}</div><p class="small-note">实际发送、确认发货和退款结果，请在运行记录中核对平台回执。</p></div></section><section class="panel"><div class="panel-head"><h2>软件版本</h2></div><div class="panel-body">拼多多自动发货助手 v${esc(state.version)}</div></section></div>`;
}
function settings() {
  const panels={runtime:runtimeSettings,backup:backupSettings,connection:connectionSettings,alerts:()=>`<div class="settings-stack">${phoneAlertPanel()}${cloudWatchdogPanel()}</div>`};
  return heading('助手设置','本机运行、备份和提醒按类别管理；业务设置请到左侧对应功能。')+sectionTabs('settings',[['runtime','本机运行'],['backup','备份与迁移'],['connection','连接与版本'],['alerts','异常提醒']])+sectionPanel('settings',panels[sections.settings]());
}

function phoneAlertPanel(){
  const alerts=state.phoneAlerts;if(!alerts)return '';
  const c=phoneAlertDraft?.config||alerts.config,route=c.provider+':'+c.channel;
  const selected=alerts.credentials[c.provider],sms=c.channel==='sms',incident=alerts.monitor.incident;
  const status=[alerts.monitor.lastNotification,alerts.test].filter(Boolean).sort((a,b)=>(b.acceptedAt||b.lastAttemptAt||b.at)-(a.acceptedAt||a.lastAttemptAt||a.at))[0];
  const statuses={pending:'等待提交',submitting:'正在提交',accepted:'推送服务已受理',retrying:'等待重试',failed:'未取得服务受理确认',cancelled:'已取消'};
  return `<section class="panel" data-phone-alerts><div class="panel-head"><h2>异常提醒 · 桌面与手机</h2></div><div class="panel-body">
  ${state.cloudWatchdog?.ownsMobile?'<p class="small-note">手机故障提醒已交由云端监护，本机继续显示桌面弹窗。下面的手机配置保留，停用云端监护后使用。</p>':''}
  ${switchRow('电脑右下角异常弹窗','默认开启，无需绑定手机。助手缩到托盘时也显示，不抢输入焦点；收起提示后继续自动恢复。','alert-desktop',c.desktopEnabled)}
  <div class="heading-actions">${button('预览桌面弹窗','desktop-alert-test')}</div>
  ${switchRow('启用手机提醒','持续异常且自动恢复失败后提醒；同一故障被服务受理后不重复提交。','alert-enabled',c.enabled)}
  <div class="form-grid"><label class="field"><span>接收方式</span><select id="alert-route">${[['serverchan:wechat','普通微信 · Server酱Turbo'],['pushplus:wechat','普通微信 · PushPlus'],['pushplus:sms','短信 · PushPlus（约0.1元/条）']].map(([value,label])=>`<option value="${value}" ${route===value?'selected':''}>${label}</option>`).join('')}</select></label>
  <label class="field"><span>${c.provider==='serverchan'?'SendKey（SCT开头）':'PushPlus Token'}</span><input id="alert-token" type="password" autocomplete="new-password" spellcheck="false" maxlength="256" value="${esc(phoneAlertDraft?.token||'')}" placeholder="${selected?'已保存；留空保留现有密钥':'在服务官网获取后粘贴到这里'}"></label>
  <label class="field"><span>持续异常达到（秒）</span><input id="alert-seconds" type="number" min="30" max="3600" value="${c.failureSeconds}"></label><label class="field"><span>检测 / 恢复失败至少（次）</span><input id="alert-failures" type="number" min="2" max="20" value="${c.minFailures}"></label></div>
  ${switchRow('恢复后再通知一次','恢复正常并稳定一分钟后提醒。短信会另外消耗一条。','alert-recovery',c.notifyRecovery)}
  <p class="small-note">${c.provider==='serverchan'?'先在Server酱绑定微信接收通道，再填写SendKey。免费额度以服务官网为准。':'先在PushPlus绑定微信或手机号，并完成官网要求的实名配置。'}${sms?'短信按条计费、需有积分，手机仅收到服务的固定提示，详细异常请在服务中查看。':''}</p>
  <div class="heading-actions">${button('打开服务官网','phone-alert-setup')}${button('保存提醒设置','phone-alert-save',true)}${button(sms?'发送短信测试（约0.1元）':'发送测试提醒','phone-alert-test')}${button('清除本机密钥','phone-alert-clear',false,selected?'':'disabled')}</div>
  <p class="small-note" data-phone-alert-status>桌面弹窗${alerts.config.desktopEnabled?'已开启':'已关闭'} · 手机提醒${alerts.config.enabled?'已开启':'未开启'}${phoneAlertDraft?'（有修改待保存）':''} · ${selected?'密钥已加密保存':'尚未配置手机密钥'}${status?` · ${esc(statuses[status.status]||status.status)}（${fmt(status.acceptedAt||status.at||status.lastAttemptAt)}）`:''}${status?.error?'<br>'+esc(status.error):''}</p>
  ${incident?`<p class="small-note">异常开始：${fmt(incident.startedAt)}；已记录 ${incident.failures} 次检测失败。</p>`:''}
  ${alerts.settingsError||alerts.monitor.persistenceError||alerts.runtimeError?`<div class="inline-error">${esc(alerts.settingsError||alerts.monitor.persistenceError||alerts.runtimeError)}</div>`:''}
  <p class="small-note">默认持续异常60秒、至少3次检测或恢复失败后提醒，同一故障不反复弹出。正常并稳定一分钟后自动收起；手动暂停不报警。此处单独保存，不会暂停监听。密钥不随规则备份或迁移导出。测试显示“服务已受理”后，请亲自确认手机能收到。电脑断网时仍可显示桌面提示，但无法即时向手机推送；休眠、关机或程序退出需外部心跳监测补足。断网恢复后会补充尚未发出的故障摘要。</p>
  </div></section>`;
}
function cloudWatchdogPanel(){
  const c=state.cloudWatchdog;if(!c)return '';
  const draft=cloudWatchdogDraft||c;
  const status={idle:'尚未连接',connected:'云端已确认心跳',paused:'云端已确认主动暂停',error:'心跳未取得回执'};
  const notice=c.cloudIncident||c.lastNotification;
  const notices={pending:'故障等待确认',submitting:'正在提交',retrying:'等待重试',accepted:'推送服务已受理',uncertain:'推送未取得可核验回执',failed:'推送未受理，请检查云端配置或服务额度'};
  return `<section class="panel" data-cloud-watchdog><div class="panel-head"><h2>云端离线监护</h2></div><div class="panel-body">
  <p>电脑断网、休眠或助手停止运行时，由独立云端通知微信。每15秒报平安，持续失联或运行异常约一分钟后提醒。</p>
  <div class="form-grid"><label class="field"><span>云端监护地址</span><input id="cloud-url" type="url" value="${esc(draft.url||'')}" placeholder="填写已部署的 Cloudflare HTTPS 根地址"></label><label class="field"><span>心跳密钥</span><input id="cloud-token" type="password" autocomplete="new-password" maxlength="128" value="${esc(draft.token||'')}" placeholder="${c.configured?'已加密保存；留空保留':'填写部署时生成的心跳密钥'}"></label></div>
  <div class="heading-actions">${button(c.enabled?'保存监护配置':'保存并启用云端监护','cloud-watchdog-save',true)}${button('停用云端监护','cloud-watchdog-disable',false,c.enabled?'':'disabled')}</div>
  <p class="small-note">${c.enabled?'云端监护已启用':'云端监护未启用'} · ${esc(status[c.status]||c.status)}${c.lastAcceptedAt?' · 最近确认：'+fmt(c.lastAcceptedAt):''}${cloudWatchdogDraft?' · 有修改待保存':''}</p>
  ${notice?`<p class="small-note">最近云端故障提醒：${esc(notices[notice.status]||notice.status)}${notice.at?' · '+fmt(notice.at):''}</p>`:''}
  ${c.error?`<div class="inline-error">${esc(c.error)}</div>`:''}
  <p class="small-note">仅发送运行状态，不上传聊天、订单、Cookie 或店铺资料。启用后手机故障提醒统一由云端提交，本机继续显示桌面弹窗。手动暂停且云端确认后不报警；直接退出程序、关机、休眠仍会提醒。停用前请先手动暂停监听。Server酱 SendKey 需要单独配置在你自己的云端 Secrets 中，不会自动上传本机密钥。免费额度及实际送达时间以服务为准。</p>
  </div></section>`;
}
function rememberCloudWatchdogDraft(){
  if(document.getElementById('cloud-url'))cloudWatchdogDraft={url:document.getElementById('cloud-url').value,token:document.getElementById('cloud-token').value};
}
function rememberPhoneAlertDraft(){
  if(!document.getElementById('alert-route'))return;
  const [provider,channel]=document.getElementById('alert-route').value.split(':');
  phoneAlertDraft={config:{desktopEnabled:document.getElementById('alert-desktop').checked,enabled:document.getElementById('alert-enabled').checked,provider,channel,failureSeconds:Number(document.getElementById('alert-seconds').value),minFailures:Number(document.getElementById('alert-failures').value),notifyRecovery:document.getElementById('alert-recovery').checked},token:document.getElementById('alert-token').value};
}
async function savePhoneAlertSettings(){rememberPhoneAlertDraft();state=await call('phone-alerts:save',phoneAlertDraft);phoneAlertDraft=null;render();}
function refunds() {
  const c={...state.config,...settingsDraft};
  return `${heading('自动退款','对官方标记为需商家同意的退款申请，检测后立即提交同意。',button('预览退款流程','simulate-refund'))}${settingSaveBar()}
  <div class="banner ${state.config.autoRefundEnabled?'':'amber'}">${icon('refresh')}<span>自动退款${state.config.autoRefundEnabled?'已开启':'未开启'}。申请会先停止该订单尚未执行的发货，再查询最新申请版本并提交同意；完成以平台回执为准。</span></div>
  <section class="panel"><div class="panel-head"><h2>处理方式</h2></div><div class="panel-body">${switchRow('退款申请自动同意','检测到需商家同意的退款申请后立即提交。设置自动保存，只影响退款功能，不暂停其他功能。','autoRefundEnabled',c.autoRefundEnabled)}<p>不设置金额上限、不等待人工审核，也不按商品匹配规则筛选退款。</p><p>平台处理中的申请继续查询；申请撤销或结束后不再提交。网络异常时先查平台状态，防止重复操作。</p><div class="small-note">“秒退”指检测后立即提交。实际到账和平台完成时间由拼多多决定，不能保证每笔在一秒内完成。</div></div></section>
  <section class="panel"><div class="panel-head"><h2>退款记录</h2></div>${jobTable(jobs().filter(job=>job.type==='refund'),true)}</section>`;
}

function render() {
  const previousPage=document.body.dataset.page;
  document.body.dataset.page=page;
  if(previousPage!==page)window.scrollTo(0,0);
  updateHeader();
  const pending=state.jobs.filter(j=>!j.simulation&&['blocked','uncertain'].includes(j.status)).length;
  document.querySelector('#nav').innerHTML=navItems.map(([key,i,title])=>`<button class="nav-item ${key===page?'active':''}" data-nav="${key}">${icon(i)}<span>${title}</span>${key==='queue'&&pending?`<span class="count">${pending}</span>`:''}</button>`).join('');
  const views={dashboard,products,replies,refunds,shop,queue,records,settings}; document.querySelector('#content').innerHTML=views[page]();
  updateSettingsStatus();
  browserResizeObserver?.disconnect();
  if (page==='shop') { browserResizeObserver?.observe(document.querySelector('#browser-stage')); scheduleBrowserLayout(); }
  else { lastBrowserLayout=''; api.call('browser:show',{visible:false}).catch(()=>{}); }
}
let browserLayoutFrame, lastBrowserLayout='';
const browserResizeObserver=typeof ResizeObserver==='function'?new ResizeObserver(()=>scheduleBrowserLayout()):null;
function scheduleBrowserLayout(){if(!browserLayoutFrame)browserLayoutFrame=requestAnimationFrame(()=>{browserLayoutFrame=undefined;void updateBrowser().catch(()=>{});});}
async function updateBrowser() {
  const stage=document.querySelector('#browser-stage'); if (!stage || page!=='shop' || modal) return;
  const rect=stage.getBoundingClientRect();
  const bounds={x:Math.ceil(rect.left+1),y:Math.ceil(rect.top+1),width:Math.floor(rect.width-2),height:Math.floor(rect.height-2)};
  const visible=bounds.width>=100&&bounds.height>=100&&bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=window.innerWidth&&bounds.y+bounds.height<=window.innerHeight;
  const layout={kind:browserKind,visible,bounds},key=JSON.stringify(layout);
  if(lastBrowserLayout===key)return;
  lastBrowserLayout=key;
  try{await api.call('browser:show',layout);}catch(error){lastBrowserLayout='';throw error;}
}
function closeModal() { if(sharedPreview){api.call('content:cancel',{token:sharedPreview.token}).catch(()=>{});sharedPreview=null;} modal=null; lastBrowserLayout='';document.querySelector('#modal-root').innerHTML=''; if (deferred) render(); if (page==='shop') scheduleBrowserLayout(); }
function openModal(title, subtitle, body, footer, large=false) {
  modal={title};lastBrowserLayout=''; if(page==='shop') api.call('browser:show',{visible:false});
  document.querySelector('#modal-root').innerHTML=`<div class="modal-backdrop"><section class="modal ${large?'large':''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="modal-head"><div><h2>${title}</h2><p>${subtitle}</p></div><button class="close-modal" data-action="close-modal" aria-label="关闭">×</button></div><div class="modal-body">${body}</div><div class="modal-footer">${footer}</div></section></div>`;
  document.querySelector('.modal input,.modal textarea')?.focus();
}
function sharedValue(value) {
  if (value === null) return '无';
  if (typeof value === 'boolean') return value ? '开启' : '关闭';
  if (typeof value !== 'object') return String(value || '（空）');
  const fields=[`名称：${value.name}`,`状态：${value.enabled?'启用':'停用'}`,`关键词：${value.keywords.join('、')}`];
  if (value.matchTarget) fields.push(`匹配范围：${matchTargets[value.matchTarget]}`,`排除词：${value.excludeKeywords.join('、') || '无'}`);
  if (value.matchType) fields.push(`匹配方式：${matchTypes[value.matchType]}`,`优先级：${value.priority}`,`独立延迟：${value.delaySeconds===null?'沿用本机设置':value.delaySeconds+' 秒'}`,`生效时段（北京时间，每项半小时）：${value.weekSlots.length?value.weekSlots.map(slot=>`${['周一','周二','周三','周四','周五','周六','周日'][Math.floor(slot/48)]} ${String(Math.floor(slot%48/2)).padStart(2,'0')}:${slot%2?'30':'00'}`).join('、'):'全天'}`);
  if (value.images?.length) fields.push(`附加图片：${value.images.length} 张`);
  return fields.join('\n')+'\n\n'+value.content;
}
function showSharedPreview(preview, reset=true) {
  sharedPreview=preview;if(reset)sharedPage=0;
  const {summary:s,changes,warnings}=preview, pageSize=40, pageCount=Math.max(1,Math.ceil(changes.length/pageSize));
  sharedPage=Math.min(sharedPage,pageCount-1);
  const names={add:'新增',update:'覆盖',remove:'删除',unchanged:'相同'}, kinds={product:'发货内容',reply:'智能答复',setting:'通用文案'}, category=preview.scope==='replies'?'智能答复规则':preview.scope==='delivery'?'发货规则':'文字规则';
  const rows=changes.slice(sharedPage*pageSize,(sharedPage+1)*pageSize);
  const body=`<div class="shared-mode"><span>导入方式</span>${button('合并：保留其他规则','shared-merge',preview.mode==='merge')}${button('替换：移除其他普通规则','shared-replace',preview.mode==='replace')}</div>
    <p class="small-note">仅处理${category}。按规则编号识别覆盖；同名但编号不同会新增。本机平台系统规则始终保留。通用文案按下方预览更新。</p>
    <div class="shared-summary"><span>新增 <b>${s.add}</b></span><span>覆盖 <b>${s.update}</b></span><span>删除 <b>${s.remove}</b></span><span>相同 <b>${s.unchanged}</b></span><span>文案变更 <b>${s.settings}</b></span><span>待处理 <b>${s.review}</b></span></div>
    ${warnings.length?`<details class="shared-warnings" open><summary>${warnings.length} 项需要单独核对</summary><ul>${warnings.map(row=>`<li><strong>${esc(row.name)}</strong>：${esc(row.reason)}</li>`).join('')}</ul></details>`:''}
    <p class="small-note">确认后保存原规则备份，并关闭自动监听、答复、发货和退款。发送限制、登录会话和运行记录沿用本机。当前预览不会发送消息。</p>
    <div class="shared-changes">${rows.map(row=>`<details class="shared-change"><summary><span class="badge ${row.action==='remove'?'orange':row.action==='add'?'green':''}">${names[row.action]}</span><span>${kinds[row.kind]} · ${esc(row.name)}</span></summary><div class="small-note">编号：${esc(row.id)}</div><div class="shared-comparison"><div><h3>本机原内容</h3><pre>${esc(sharedValue(row.before))}</pre></div><div><h3>导入后内容</h3><pre>${esc(sharedValue(row.after))}</pre></div></div></details>`).join('') || '<p class="small-note">没有可导入的文字内容。</p>'}</div>
    <div class="shared-pagination">${button('上一页','shared-prev',false,sharedPage===0?'disabled':'')}<span>第 ${sharedPage+1} / ${pageCount} 页 · 共 ${changes.length} 项</span>${button('下一页','shared-next',false,sharedPage===pageCount-1?'disabled':'')}</div>`;
  openModal('导入'+category,`来源：${preview.source==='pdd'?'拼多多':'淘宝'} · 先展开内容核对，再确认导入。`,body,`${button('取消','close-modal')}${button('刷新预览','shared-refresh')}${button('确认导入并关闭自动处理','shared-apply',true)}`,true);
}
function editRule(type,id) {
  const isProduct=type==='product';
  const row=(isProduct?state.config.products:state.config.replyRules).find(r=>r.id===id) || {id:crypto.randomUUID(),name:'',keywords:[],excludeKeywords:[],content:'',enabled:true,matchTarget:'either',matchType:'contains',delaySeconds:null,priority:100};
  const options=(values,current)=>Object.entries(values).map(([value,label])=>`<option value="${value}" ${current===value?'selected':''}>${label}</option>`).join('');
  imageDraft=structuredClone(row.images || []);
  openModal(isProduct?'发货内容':'智能答复规则',isProduct?'填好匹配词和指定内容，一条规则即可完成商品对应。':'精确与通配符优先匹配，再处理包含规则，未匹配时使用默认答复。',`<form id="rule-form" data-type="${type}" data-id="${esc(row.id)}"><div class="form-grid">
  <label class="field"><span>名称</span><input name="name" required value="${esc(row.name)}" placeholder="${isProduct?'输入发货内容名称，便于识别和管理':'输入答复规则名称，便于识别和管理'}"></label>
  <label class="field"><span>${isProduct?'匹配范围':'匹配策略'}</span><select name="${isProduct?'matchTarget':'matchType'}">${options(isProduct?matchTargets:{contains:'包含关键词',exact:'完全相等',wildcard:'通配符（* 任意多个字，? 一个字）',expression:'包含表达式'},isProduct?row.matchTarget:row.matchType)}</select></label>
  <label class="field wide"><span>关键词</span><textarea name="keywords" rows="2" required placeholder="${isProduct?'输入商品名称或 SKU 中需要匹配的文字':'输入买家咨询中需要匹配的文字'}">${esc(row.keywords.join('\n'))}</textarea><small>${isProduct?'多个词用换行、逗号或顿号分隔，任意一个包含即可。':'普通规则的多个词用换行、逗号或顿号分隔。表达式每行一条：逗号表示或，+ 表示同时包含，- 表示排除，支持括号。精确 / 通配符区分英文大小写。'}</small></label>
  ${isProduct?`<details class="wide"><summary>可选：排除词</summary><label class="field"><input name="excludeKeywords" value="${esc((row.excludeKeywords||[]).join('、'))}" placeholder="输入出现时不使用本条内容的文字，可留空"></label></details>`:`<label class="field"><span>此规则延迟（秒，留空跟随一般设置）</span><input name="delaySeconds" type="number" min="0" max="3600" value="${row.delaySeconds ?? ''}"></label><label class="field"><span>同类优先级（数字越小越优先）</span><input name="priority" type="number" min="0" max="999" value="${row.priority ?? 100}"></label>`}
  <label class="field wide"><span>${isProduct?'发送内容 / 网盘链接':'回复内容'}</span><textarea name="content" required rows="6" placeholder="${isProduct?'输入匹配后发送给买家的完整内容，可包含链接和领取说明':'输入触发本条规则时发送的完整答复'}">${esc(row.content)}</textarea></label></div>${mediaEditor()}<label class="small-note"><input type="checkbox" name="enabled" ${row.enabled?'checked':''}> 启用这条规则</label></form>`,button('取消','close-modal')+button('保存内容','save-rule',true));
}

function mediaEditor() {
  return `<section class="media-editor" id="media-editor"><div class="media-title"><strong>附加图片 / 二维码</strong>${button('选择并上传图片','add-image',false,imageDraft.length>=5?'disabled':'')}</div><p class="small-note">支持 PNG、JPG，每张最多 5 MB，最多 5 张。图片会在正文和单独链接之后逐张发送。选择后上传至拼多多，保存后生效。</p><div class="media-list">${imageDraft.map((image,index)=>`<div class="media-item"><img data-media-id="${image.id}" src="${esc(imageSource(image))}" alt="${esc(image.name)}" referrerpolicy="no-referrer"><span>${esc(image.name)}<small>${image.width} × ${image.height}</small></span><button type="button" class="muted-link" data-action="remove-image" data-index="${index}">移除</button></div>`).join('')}</div></section>`;
}
function redrawMedia() {document.getElementById('media-editor').outerHTML=mediaEditor();}

function editText(key) {
  const title=key==='greeting'?'编辑首次欢迎语':'编辑默认答复';
  imageDraft=structuredClone(state.config[key+'Images'] || []);
  openModal(title,'文字保存在本机，附加图片上传到拼多多。',`<label class="field"><span>回复正文</span><textarea id="text-value" rows="8">${esc(state.config[key])}</textarea></label>${mediaEditor()}<input type="hidden" id="text-key" value="${key}">`,button('取消','close-modal')+button('保存','save-text',true));
}
function simulate(type) {
  const body=type==='order'?`<label class="field"><span>商品名称</span><input id="simulate-text" placeholder="输入要测试匹配的完整商品名称"></label><label class="field"><span>SKU / 规格</span><input id="simulate-sku" placeholder="输入要测试匹配的商品规格，可留空"></label><label class="small-note"><input id="simulate-paid" type="checkbox" checked> 模拟已付款</label>`:type==='refund'?`<label class="field"><span>模拟订单号</span><input id="simulate-text" value="仅本地预览的订单"></label>`:`<label class="field"><span>买家咨询内容</span><textarea id="simulate-text" rows="3" placeholder="输入买家咨询内容，预览会使用哪条答复"></textarea></label>`;
  openModal(type==='order'?'预览商品匹配':type==='refund'?'预览自动退款':'预览咨询答复','只在本机计算，不向拼多多提交操作。',body+'<div id="simulation-result"></div>',button('关闭','close-modal')+button('生成预览','run-simulation',true,`data-type="${type}"`));
}

function jobDetail(id) {
  const job=state.jobs.find(j=>j.id===id); if(!job)return;
  openModal('处理详情','状态与发送正文均来自本机处理记录。',`<div class="job-detail-grid"><div><span>任务类型</span><strong>${jobTypes[job.type] || '任务'}${job.simulation?'（仅预览）':''}</strong></div><div><span>当前状态</span>${label(job)}</div><div><span>买家 / 店铺</span><strong>${esc(job.buyerName || job.buyerId)} · ${esc(job.shopId)}</strong></div><div><span>匹配规则</span><strong>${esc(job.matchName || '—')}</strong></div><div><span>订单号</span><strong>${esc(job.orderId || '—')}</strong></div><div><span>时间</span><strong>${fmt(job.createdAt)}</strong></div></div>${job.reason?`<div class="banner amber">${esc(reason(job.reason))}${job.detail?'<br>'+esc(job.detail):''}</div>`:''}<div class="content-preview">${esc(job.content || '此任务没有生成可发送的正文。')}</div>${job.status==='uncertain'?'<div class="small-note">先到对应的官方聊天、订单或售后页面核实。确认成功或决定取消后再结案，这两个操作都不会重新发送消息。</div>':''}`,button('关闭','close-modal')+(job.status==='uncertain'?button('核实后：确认未发 / 取消','resolve-job',false,`data-id="${esc(id)}" data-resolution="cancelled"`)+button('核实后：确认已成功','resolve-job',true,`data-id="${esc(id)}" data-resolution="sent"`):''),true);
  if(job.type==='reply' && job.status==='queued' && job.replyCooldownUntil!==undefined)document.querySelector('.modal-body').insertAdjacentHTML('beforeend',`<div class="small-note" data-reply-cooldown>已保存待回复任务，计划于 ${fmt(job.notBefore)} 冷却结束后自动核验并发送；无需等待每分钟补答检查。</div>`);
  if(job.type==='reply' && typeof job.wireContent==='string') {
    const tail=job.wireContent.slice(job.content.length+(job.replyBodySpaceOffsets?.length||0)).replace(/ /g,'[空格]').replace(/\n/g,'[换行]').replace(/[\u200b-\u200d]/g,char=>'U+'+char.codePointAt(0).toString(16).toUpperCase()+' ');
    const checked=job.outbound?.sha256 && job.outbound.sha256===job.wireContentSha256;
    document.querySelector('.modal-body').insertAdjacentHTML('beforeend',`<details class="small-note" data-reply-wire><summary>查看实际发送正文与尾缀</summary><div class="content-preview">${esc(job.wireContent)}</div><p>尾缀编码：${esc(tail || '未附加尾缀')}</p><p>${checked?'已核对：传给官方发送函数的正文与本地发送正文一致。':'此记录尚无官方发送参数的校验回传。'}平台是否接受请以上面的处理状态为准。</p></details>`);
  }
  if(job.reviewedAt&&job.recoveryJobId)document.querySelector('.modal-body').insertAdjacentHTML('beforeend',`<div class="small-note">这条取消记录已于 ${fmt(job.reviewedAt)} 复核，并另建补答任务。原记录保留，补答结果请查看对应的新记录。</div>`);
  if(job.partKind==='image')document.querySelector('.modal-body').insertAdjacentHTML('beforeend',`<div class="media-item"><img src="${esc(job.image.url)}" alt="${esc(job.image.name)}"><span>附加图片：${esc(job.image.name)}</span></div>`);
  if(job.messageParts?.length)document.querySelector('.modal-body').insertAdjacentHTML('beforeend',`<section class="media-editor"><strong>后续发送内容</strong>${job.messageParts.map((part,index)=>{const child=state.jobs.find(row=>row.id===job.partJobIds?.[index]);return `<div class="preview-result"><div class="preview-line">${esc(part.kind==='link'?'纯链接':'图片 / 二维码')} ${child?label(child):'<span class="subtle">等待正文发送成功</span>'}</div>${part.kind==='link'?`<div class="content-preview">${esc(part.content)}</div>`:`<div class="media-item"><img src="${esc(part.content)}" alt="${esc(part.image.name)}"><span>${esc(part.image.name)}</span></div>`}</div>`;}).join('')}</section>`);
  if(job.attachmentRetryCount)document.querySelector('.modal-body').insertAdjacentHTML('beforeend',`<p class="small-note">链接 / 图片已尝试 ${job.attachmentRetryCount} 次，${job.status==='queued'?'下次重试 '+fmt(job.nextAttemptAt || Date.now()):'请以上方状态为准'}。纯链接保持原样。</p>`);
  if(job.reviewedCancellationJobId)document.querySelector('.modal-body').insertAdjacentHTML('beforeend','<div class="small-note">此前取消的咨询经核验仍待回复，本次按当前规则补答。</div>');
  if(job.deliveryRetryCount)document.querySelector('.modal-body').insertAdjacentHTML('beforeend',`<div class="small-note" data-delivery-retry>已记录 ${esc(job.deliveryRetryCount)} 次发货失败。${job.status==='queued'?`下次自动重试：${fmt(job.nextAttemptAt||Date.now())}。发送前重新核验订单状态。`:''}</div>`);
  if(job.type==='delivery'&&job.status==='uncertain')document.querySelector('.modal-body').insertAdjacentHTML('beforeend','<div class="small-note">正在持续核验官方消息记录。核实已送达后继续确认发货；等待平台同步并确认未送达后才重试，不会直接重复发送。</div>');
  if(job.type==='delivery'&&typeof job.deliveryWireContent==='string')document.querySelector('.modal-body').insertAdjacentHTML('beforeend',`<details class="small-note"><summary>查看实际发货文本</summary><div class="content-preview">${esc(job.deliveryWireContent)}</div>${job.deliveryDuplicateCount?'<p>原发货内容保留；明确判重后尾部附加时间与消息标记。</p>':''}</details>`);
  if(job.replyRetryCount){
    const stage=job.replyRetryBodySpaces?(job.replyBodySpaceOffsets?.length===3?'配置原文保留，本次发送在汉字间添加3个普通空格，尾部附加当前时间与随机消息标记。':job.replySuffixNote==='no_safe_body_spaces'?'安全位置不足，本次保留原文，使用当前时间与随机消息标记。':'配置原文保留，计划在汉字间添加3个普通空格，保护链接和提取码；尾部附加时间与随机消息标记。'):(job.replyRetryTag?'原正文保留，尾部附加当前时间与随机消息标记。':'原正文保留，尾部尝试附加当前时间。');
    document.querySelector('.modal-body').insertAdjacentHTML('beforeend',`<div class="small-note" data-reply-retry>已记录 ${esc(job.replyRetryCount)} 次重复拒绝。${job.status==='queued'?`正在等待补答，下次计划：${fmt(job.nextAttemptAt||Date.now())}。`:''}${stage}</div>`);
  }
}
async function action(name, target) {
  if(name==='phone-alert-save'){await savePhoneAlertSettings();toast('提醒设置已保存，监听继续运行');return;}
  if(name==='cloud-watchdog-save'){rememberCloudWatchdogDraft();state=await call('cloud-watchdog:save',{...cloudWatchdogDraft,enabled:true});cloudWatchdogDraft=null;render();toast('监护配置已保存，等待云端确认心跳');return;}
  if(name==='cloud-watchdog-disable'){state=await call('cloud-watchdog:disable');cloudWatchdogDraft=null;render();toast('云端已确认停用监护');return;}
  if(name==='phone-alert-test'){await savePhoneAlertSettings();state=await call('phone-alerts:test');render();toast(state.phoneAlerts.test?.status==='accepted'?'推送服务已受理，请查看手机是否收到':state.phoneAlerts.test?.error||'未取得服务受理确认',state.phoneAlerts.test?.status!=='accepted');return;}
  if(name==='phone-alert-setup'){rememberPhoneAlertDraft();return call('phone-alerts:setup',phoneAlertDraft.config.provider);}
  if(name==='phone-alert-clear'){rememberPhoneAlertDraft();phoneAlertDraft.config.enabled=false;state=await call('phone-alerts:save',{config:phoneAlertDraft.config,clearToken:true});phoneAlertDraft=null;render();toast('密钥已清除，手机提醒已关闭');return;}
  if(name==='shared-export') {const result=await call('content:export',{scope:target.dataset.scope});if(!result.cancelled)toast(result.reviewCount?`规则已导出；${result.reviewCount} 项图片或平台规则需单独配置`:'规则已导出');return;}
  if(name==='shared-import') {const result=await call('content:preview',{scope:target.dataset.scope});if(!result.cancelled)showSharedPreview(result);return;}
  if(['shared-merge','shared-replace','shared-refresh'].includes(name)&&sharedPreview) {
    const token=sharedPreview.token,mode=name==='shared-refresh'?sharedPreview.mode:name==='shared-replace'?'replace':'merge';
    const result=await call('content:repreview',{token,mode});
    if(sharedPreview?.token===token)showSharedPreview(result);else api.call('content:cancel',{token:result.token}).catch(()=>{});
    return;
  }
  if(['shared-prev','shared-next'].includes(name)&&sharedPreview) {sharedPage+=name==='shared-prev'?-1:1;showSharedPreview(sharedPreview,false);return;}
  if(name==='shared-apply'&&sharedPreview) {
    const result=await call('content:apply',{token:sharedPreview.token});state=result.state;sharedPreview=null;closeModal();render();toast('已导入并备份原规则，自动处理已关闭');return;
  }
  if(name==='close-modal')return closeModal();
  if(name==='add-image') {
    if (imageDraft.length>=5) return toast('最多可附加 5 张图片',true);
    const currentModal=modal;
    toast('选择图片后将上传至拼多多，请稍候');
    const result=await call('media:add');
    if (modal!==currentModal || result.cancelled) return;
    if (result.preview?.startsWith('data:image/')) imagePreviews.set(result.image.id,result.preview);
    if (!imageDraft.some(image=>image.id===result.image.id)) imageDraft.push(result.image);
    redrawMedia();toast('图片已上传，请保存这条规则');return;
  }
  if(name==='remove-image') {imageDraft.splice(Number(target.dataset.index),1);redrawMedia();return;}
  if(name==='refresh')return refresh(true);
  if(name==='add-product')return editRule('product');
  if(name==='edit-product')return editRule('product',target.dataset.id);
  if(name==='add-reply')return editRule('reply');
  if(name==='edit-reply')return editRule('reply',target.dataset.id);
  if(name==='edit-greeting')return editText('greeting');
  if(name==='edit-fallback')return editText('fallback');
  if(name==='simulate-order')return simulate('order');
  if(name==='simulate-message')return simulate('message');
  if(name==='simulate-refund')return simulate('refund');
  if(name==='nav-settings'){page='settings';sections.settings='runtime';return render();}
  if(name==='check-platform'){
    try {await call('platform:check');await refresh(true);toast('已完成所选功能的只读连接检测');}
    catch(error){if(error.message.includes('滑块验证')){page='shop';browserKind='orders';render();}throw error;}
    return;
  }
  if(name==='job')return jobDetail(target.dataset.id);
  if(name==='open-shop'){page='shop';return render();}
  if(name==='nav-replies'){page='replies';sections.replies='content';return render();}
  if(name==='running'){
    const enable=!state.config.running && !state.autoStart?.pending;
    starting=enable;updateHeader();
    try {await call('running:set',enable);await refresh(true);}
    catch(error){if(error.message.includes('滑块验证')){page='shop';browserKind='orders';render();}throw error;}
    finally {starting=false;updateHeader();}
    return;
  }
  if(name==='save-rule') {
    const form=document.querySelector('#rule-form'); if(!form.reportValidity())return;
    const data=new FormData(form); const type=form.dataset.type; const config=cloneConfig(); const list=type==='product'?'products':'replyRules';
    const previous=config[list].find(r=>r.id===form.dataset.id)||{};
    const row={...previous,id:form.dataset.id,name:data.get('name'),images:structuredClone(imageDraft),keywords:data.get('matchType')==='expression'?String(data.get('keywords')).split(/\r?\n/).map(s=>s.trim()).filter(Boolean):splitKeywords(data.get('keywords')),content:data.get('content'),enabled:data.get('enabled')==='on'};
    if(type==='product')row.matchTarget=data.get('matchTarget');else {row.matchType=data.get('matchType');row.delaySeconds=data.get('delaySeconds')===''?null:Number(data.get('delaySeconds'));row.priority=Number(data.get('priority'));}
    if(type==='product')row.excludeKeywords=splitKeywords(data.get('excludeKeywords')||'');
    const index=config[list].findIndex(r=>r.id===row.id); if(index<0)config[list].push(row);else config[list][index]=row;
    state=await call('config:update',config);closeModal();render();toast('内容已保存在本机');return;
  }
  if(name==='toggle-product'||name==='toggle-reply') {
    const config=cloneConfig();const list=name==='toggle-product'?'products':'replyRules';const row=config[list].find(r=>r.id===target.dataset.id);row.enabled=!row.enabled;state=await call('config:update',config);render();return;
  }
  if(name==='remove-product'||name==='remove-reply') {
    const list=name==='remove-product'?'products':'replyRules'; const row=state.config[list].find(r=>r.id===target.dataset.id);
    openModal('删除这条规则？','历史处理记录与去重账本会保留。',`<p>将删除「${esc(row.name)}」。</p>`,button('保留','close-modal')+button('确认删除','confirm-remove',false,`data-list="${list}" data-id="${esc(row.id)}"`));return;
  }
  if(name==='confirm-remove') {const config=cloneConfig();config[target.dataset.list]=config[target.dataset.list].filter(r=>r.id!==target.dataset.id);state=await call('config:update',config);closeModal();render();toast('规则已删除');return;}
  if(name==='save-text'){const key=document.querySelector('#text-key').value;const config=cloneConfig();config[key]=document.querySelector('#text-value').value;config[key+'Images']=structuredClone(imageDraft);state=await call('config:update',config);closeModal();render();toast('已保存');return;}
  if(name==='edit-delivery-fallback') {
    imageDraft=structuredClone(state.config.deliveryFallbackImages || []);
    openModal('未匹配默认发货','仅在商品名称和 SKU 都未命中时使用。',`<label class="field"><span>默认发货内容</span><textarea id="delivery-fallback-text" rows="7" maxlength="20000">${esc(state.config.deliveryFallback || '')}</textarea></label>${mediaEditor()}<label class="small-note"><input type="checkbox" id="delivery-fallback-enabled" ${state.config.deliveryFallbackEnabled?'checked':''}> 启用未匹配时的默认发货</label><p class="small-note">可填写通用领取说明或网盘链接。文字和图片确认发送成功后，按自动确认发货开关处理。</p>`,button('取消','close-modal')+button('保存','save-delivery-fallback',true));return;
  }
  if(name==='save-delivery-fallback') {
    state=await call('settings:update',{deliveryFallback:document.getElementById('delivery-fallback-text').value,deliveryFallbackEnabled:document.getElementById('delivery-fallback-enabled').checked,deliveryFallbackImages:structuredClone(imageDraft)});
    closeModal();render();toast('默认发货内容已保存；开始监听后生效');return;
  }
  if(name==='run-simulation') {
    const text=document.querySelector('#simulate-text').value.trim();
    const sku=document.querySelector('#simulate-sku')?.value.trim() || '';
    if(!text && !sku){toast('请先输入要预览的内容',true);return;}
    const before=new Set(state.jobs.map(j=>j.id)); const type=target.dataset.type;
    const payload=type==='order'?{title:text,sku,paid:document.querySelector('#simulate-paid').checked}:type==='refund'?{orderId:text}:{text};
    state=await call('simulate:'+type,payload);
    const newJobs=state.jobs.filter(j=>!before.has(j.id));
    document.querySelector('#simulation-result').innerHTML=newJobs.map(job=>`<div class="preview-result"><div class="preview-line">${label(job)}<span class="subtle">${esc(job.matchName||reason(job.reason))}</span></div>${job.reason?`<div class="small-note">${esc(reason(job.reason))}</div>`:''}<div class="content-preview">${esc(job.content||'未生成可发送内容')}</div>${job.type==='delivery' && state.config.autoConfirmShipmentEnabled?'<div class="small-note">真实运行：内容发送成功后，再向平台确认虚拟发货。</div>':''}${job.type==='refund'?'<div class="small-note">真实运行：停止待发货任务 → 查询最新申请 → 同意退款 → 核验平台状态。</div>':''}</div>`).join(''); return;
  }
  if(name==='desktop-alert-test'){await call('desktop-alert:test');return;}
  if(name==='backup'){const r=await call('data:export');if(!r.cancelled)toast('规则备份已导出');return;}
  if(name==='import'){const r=await call('data:import');if(!r.cancelled){state=r;render();toast('规则已导入，自动处理保持关闭');}return;}
  if(name==='data-folder')return call('app:data-folder');
  if(name==='background')return call('app:background');
  if(name==='resolve-job'){state=await call('jobs:resolve',{id:target.dataset.id,resolution:target.dataset.resolution});closeModal();render();toast('已按核实结果结案');return;}
  if(name==='browser-kind'){browserKind=target.dataset.kind;return render();}
  if(name==='browser-reload')return call('browser:reload',browserKind);
  if(name==='browser-home')return call('browser:home',browserKind);
  if(name==='inspect-official'){const result=await call('official:inspect',browserKind);await refresh(true);toast(result.ready?'已完成只读检测':'官方数据尚未完整加载',!result.ready);return;}
  if(name==='save-profile'){
    const next=JSON.parse(JSON.stringify(state.connection.profile));next.shopId=document.querySelector('#shop-id').value;
    document.querySelectorAll('[data-profile-key]').forEach(input=>next[input.dataset.profileSection][input.dataset.profileKey]=input.value);
    state=await call('profile:save',next);render();toast('接入设置已保存');return;
  }
  if(name==='probe-profile'){await call('profile:probe',browserKind);await refresh(true);toast(state.connection.diagnostics[browserKind].message,!state.connection.diagnostics[browserKind].ready);return;}
  if(name==='pick'){
    toast('请在左侧官方页面点击要选择的元素；Esc 取消。');
    const result=await call('profile:pick',{kind:target.dataset.kind,field:target.dataset.field,label:target.dataset.label});
    state=result.state;render();toast(result.cancelled?'已取消选取':'已选取。仍需核对唯一编号与发送回执。');return;
  }
}
document.addEventListener('click',async event=>{
  const navigation=event.target.closest('[data-nav]');
  const section=event.target.closest('[data-section]');
  if(navigation||section){
    const revision=++navigationRevision;
    try {
      if(phoneAlertDraft)rememberPhoneAlertDraft();await flushSettings();if(revision!==navigationRevision)return;
      if(navigation){page=navigation.dataset.nav;filter='';if(defaultSections[page])sections[page]=defaultSections[page];closeModal();}
      else sections[page]=section.dataset.section;
      window.scrollTo(0,0);render();
      if(section)document.getElementById(`${page}-${sections[page]}-tab`)?.focus();
    }catch(error){toast(error.message,true);}return;
  }
  const target=event.target.closest('[data-action]');if(!target||busy)return;
  busy=true;target.disabled=true;
  try {await flushSettings();await action(target.dataset.action,target);}catch(error){if(error.message)toast(error.message,true);}finally{busy=false;if(target.isConnected)target.disabled=false;}
});
document.addEventListener('input',event=>{
  if(page==='settings'&&event.target.closest('[data-cloud-watchdog]')){rememberCloudWatchdogDraft();return;}
  if(page==='settings'&&event.target.closest('[data-phone-alerts]')){rememberPhoneAlertDraft();return;}
  if(event.target.id==='search'){filter=event.target.value;const position=event.target.selectionStart;render();const input=document.querySelector('#search');input.focus();input.setSelectionRange(position,position);return;}
  if(settingKeys.has(event.target.id)){
    rememberSetting(event.target);clearTimeout(settingsTimer);
    if(event.target.checkValidity())settingsTimer=setTimeout(()=>flushSettings().catch(error=>toast(error.message,true)),600);
  }
});
document.addEventListener('change',event=>{
  if(page==='settings'&&event.target.closest('[data-phone-alerts]')){if(event.target.id==='alert-route')document.getElementById('alert-token').value='';rememberPhoneAlertDraft();if(event.target.id==='alert-route')render();return;}
  if(settingKeys.has(event.target.id)){rememberSetting(event.target);flushSettings().catch(error=>toast(error.message,true));}
});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&modal)closeModal();
  const tab=event.target.closest('[role="tab"][data-section]');
  if(!tab||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  event.preventDefault();const tabs=[...tab.parentElement.querySelectorAll('[role="tab"]')],index=tabs.indexOf(tab);
  const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
  tabs[next].click();
});
window.addEventListener('resize',()=>{lastBrowserLayout='';scheduleBrowserLayout();});
window.addEventListener('scroll',scheduleBrowserLayout,true);
if(api){api.onChanged(()=>refresh().catch(()=>{}));refresh(true).catch(error=>document.querySelector('#content').innerHTML=`<div class="inline-error">${esc(error.message)}</div>`);}else document.querySelector('#content').innerHTML='<div class="inline-error">请从本地桌面程序启动工作台。</div>';
