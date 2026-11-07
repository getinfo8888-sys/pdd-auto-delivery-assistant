'use strict';
const {randomUUID}=require('node:crypto');
const code=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(value)?value:null;
class DispatchRecovery {
  constructor({now=Date.now,record=()=>{}}={}){this.now=now;this.record=record;this.fault=null;}
  snapshot(){return this.fault?{active:true,...this.fault}:{active:false};}
  emit(event){try{this.record({event,...this.snapshot()});}catch{/* Logging cannot change the operation's outcome. */}}
  fail(error){
    if(this.fault)return;
    this.fault={id:randomUUID(),startedAt:this.now(),attempts:0};
    Object.assign(this.fault,{retryAt:this.now()+3000,errorCode:code(error?.code),causeCode:code(error?.cause?.code),stage:error?.cause?.persistenceStage||error?.persistenceStage||null});
    this.emit('dispatch_recovery_started');
  }
  recover(checkpoint){
    if(!this.fault||this.now()<this.fault.retryAt)return false;
    try{checkpoint();this.emit('dispatch_recovery_completed');this.fault=null;return true;}
    catch(error){this.fault.attempts++;this.fault.retryAt=this.now()+Math.min(30000,3000*2**Math.min(this.fault.attempts,4));this.fault.causeCode=code(error?.code);this.fault.stage=error?.persistenceStage||null;this.emit('dispatch_recovery_retry');return false;}
  }
}
module.exports={DispatchRecovery};
