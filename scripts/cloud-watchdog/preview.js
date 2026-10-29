'use strict';
const api=window.cloudPreview,$=id=>document.getElementById(id);
const modes={paused:'主动暂停',healthy:'正常样本',offline:'停止心跳（模拟断网）',login:'登录失效样本',arming:'正在确认云端开始监护'};
const statuses={idle:'尚未连接',paused:'云端已确认暂停',connected:'云端已确认心跳',error:'未取得云端心跳回执'};
const incidentStatuses={pending:'等待持续异常达到一分钟',retrying:'明确拒绝后等待重试',accepted:'推送服务已受理',uncertain:'提交结果未确认',failed:'未受理，请检查云端配置或额度',submitting:'正在提交'};
let busy=false,initialized=false;
async function refresh(){
  const state=await api.call('snapshot');if(!initialized){$('url').value=state.url;initialized=true;}
  $('status').textContent=state.sampleMode==='offline'?'测试心跳已停止，云端独立检测中':(state.enabled?'测试监护已启用 · ':'测试监护未启用 · ')+(statuses[state.status]||state.status);
  $('error').textContent=state.controllerError||state.inspectionError||state.error||'';$('mode').textContent=modes[state.sampleMode];$('accepted').textContent=state.lastAcceptedAt?new Date(state.lastAcceptedAt).toLocaleString():'尚无确认';
  const notice=state.currentNotice||state.cloudIncident||state.lastNotification;$('incident-label').textContent=state.currentNotice?'本次失联提醒':'最近云端提醒';$('incident').textContent=notice?incidentStatuses[notice.status]||notice.status:'暂无提醒记录';
  $('countdown').textContent=state.phase==='arming'?'正在向云端确认监护，确认成功后才开始模拟断网':state.phase==='waiting'?(state.remainingSeconds>0?`距离失联检测约 ${state.remainingSeconds} 秒`:'失联检测时间已到，等待云端提交和推送回执'):state.phase==='notified'?'本次失联提醒已被推送服务受理':state.phase==='failed'?'本次提醒未确认成功，请查看云端配置、网络或额度':state.sampleMode==='paused'?'主动暂停中，不会触发失联提醒':'';
}
async function perform(action){if(busy)return;busy=true;document.querySelectorAll('button').forEach(el=>{el.disabled=true;});try{await action();$('token').value='';await refresh();}catch(error){$('error').textContent=error.message;}finally{busy=false;document.querySelectorAll('button').forEach(el=>{el.disabled=false;});}}
$('save').addEventListener('click',()=>perform(()=>api.call('save',{url:$('url').value,token:$('token').value})));
$('disable').addEventListener('click',()=>perform(()=>api.call('disable')));
document.querySelectorAll('[data-mode]').forEach(button=>button.addEventListener('click',()=>perform(()=>api.call('mode',button.dataset.mode))));
api.onChanged(()=>refresh().catch(()=>{}));setInterval(()=>refresh().catch(()=>{}),1000);refresh().catch(error=>{$('error').textContent=error.message;});
