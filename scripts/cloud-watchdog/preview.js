'use strict';
const api=window.cloudPreview,$=id=>document.getElementById(id);
const modes={paused:'主动暂停',healthy:'正常样本',offline:'停止心跳（模拟断网）',login:'登录失效样本'};
const statuses={idle:'尚未连接',paused:'云端已确认暂停',connected:'云端已确认心跳',error:'未取得云端心跳回执'};
const incidentStatuses={pending:'等待持续异常达到一分钟',retrying:'明确拒绝后等待重试',accepted:'推送服务已受理',uncertain:'提交结果未确认',failed:'未受理，请检查云端配置或额度',submitting:'正在提交'};
let busy=false,initialized=false;
async function refresh(){const state=await api.call('snapshot');if(!initialized){$('url').value=state.url;initialized=true;}$('status').textContent=(state.enabled?'测试监护已启用 · ':'测试监护未启用 · ')+(statuses[state.status]||state.status);$('error').textContent=state.error||'';$('mode').textContent=modes[state.sampleMode];$('accepted').textContent=state.lastAcceptedAt?new Date(state.lastAcceptedAt).toLocaleString():'尚无确认';const notice=state.cloudIncident||state.lastNotification;$('incident').textContent=notice?incidentStatuses[notice.status]||notice.status:'没有云端故障回执';}
async function perform(action){if(busy)return;busy=true;document.querySelectorAll('button').forEach(el=>{el.disabled=true;});try{await action();$('token').value='';await refresh();}catch(error){$('error').textContent=error.message;}finally{busy=false;document.querySelectorAll('button').forEach(el=>{el.disabled=false;});}}
$('save').addEventListener('click',()=>perform(()=>api.call('save',{url:$('url').value,token:$('token').value})));
$('disable').addEventListener('click',()=>perform(()=>api.call('disable')));
document.querySelectorAll('[data-mode]').forEach(button=>button.addEventListener('click',()=>perform(()=>api.call('mode',button.dataset.mode))));
api.onChanged(()=>refresh().catch(()=>{}));refresh().catch(error=>{$('error').textContent=error.message;});
