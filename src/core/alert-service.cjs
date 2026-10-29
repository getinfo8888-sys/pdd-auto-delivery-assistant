'use strict';
const fs=require('node:fs'),path=require('node:path');
const {AlertMonitor,validateSettings,defaults,validState}=require('./alert-monitor.cjs');
const {sendAlert,validateToken}=require('./alert-transport.cjs');
class AlertService {
  constructor({directory,crypto,fetchImpl,previouslyWorked=false,now=Date.now,changed=()=>{},sendOverride,desktop,log=()=>{}}){
    this.directory=directory;this.file=path.join(directory,'phone-alerts.json');this.crypto=crypto;this.fetchImpl=fetchImpl;this.now=now;this.changed=changed;this.sendOverride=sendOverride;this.lastTestAt=-Infinity;
    this.document={version:1,config:{...defaults},secrets:{}};
    try{if(fs.existsSync(this.file)){const stored=JSON.parse(fs.readFileSync(this.file,'utf8'));if(stored.version!==1||!stored.secrets||typeof stored.secrets!=='object'||stored.monitor!==undefined&&!validState(stored.monitor))throw Error();stored.config=validateSettings(stored.config);this.document=stored;}}catch{this.settingsError='手机提醒配置无法读取，原文件已保留；正常业务继续运行';}
    this.lastTestAt=this.document.lastTest?.at??-Infinity;
    this.monitor=new AlertMonitor({state:this.document.monitor,config:this.document.config,previouslyWorked,now,persist:state=>{this.document.monitor=state;this.persist();},send:(message,event)=>this.deliver(message,event),desktop,changed,log:(event,fields)=>{try{const file=path.join(directory,'phone-alerts.jsonl');if(fs.existsSync(file)&&fs.statSync(file).size>1024*1024){fs.copyFileSync(file,file+'.previous');fs.writeFileSync(file,'');}fs.appendFileSync(file,JSON.stringify({at:new Date(now()).toISOString(),event,...fields})+'\n');}catch{}log(event,fields);}});
  }
  persist(){fs.mkdirSync(this.directory,{recursive:true});const temp=this.file+'.tmp',fd=fs.openSync(temp,'w');try{fs.writeFileSync(fd,JSON.stringify(this.document,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}if(fs.existsSync(this.file))fs.copyFileSync(this.file,this.file+'.backup');fs.renameSync(temp,this.file);}
  snapshot(){return {config:{...this.document.config},credentials:{serverchan:!!this.document.secrets.serverchan,pushplus:!!this.document.secrets.pushplus},encryptionAvailable:this.crypto.isEncryptionAvailable(),settingsError:this.settingsError||null,runtimeError:this.runtimeError||null,monitor:this.monitor.snapshot(),test:this.document.lastTest||null};}
  update(input){
    if(!input||typeof input!=='object')throw Error('提醒设置无效');
    const config=validateSettings(input.config);let encrypted;
    if(input.token){if(!this.crypto.isEncryptionAvailable())throw Error('本机密钥加密暂不可用，未保存密钥');const token=validateToken(config.provider,input.token);encrypted=this.crypto.encryptString(token).toString('base64');}
    if(config.enabled&&!encrypted&&!this.document.secrets[config.provider])throw Error('请先填写并保存该服务的推送密钥');
    const previous=structuredClone(this.document);
    if(encrypted)this.document.secrets[config.provider]=encrypted;
    if(input.clearToken===true){delete this.document.secrets[config.provider];config.enabled=false;}
    this.document.config=config;
    try{this.persist();}catch{this.document=previous;throw Error('手机提醒设置未能保存，原设置已保留');}
    this.settingsError=null;this.monitor.update({...config,enabled:config.enabled&&!this.remoteOwner});return this.snapshot();
  }
  async deliver(message,event){
    if(this.sendOverride)return this.sendOverride(message,event);
    const provider=event.provider,encrypted=this.document.secrets[provider];if(!encrypted)throw Error('推送密钥尚未配置');
    let token;try{token=this.crypto.decryptString(Buffer.from(encrypted,'base64'));}catch{const error=Error('本机推送密钥无法解密，请重新填写');error.safeMessage=error.message;throw error;}
    return sendAlert({provider,channel:event.channel,token,message,fetchImpl:this.fetchImpl});
  }
  async test(){
    if(this.now()-this.lastTestAt<60000)throw Error('请间隔一分钟后再发送测试提醒');
    const {provider,channel}=this.document.config;if(!this.document.secrets[provider])throw Error('请先保存该服务的推送密钥');
    this.lastTestAt=this.now();this.document.lastTest={status:'submitting',at:this.now()};this.persist();this.changed();
    try{const result=await this.deliver({title:'拼多多助手：手机提醒测试',content:'这是一条手机提醒测试。正式运行时，将在持续异常且自动恢复失败后提醒你。'},{provider,channel});if(result?.accepted!==true)throw Error();this.document.lastTest={status:'accepted',at:this.now(),receiptId:result.receiptId||''};}
    catch(error){this.document.lastTest={status:'failed',at:this.now(),error:error.safeMessage||'测试提醒未取得服务受理确认，请检查通知设置与网络'};}
    this.persist();this.changed();return this.snapshot();
  }
  setRemoteOwner(value){if(this.remoteOwner===value)return;this.remoteOwner=value;this.monitor.update({...this.document.config,enabled:this.document.config.enabled&&!value});}
  observe(sample){try{this.monitor.observe(sample);if(this.runtimeError){this.runtimeError=null;this.changed();}}catch{this.reportError();}}
  reportError(){if(this.runtimeError)return;this.runtimeError='异常提醒检测暂时失败，将继续重试；请查看助手连接状态';this.monitor.log('alert_monitor_failed',{});this.changed();}
  dispose(){this.monitor.dispose();}
}
module.exports={AlertService};
