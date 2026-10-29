'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
function endpoint(value){
  let url;try{url=new URL(value);}catch{throw Error('请填写云端监护的 HTTPS 地址');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||url.port)throw Error('云端地址必须是 HTTPS 根地址，不能包含密钥、路径或参数');
  if(!url.hostname.endsWith('.workers.dev'))throw Error('请使用已部署的 Cloudflare workers.dev 地址');
  return url.origin;
}
class CloudWatchdog {
  constructor({directory,crypto,fetchImpl=fetch,now=Date.now,changed=()=>{}}){
    this.file=path.join(directory,'cloud-watchdog.json');this.crypto=crypto;this.fetch=fetchImpl;this.now=now;this.changed=changed;this.runId=randomUUID();this.seq=0;this.busy=false;this.disposed=false;this.lastAttempt=-Infinity;this.document={version:1,enabled:false,url:'',secret:null,confirmed:false};
    try{if(fs.existsSync(this.file)){const value=JSON.parse(fs.readFileSync(this.file,'utf8'));if(value.version!==1||typeof value.enabled!=='boolean'||value.url&&endpoint(value.url)!==value.url||value.secret!==null&&typeof value.secret!=='string')throw Error();this.document=value;}}catch{this.error='云端监护配置无法读取，原文件已保留';this.invalid=true;}
  }
  snapshot(){return {enabled:this.document.enabled,ownsMobile:this.document.enabled&&this.document.confirmed===true,url:this.document.url,configured:!!this.document.secret,status:this.status||'idle',error:this.error||null,lastAcceptedAt:this.lastAcceptedAt||null,cloudIncident:this.cloudIncident||null,lastNotification:this.lastNotification||null};}
  record(event){
    const signature=JSON.stringify(event);if(signature===this.lastLog)return;this.lastLog=signature;
    try{const file=path.join(path.dirname(this.file),'cloud-watchdog.jsonl');if(fs.existsSync(file)&&fs.statSync(file).size>1024*1024){fs.copyFileSync(file,file+'.previous');fs.writeFileSync(file,'');}fs.appendFileSync(file,JSON.stringify({at:new Date(this.now()).toISOString(),...event})+'\n');}catch{/* Optional diagnostics must never block customer service. */}
  }
  persist(){fs.mkdirSync(path.dirname(this.file),{recursive:true});const temporary=this.file+'.tmp';fs.writeFileSync(temporary,JSON.stringify(this.document,null,2));fs.renameSync(temporary,this.file);}
  update(input){
    if(this.invalid)throw Error(this.error);
    if(!input||typeof input.enabled!=='boolean')throw Error('云端监护设置无效');
    if(this.busy)throw Error('监护正在提交状态，请稍后保存');
    if(this.document.enabled&&input.enabled===false)throw Error('请先暂停监听，取得云端暂停确认后再关闭监护');
    const previous=structuredClone(this.document),url=input.url?endpoint(input.url):this.document.url;
    if(this.document.enabled&&url!==this.document.url)throw Error('请先停用当前监护再更换地址');
    const token=typeof input.token==='string'?input.token.trim():'';
    if(this.document.enabled&&token)throw Error('请先暂停监听并停用监护，再更换心跳密钥');
    if(token&&!/^[A-Za-z0-9_-]{32,128}$/.test(token))throw Error('请填写32至128位的心跳密钥');
    if(token&&!this.crypto.isEncryptionAvailable())throw Error('本机密钥加密不可用');
    const secret=token?this.crypto.encryptString(token).toString('base64'):this.document.secret;
    if(input.enabled&&(!url||!secret))throw Error('请先配置云端地址和心跳密钥');
    this.document={version:1,enabled:input.enabled,url,secret,confirmed:this.document.confirmed===true&&url===this.document.url&&secret===this.document.secret};
    try{this.persist();}catch{this.document=previous;throw Error('云端监护未能保存，原配置已保留');}
    this.error=null;this.lastAttempt=-Infinity;this.record({event:'configured',enabled:input.enabled});this.changed();return this.snapshot();
  }
  async disable(){
    if(this.invalid)throw Error(this.error);
    if(this.busy)throw Error('监护正在提交状态，请稍后重试');
    if(this.document.enabled){this.lastAttempt=-Infinity;await this.observe({wanted:false,online:true,healthy:false},true);if(this.status!=='paused')throw Error('云端尚未确认暂停，未关闭监护');}
    this.document.enabled=false;this.persist();this.record({event:'disabled_after_ack'});this.changed();return this.snapshot();
  }
  async observe(sample,force=false){
    if(!this.document.enabled||this.disposed||this.invalid||this.busy)return;
    const mode=sample.wanted?(sample.healthy?'healthy':'unhealthy'):'paused';
    if(!force&&mode===this.lastMode&&this.now()-this.lastAttempt<15000)return;
    this.busy=true;this.lastAttempt=this.now();
    this.lastMode=mode;
    const allowed=['offline','login','verification','connection','orders','refunds','stalled'];
    const beat={version:1,runId:this.runId,seq:++this.seq,sentAt:this.now(),mode,reason:mode==='unhealthy'?(allowed.includes(sample.reason)?sample.reason:'connection'):null};
    let httpStatus=null;
    try{
      const token=this.crypto.decryptString(Buffer.from(this.document.secret,'base64'));
      const response=await this.fetch(this.document.url+'/v1/heartbeat',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(beat)});
      httpStatus=Number(response.status)||null;
      const text=await response.text();if(text.length>8192)throw Error();const receipt=JSON.parse(text);
      if(!response.ok||receipt.ok!==true||receipt.version!==1||receipt.acceptedSeq!==beat.seq||receipt.armed!==(mode!=='paused'))throw Error();
      if(mode!=='paused'&&receipt.pushConfigured!==true){this.document.confirmed=false;this.persist();throw Error();}
      if(!this.document.confirmed&&receipt.pushConfigured===true){this.document.confirmed=true;try{this.persist();}catch{this.document.confirmed=false;throw Error();}}
      const notice=value=>value?{id:String(value.id||'').slice(0,64),status:String(value.status||'').slice(0,32),at:Number.isFinite(value.at)?value.at:null}:null;
      this.lastAcceptedAt=this.now();this.status=mode==='paused'?'paused':'connected';this.cloudIncident=notice(receipt.incident);this.lastNotification=notice(receipt.lastNotification);this.error=null;
    }catch{this.status='error';this.error='未取得云端心跳回执；若先前已布防，失联将由云端独立提醒';}
    finally{this.busy=false;this.record({event:'heartbeat_state',mode,status:this.status,httpStatus,notification:(this.cloudIncident||this.lastNotification)?.status||null});this.changed();}
    return this.snapshot();
  }
  dispose(){this.disposed=true;}
}
module.exports={CloudWatchdog,endpoint};
