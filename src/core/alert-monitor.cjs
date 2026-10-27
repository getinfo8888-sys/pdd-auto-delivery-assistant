'use strict';
const {randomUUID}=require('node:crypto');
const defaults=Object.freeze({desktopEnabled:true,enabled:false,provider:'serverchan',channel:'wechat',failureSeconds:60,minFailures:3,notifyRecovery:false});
function validateSettings(input={}) {
  const value={...defaults,...input};
  if(typeof value.desktopEnabled!=='boolean'||typeof value.enabled!=='boolean'||typeof value.notifyRecovery!=='boolean'||!['serverchan','pushplus'].includes(value.provider)||!['wechat','sms'].includes(value.channel)||value.provider==='serverchan'&&value.channel!=='wechat')throw Error('异常提醒方式无效');
  if(!Number.isInteger(value.failureSeconds)||value.failureSeconds<30||value.failureSeconds>3600||!Number.isInteger(value.minFailures)||value.minFailures<2||value.minFailures>20)throw Error('持续异常时间需为30至3600秒，失败次数需为2至20次');
  return Object.fromEntries(Object.keys(defaults).map(key=>[key,value[key]]));
}
const categories={login:'商家登录状态失效，请在电脑上重新登录',verification:'平台要求安全验证，请在电脑上完成验证',offline:'电脑网络连接中断',connection:'官方客服连接持续异常',orders:'订单查询或发货连接持续异常',refunds:'售后与自动退款连接持续异常',stalled:'监听未能持续取得正常检测结果'};
function validState(value){
  const plain=row=>row!==null&&typeof row==='object'&&!Array.isArray(row);
  const notice=row=>plain(row)&&typeof row.id==='string'&&typeof row.incidentId==='string'&&['fault','recovered','resolved_before_notification'].includes(row.kind)&&Object.hasOwn(categories,row.reason)&&['serverchan','pushplus'].includes(row.provider)&&['wechat','sms'].includes(row.channel)&&['pending','retrying','submitting','accepted','failed','cancelled'].includes(row.status)&&Number.isInteger(row.attempts)&&row.attempts>=0&&row.attempts<=3&&Number.isFinite(row.startedAt)&&Number.isFinite(row.at)&&Number.isFinite(row.nextAt);
  if(!plain(value)||value.version!==1||typeof value.armed!=='boolean'||!Array.isArray(value.outbox)||value.outbox.length>100||!value.outbox.every(notice)||value.lastNotification!==null&&!notice(value.lastNotification))return false;
  const row=value.incident;return row===null||plain(row)&&typeof row.id==='string'&&Object.hasOwn(categories,row.reason)&&Number.isFinite(row.startedAt)&&Number.isInteger(row.failures)&&row.failures>=0&&plain(row.seenFailures)&&Object.values(row.seenFailures).every(id=>typeof id==='string')&&(row.healthySince===null||Number.isFinite(row.healthySince));
}
class AlertMonitor {
  constructor({state,config,previouslyWorked=false,now=Date.now,persist=()=>{},send,desktop=()=>{},changed=()=>{},log=()=>{}}) {
    this.now=now;this.persist=persist;this.send=send;this.desktop=desktop;this.changed=changed;this.log=log;this.config=validateSettings(config);this.busy=false;this.disposed=false;this.persistenceError=null;
    this.state=validState(state)?structuredClone(state):{version:1,armed:previouslyWorked,incident:null,outbox:[],lastNotification:null};
    for(const event of this.state.outbox)if(event.status==='submitting'){event.status=event.attempts>=3?'failed':'retrying';event.nextAt=this.now()+60000;event.error='上次推送提交结果未确认，将按退避时间核实重试';}
  }
  snapshot(){return {...structuredClone(this.state),busy:this.busy,persistenceError:this.persistenceError};}
  update(config){this.config=validateSettings(config);if(!this.config.enabled)for(const event of this.state.outbox)if(['pending','retrying'].includes(event.status))event.status='cancelled';if(!this.config.desktopEnabled){this.desktop(null);if(this.state.incident)this.state.incident.desktopShownAt=null;}if(!this.config.enabled&&!this.config.desktopEnabled)this.state.incident=null;this.save();}
  save(){try{this.persist(structuredClone(this.state));this.persistenceError=null;this.changed();return true;}catch{this.persistenceError='提醒状态无法保存，已停止提交新推送';this.changed();return false;}}
  queue(incident,kind){
    const event={id:randomUUID(),incidentId:incident.id,kind,reason:incident.reason,startedAt:incident.startedAt,at:this.now(),failures:incident.failures,provider:this.config.provider,channel:this.config.channel,status:'pending',attempts:0,nextAt:this.now()};
    this.state.outbox.push(event);while(this.state.outbox.length>30){const index=this.state.outbox.findIndex(row=>['accepted','failed','cancelled'].includes(row.status));if(index<0)break;this.state.outbox.splice(index,1);}
    this.log('alert_queued',{kind,incidentId:incident.id,reason:incident.reason});return event;
  }
  observe(sample) {
    this.sample=sample;if(this.disposed)return;
    if(!sample.wanted){if(this.state.incident){this.desktop(null);this.state.incident=null;for(const event of this.state.outbox)if(['pending','retrying'].includes(event.status))event.status='cancelled';this.save();}return;}
    if(!this.config.enabled&&!this.config.desktopEnabled)return;
    const now=this.now();let dirty=false;
    if(sample.healthy){
      if(!this.state.armed){this.state.armed=true;dirty=true;}
      const incident=this.state.incident;
      if(incident){
        if(incident.healthySince===null){incident.healthySince=now;dirty=true;}
        if(now-incident.healthySince>=60000){
          const alert=this.state.outbox.find(row=>row.id===incident.alertId);
          if(alert&&['pending','retrying'].includes(alert.status))alert.status='cancelled';
          if(this.config.enabled){if(alert?.status==='accepted'&&this.config.notifyRecovery)this.queue(incident,'recovered');else if(alert&&alert.status!=='accepted'&&alert.status!=='submitting')this.queue(incident,'resolved_before_notification');}
          this.desktop(null);this.state.incident=null;this.log('alert_recovered',{incidentId:incident.id});dirty=true;
        }
      }
    }else if(this.state.armed){
      // A prior order-only warning must never silence a subsequent loss of chat.
      if(this.state.incident?.scope&&this.state.incident.scope!=='chat'&&sample.scope==='chat'){
        for(const event of this.state.outbox)if(event.incidentId===this.state.incident.id&&['pending','retrying'].includes(event.status))event.status='cancelled';
        this.desktop(null);this.state.incident=null;
      }
      if(!this.state.incident){this.state.incident={id:randomUUID(),startedAt:now,scope:sample.scope||'chat',reason:sample.reason in categories?sample.reason:'connection',failures:0,seenFailures:{},healthySince:null,alertId:null,desktopShownAt:null};dirty=true;this.log('alert_incident_started',{reason:this.state.incident.reason});}
      const incident=this.state.incident;if(incident.healthySince!==null){incident.healthySince=null;dirty=true;}
      if(sample.reason in categories&&incident.reason!==sample.reason){incident.reason=sample.reason;dirty=true;}
      for(const failure of sample.failures||[])if(typeof failure.source==='string'&&typeof failure.id==='string'&&incident.seenFailures[failure.source]!==failure.id){incident.seenFailures[failure.source]=failure.id;incident.failures++;dirty=true;}
      if(incident.failures>=this.config.minFailures&&now-incident.startedAt>=this.config.failureSeconds*1000){
        if(this.config.desktopEnabled&&incident.desktopShownAt==null){this.desktop({id:incident.id,startedAt:incident.startedAt,reason:categories[incident.reason],failures:incident.failures});incident.desktopShownAt=now;this.log('desktop_alert_shown',{incidentId:incident.id});dirty=true;}
        if(this.config.enabled&&!incident.alertId){incident.alertId=this.queue(incident,'fault').id;dirty=true;}
      }
    }
    if(dirty)this.save();
    if(sample.online)void this.flush();
  }
  async flush(){
    if(this.busy||this.disposed||!this.config.enabled||!this.sample?.wanted||!this.sample.online)return;
    const event=this.state.outbox.find(row=>['pending','retrying'].includes(row.status)&&row.nextAt<=this.now());if(!event)return;
    if(event.kind==='fault'&&this.state.incident?.id===event.incidentId&&this.state.incident.healthySince!==null)return;
    if(event.provider!==this.config.provider||event.channel!==this.config.channel){event.status='cancelled';this.save();return;}
    this.busy=true;event.status='submitting';event.attempts++;event.lastAttemptAt=this.now();
    if(!this.save()){event.status='retrying';event.nextAt=this.now()+60000;this.busy=false;return;}
    try{
      const result=await this.send(this.message(event),event);
      if(result?.accepted!==true)throw Error('推送服务未确认受理');
      event.status='accepted';event.acceptedAt=this.now();event.receiptId=result.receiptId||'';delete event.error;
      this.log('alert_accepted',{kind:event.kind,incidentId:event.incidentId});
    }catch(error){
      event.status=event.attempts>=3?'failed':'retrying';event.nextAt=this.now()+[30000,120000,300000][Math.min(event.attempts-1,2)];
      event.error=error?.safeMessage||'手机提醒未取得服务受理确认，请检查通知设置与网络';
      this.log('alert_submit_failed',{kind:event.kind,incidentId:event.incidentId,attempts:event.attempts});
    }finally{this.busy=false;this.state.lastNotification={...event};this.save();}
  }
  message(event){
    const recovered=event.kind!=='fault';
    const started=new Date(event.startedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
    return {title:recovered?'拼多多助手：监听已恢复':'拼多多助手：异常需要处理',content:[recovered?'助手已稳定恢复正常检测。':'助手持续异常，自动恢复尚未成功。',`异常开始：${started}`,`检测失败：${event.failures} 次`,`异常类型：${categories[event.reason]||categories.connection}`,event.kind==='resolved_before_notification'?'异常期间未能及时提交提醒，恢复后补充通知。':recovered?'后续会按既定规则继续工作。':'请打开电脑上的拼多多自动发货助手，检查登录、网络或安全验证。'].join('\n')};
  }
  dispose(){this.disposed=true;this.desktop(null);}
}
module.exports={AlertMonitor,validateSettings,defaults,categories,validState};
