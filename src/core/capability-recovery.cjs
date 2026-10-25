'use strict';

// Availability belongs to a capability, not to the surrounding browser tab.
class CapabilityRecovery {
  constructor({now=Date.now,intervals={orders:10000,refunds:3000},retryBase=5000,retryMax=60000,verificationDelay=30000}={}) {
    this.now=now;this.intervals=intervals;this.retryBase=retryBase;this.retryMax=retryMax;this.verificationDelay=verificationDelay;this.rows={};
  }
  reset(){this.rows={};}
  state(kind){return this.rows[kind] || {ready:false,failures:0,retryAt:0};}
  due(kind){return this.now()>=this.state(kind).retryAt;}
  success(kind,{hasMore=false}={}) {
    return this.rows[kind]={ready:true,failures:0,checkedAt:this.now(),retryAt:this.now()+(hasMore?Math.min(3000,this.intervals[kind]):this.intervals[kind])};
  }
  failure(kind,error) {
    const failures=this.state(kind).failures+1;
    const reason=String(error?.message || error || '官方功能暂不可用');
    const verification=/滑块|安全验证|验证码/.test(reason);
    const delay=verification?this.verificationDelay:Math.min(this.retryMax,this.retryBase*2**Math.min(failures-1,5));
    return this.rows[kind]={ready:false,failures,reason,verification,checkedAt:this.now(),retryAt:this.now()+delay};
  }
  excludedTypes({chatReady,collectingReplies=false}) {
    if(!chatReady)return ['reply','delivery','shipment','refund'];
    return [...(!this.state('orders').ready?['delivery','shipment']:[]),...(!this.state('refunds').ready?['refund']:[]),...(collectingReplies?['reply']:[])];
  }
}
function pageRefreshDecision({kind,visibleKind,healthy,status={},recoveryRequested=false}) {
  if(status.login)return 'login_preserved';
  if(status.verification)return 'verification_preserved';
  if(status.hasDraft)return 'draft_preserved';
  if(kind===visibleKind)return 'refresh';
  if(kind==='chat'&&(!healthy||recoveryRequested))return 'refresh';
  return 'background_preserved';
}
module.exports={CapabilityRecovery,pageRefreshDecision};
