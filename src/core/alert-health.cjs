'use strict';
function classifyReason(text,kind='chat'){
  if(/扫码|登录已过期|登录失效|请.*登录|账户.*别处|账号.*其他.*登录/.test(text))return 'login';
  if(/滑块|安全验证|验证码/.test(text))return 'verification';
  if(/离线|断网|网络未连接/.test(text))return 'offline';
  return kind==='chat'?'connection':kind;
}
function connectionSample({config,listenIntent=false,startup,bridgeAvailable,diagnostics,capabilities={},online=true,now=Date.now()}){
  const wanted=!!(config.autoReplyEnabled||config.autoDeliveryEnabled||config.autoRefundEnabled)&&!!(config.running||listenIntent||startup?.active);
  const failures=[];
  if(startup?.active&&startup.attempt>0)failures.push({source:'reconnect',id:`${startup.generation}:${startup.attempt}`});
  if(diagnostics.chat?.ready===false&&diagnostics.chat.checkedAt)failures.push({source:'chat',id:String(diagnostics.chat.checkedAt)});
  const chatHealthy=config.running&&bridgeAvailable&&diagnostics.chat?.ready===true&&now-diagnostics.chat.checkedAt<45000;
  if(!online){failures.push({source:'network',id:String(Math.floor(now/15000))});return {wanted,online:false,healthy:false,scope:'chat',reason:'offline',failures};}
  if(config.running&&diagnostics.chat?.ready===true&&!chatHealthy)failures.push({source:'stalled',id:String(Math.floor(now/15000))});
  if(!chatHealthy){failures.push({source:'health:chat',id:String(Math.floor(now/15000))});const startupMessage=startup?.active&&['login','verification','offline','retrying'].includes(startup.state?.phase)?startup.state.message:'';return {wanted,online:true,healthy:false,scope:'chat',reason:classifyReason(startupMessage||diagnostics.chat?.message||''),failures};}
  let reason,scope;
  for(const kind of ['orders','refunds']){
    if(kind==='orders'?!(config.autoDeliveryEnabled||config.autoRefundEnabled&&capabilities.orders?.failures>0):!config.autoRefundEnabled)continue;
    const status=capabilities[kind];if(status?.ready===false&&status.failures>0){failures.push({source:kind,id:String(status.checkedAt)+':'+status.failures});reason ||= classifyReason(status.reason||'',kind);scope ||= kind;}
  }
  if(reason)failures.push({source:'health:'+scope,id:String(Math.floor(now/15000))});
  return {wanted,online:true,healthy:!reason,scope:scope||null,reason:reason||null,failures:reason?failures:[]};
}
module.exports={connectionSample,classifyReason};
