'use strict';
window.desktopAlert.onNotice(value=>{
  document.getElementById('reason').textContent=String(value.reason||'自动恢复尚未成功，请检查助手。');
  const started=new Date(value.startedAt).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
  document.getElementById('detail').textContent='异常开始 '+started+' · 已记录 '+value.failures+' 次检测失败';
});
document.getElementById('open').addEventListener('click',()=>window.desktopAlert.open());
for(const id of ['dismiss','later'])document.getElementById(id).addEventListener('click',()=>window.desktopAlert.dismiss());
