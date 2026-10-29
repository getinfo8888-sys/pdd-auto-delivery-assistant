'use strict';
// Test-only state machine. Reading cloud status must not renew its heartbeat.
class PreviewController {
  constructor({client,changed=()=>{},now=Date.now,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){this.client=client;this.changed=changed;this.now=now;this.wait=wait;this.mode='paused';this.busy=false;this.error=null;this.simulation=null;}
  snapshot(){
    const s=this.client.snapshot(),notice=s.cloudIncident||s.lastNotification;
    const current=this.simulation&&notice?.id!==this.simulation.previousNoticeId?notice:null;
    const phase=this.mode==='arming'?'arming':this.mode!=='offline'?this.mode:current?.status==='accepted'?'notified':['failed','uncertain'].includes(current?.status)?'failed':'waiting';
    return {sampleMode:this.mode,phase,controllerError:this.error,remainingSeconds:this.simulation?Math.max(0,Math.ceil((this.simulation.deadline-this.now())/1000)):null,currentNotice:current};
  }
  sample(){return {wanted:this.mode!=='paused',healthy:this.mode==='healthy',online:true,reason:this.mode==='login'?'login':null};}
  async idle(){const deadline=this.now()+15000;while(this.client.busy||this.client.inspecting){if(this.now()>=deadline)throw Error('上一条心跳或状态查询尚未结束，请稍后重试');await this.wait(50);}}
  async select(value){
    if(!['healthy','login','offline','paused'].includes(value))throw Error('无效的样本');
    if(this.busy)throw Error('测试状态正在切换，请稍后再试');
    if(value==='offline'&&this.mode==='offline')return this.snapshot();
    this.busy=true;this.error=null;
    const before=this.mode;
    try{
      await this.idle();
      if(!this.client.snapshot().enabled)throw Error('请先保存并启用测试监护');
      if(value==='offline'){
        this.mode='arming';this.changed();
        // Even a direct click from paused must first receive a real armed ack.
        await this.client.observe({wanted:true,healthy:true,online:true},true);
        const armed=this.client.snapshot();
        if(armed.status!=='connected'||!armed.ownsMobile||!armed.lastAcceptedAt)throw Error('云端尚未确认开始监护，模拟断网没有开始；请检查网络和配置后重试');
        if(armed.cloudIncident){this.mode='healthy';throw Error('上一轮异常尚未结束；已恢复正常样本，请稳定运行一分钟后再模拟断网');}
        this.simulation={deadline:armed.lastAcceptedAt+60000,previousNoticeId:armed.lastNotification?.id||null};
        this.mode='offline';
      }else{
        this.mode=value;this.simulation=null;
        await this.client.observe(this.sample(),true);
        if(this.client.snapshot().status!==(value==='paused'?'paused':'connected'))throw Error(value==='paused'?'云端未确认暂停，请检查连接后重试':'云端尚未确认样本，请检查连接后重试');
      }
      return this.snapshot();
    }catch(error){if(this.mode==='arming')this.mode=before;this.error=error.message;throw error;}
    finally{this.busy=false;this.changed();}
  }
  async pulse(){
    if(this.busy)return;
    if(this.mode==='offline'){await this.client.peek();return;}
    await this.client.observe(this.sample());
  }
  async disable(){await this.select('paused');await this.client.disable();this.changed();}
}
module.exports={PreviewController};
