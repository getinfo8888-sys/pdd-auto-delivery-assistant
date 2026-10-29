// One private monitor per deployment. Never put secrets in this file or URLs.
export const GAP = 60_000;
const STABLE = 60_000;
const reasons = new Set(['offline','login','verification','connection','orders','refunds','stalled']);
const descriptions = {offline:'电脑断网、休眠或程序停止报平安',login:'商家登录失效',verification:'平台要求安全验证',connection:'客服连接持续异常',orders:'订单连接持续异常',refunds:'售后连接持续异常',stalled:'监听检测未能持续更新'};
const empty = () => ({version:1,armed:false,lastSeen:0,lastSentAt:0,runId:null,seq:-1,mode:'paused',healthySince:null,incident:null,lastNotification:null,daily:{day:'',attempts:0}});
const reply = (data,status=200) => Response.json(data,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
export function validateBeat(value,now) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['version','runId','seq','sentAt','mode','reason'].includes(k)))throw Error('invalid');
  if(value.version!==1||!/^[-a-zA-Z0-9]{16,64}$/.test(value.runId)||!Number.isSafeInteger(value.seq)||value.seq<0||!Number.isFinite(value.sentAt)||Math.abs(now-value.sentAt)>120_000||!['healthy','unhealthy','paused'].includes(value.mode))throw Error('invalid');
  if(value.mode==='unhealthy'&&!reasons.has(value.reason)||value.mode!=='unhealthy'&&value.reason!==null)throw Error('invalid');
  return value;
}
export function acceptBeat(previous,beat,now) {
  const s=structuredClone(previous);
  if(s.lastSeen&&(beat.runId===s.runId?beat.seq<=s.seq||beat.sentAt<s.lastSentAt:beat.sentAt<=s.lastSentAt))return null;
  s.runId=beat.runId;s.seq=beat.seq;s.lastSentAt=beat.sentAt;s.lastSeen=now;s.mode=beat.mode;
  if(beat.mode==='paused'){s.armed=false;s.incident=null;s.healthySince=null;return s;}
  s.armed=true;
  if(beat.mode==='healthy'){
    if(s.healthySince===null)s.healthySince=now;
    if(s.incident&&now-s.healthySince>=STABLE)s.incident=null;
  }else{
    s.healthySince=null;
    if(!s.incident)s.incident={id:crypto.randomUUID(),startedAt:now,reason:beat.reason,status:'pending',attempts:0,nextAt:now+GAP};
    else s.incident.reason=beat.reason;
  }
  return s;
}
export function inspectDue(previous,now) {
  const s=structuredClone(previous);
  if(!s.armed)return s;
  if(now-s.lastSeen>=GAP){
    s.healthySince=null;
    if(!s.incident)s.incident={id:crypto.randomUUID(),startedAt:s.lastSeen,reason:'offline',status:'pending',attempts:0,nextAt:s.lastSeen+GAP};
    else s.incident.reason='offline';
  }
  if(s.incident&&s.healthySince!==null&&now-s.healthySince>=STABLE)s.incident=null;
  return s;
}
export function nextAlarm(s,now) {
  if(!s.armed)return null;
  const times=[];
  if(now-s.lastSeen<GAP)times.push(s.lastSeen+GAP);
  if(s.incident&&s.healthySince!==null)times.push(s.healthySince+STABLE);
  if(s.incident&&s.healthySince===null&&['pending','retrying'].includes(s.incident.status))times.push(s.incident.nextAt);
  return times.length?Math.max(now+1,Math.min(...times)):null;
}
export async function authorized(request,secret) {
  if(typeof secret!=='string'||secret.length<32)return false;
  const given=request.headers.get('authorization')||'';
  if(given.length>256)return false;
  const digest=async v=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v)));
  const [a,b]=await Promise.all([digest(given),digest('Bearer '+secret)]);
  let difference=0;for(let i=0;i<a.length;i++)difference|=a[i]^b[i];return difference===0;
}
export async function notify(env,incident,fetchImpl=fetch) {
  const key=env.SERVERCHAN_SENDKEY;
  if(!/^SCT[A-Za-z0-9]{12,220}$/.test(key||''))return {status:'failed',error:'推送密钥未配置'};
  const started=new Date(incident.startedAt).toISOString();
  let response;
  try{response=await fetchImpl(`https://sctapi.ftqq.com/${key}.send`,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(10000),headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({title:'拼多多助手：云端发现持续异常',desp:`异常类型：${descriptions[incident.reason]}\n异常开始（UTC）：${started}\n云端已超过一分钟未取得正常运行状态，请检查电脑网络、登录和助手。\n事件编号：${incident.id}`,noip:'1'})});}
  catch(error){return {status:'uncertain',stage:'request',errorType:['TypeError','TimeoutError','AbortError'].includes(error?.name)?error.name:'Error',error:'推送请求未取得回执，不能确认是否已受理；为避免重复不自动重发'};}
  if(response.status>=300&&response.status<400)return {status:'failed',httpStatus:response.status,error:'推送服务要求重定向，已停止，不会把密钥转发到其他地址'};
  let data;
  try{const text=await response.text();if(text.length>32768)throw Error();data=JSON.parse(text);}catch{return {status:'uncertain',stage:'response',httpStatus:response.status,error:'推送回执无法核验'};}
  if(response.ok&&data.code===0&&(data.data?.errno===undefined||data.data.errno===0)&&data.data?.pushid)return {status:'accepted',receiptId:String(data.data.pushid)};
  // Only a definite rejection is safe to retry without duplicate delivery.
  if(data.code!==undefined&&data.code!==0)return {status:'retrying',httpStatus:response.status,providerCode:Number(data.code)||null,error:'推送服务明确拒绝，等待重试'};
  return {status:'uncertain',stage:'receipt',httpStatus:response.status,error:'未取得完整受理回执'};
}
export class Watchdog {
  constructor(ctx,env){this.ctx=ctx;this.env=env;}
  async save(s,now){await this.ctx.storage.put('monitor',s);const at=nextAlarm(s,now);if(at===null)await this.ctx.storage.deleteAlarm();else await this.ctx.storage.setAlarm(at);}
  async fetch(request){
    return this.ctx.blockConcurrencyWhile(async()=>{
      const now=Date.now(),url=new URL(request.url);
      const admin=['/v1/status','/v1/probe'].includes(url.pathname);
      if(!await authorized(request,admin?this.env.ADMIN_TOKEN:this.env.HEARTBEAT_TOKEN))return reply({error:'unauthorized'},401);
      const s=await this.ctx.storage.get('monitor')||empty();
      if(url.pathname==='/v1/state'&&request.method==='GET'){
        const notice=value=>value?{id:value.id,status:value.status,at:value.at||value.startedAt}:null;
        return reply({ok:true,version:1,armed:s.armed,incident:notice(s.incident),lastNotification:notice(s.lastNotification)});
      }
      if(url.pathname==='/v1/status'&&request.method==='GET')return reply({ok:true,version:1,armed:s.armed,lastSeen:s.lastSeen,mode:s.mode,incident:s.incident,lastNotification:s.lastNotification||null,daily:s.daily});
      if(url.pathname==='/v1/probe'&&request.method==='GET'){
        let service;try{const response=await fetch('https://sctapi.ftqq.com/',{redirect:'manual',signal:AbortSignal.timeout(10000)});service={httpStatus:response.status,redirected:response.status>=300&&response.status<400};}catch(error){service={failed:true,errorType:['TypeError','TimeoutError','AbortError'].includes(error?.name)?error.name:'Error'};}
        return reply({ok:true,timeoutSupported:typeof AbortSignal.timeout==='function',service});
      }
      if(url.pathname!=='/v1/heartbeat'||request.method!=='POST')return reply({error:'not_found'},404);
      if(!request.headers.get('content-type')?.startsWith('application/json'))return reply({error:'content_type'},415);
      let beat;try{const body=await request.text();if(body.length>2048)throw Error();beat=validateBeat(JSON.parse(body),now);}catch{return reply({error:'invalid_heartbeat'},400);}
      const updated=acceptBeat(s,beat,now);if(!updated)return reply({error:'stale_heartbeat'},409);
      await this.save(updated,now);
      const notice=value=>value?{id:value.id,status:value.status,at:value.at||value.startedAt}:null;
      return reply({ok:true,version:1,acceptedSeq:beat.seq,serverTime:now,armed:updated.armed,pushConfigured:/^SCT[A-Za-z0-9]{12,220}$/.test(this.env.SERVERCHAN_SENDKEY||''),incident:notice(updated.incident),lastNotification:notice(updated.lastNotification)});
    });
  }
  async alarm(){
    return this.ctx.blockConcurrencyWhile(async()=>{
      const now=Date.now(),s=inspectDue(await this.ctx.storage.get('monitor')||empty(),now);
      const incident=s.incident;
      // A crash after submission is ambiguous; never assume success or resend it.
      if(incident?.status==='submitting'){incident.status='uncertain';incident.error='上次提交结果未确认，请检查推送服务';}
      if(incident&&s.healthySince===null&&['pending','retrying'].includes(incident.status)&&incident.nextAt<=now){
        const day=new Date(now+8*3600000).toISOString().slice(0,10);
        if(s.daily.day!==day)s.daily={day,attempts:0};
        if(s.daily.attempts>=5){incident.status='failed';incident.error='本监护当日已提交5次，停止重复请求';}
        else if(!this.env.SERVERCHAN_SENDKEY){incident.status='failed';incident.error='推送密钥未配置';}
        else{
          incident.status='submitting';incident.attempts++;s.daily.attempts++;
          await this.save(s,now);
          const result=await notify(this.env,incident);Object.assign(incident,result);
          if(result.status==='retrying'){
            if(incident.attempts>=3)incident.status='failed';else incident.nextAt=Date.now()+120_000;
          }
        }
      }
      if(incident&&['accepted','retrying','uncertain','failed'].includes(incident.status))s.lastNotification={...structuredClone(incident),at:Date.now()};
      await this.save(s,Date.now());
    });
  }
}
export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==='/health'&&request.method==='GET')return reply({ok:true,service:'pdd-assistant-watchdog',version:1});
    if(!['/v1/heartbeat','/v1/state','/v1/status','/v1/probe'].includes(url.pathname))return reply({error:'not_found'},404);
    // Check credentials before instantiating the object, limiting unauthenticated work.
    if(!await authorized(request,['/v1/heartbeat','/v1/state'].includes(url.pathname)?env.HEARTBEAT_TOKEN:env.ADMIN_TOKEN))return reply({error:'unauthorized'},401);
    return env.WATCHDOG.get(env.WATCHDOG.idFromName('single-monitor-v1')).fetch(request);
  }
};
