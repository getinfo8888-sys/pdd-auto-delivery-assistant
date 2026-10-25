'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');
const {installPddSocketTracker}=require('../src/platform/pdd-socket-preload.cjs');
function fixture(){
  const sockets=[];class Socket{
    static OPEN=1;constructor(url){this.url=url;this.readyState=1;this.listeners=new Map();this.sent=[];sockets.push(this);}
    addEventListener(name,fn){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(fn);}
    removeEventListener(name,fn){this.listeners.get(name)?.delete(fn);}
    emit(name,value){for(const fn of [...this.listeners.get(name)||[]])fn(value);}
    send(text){this.sent.push(text);}
  }
  const context={location:{origin:'https://mms.pinduoduo.com',pathname:'/chat-merchant/index.html'},WebSocket:Socket,URL,JSON,Object,Proxy,Reflect,Error,Promise,setTimeout,clearTimeout,__localDeliveryRunNonce:7};
  vm.runInNewContext('('+installPddSocketTracker.toString()+')()',context);const socket=vm.runInNewContext(`new WebSocket('wss://m-ws.pinduoduo.com/')`,context);
  return {context,socket,sockets,bridge:context.__localWorkbenchPddSocket,auth:()=>socket.emit('message',{data:JSON.stringify({response:'auth',result:'ok',auth:null,uid:'merchant'})})};
}
const packet={cmd:'send_message',request_id:10001,message:{to:{uid:'buyer'},from:{role:'mall_cs'},content:'正文  \u200b\u200c',msg_id:'placeholder',hash:'fixture-official-hash'}};
test('socket tracking reuses only the official authenticated merchant connection',async()=>{
  const f=fixture();assert.equal(f.bridge.status('merchant').ready,false);await assert.rejects(f.bridge.sendPacket(packet,{merchantUid:'merchant',runNonce:7}),/认证/);
  f.auth();assert.equal(f.bridge.status('merchant').ready,true);assert.equal(f.bridge.status('other').ready,false);assert.equal(f.sockets.length,1);
});
test('raw socket sends the fully built text and waits for the matching actual server response',async()=>{
  const f=fixture();f.auth();const result=f.bridge.sendPacket(packet,{merchantUid:'merchant',runNonce:7});const outgoing=JSON.parse(f.socket.sent[0]);
  assert.equal(outgoing.message.content,packet.message.content);assert.equal(outgoing.client,'WEB');assert.equal(outgoing.message.msg_id,10001);assert.equal(outgoing.message.hash,packet.message.hash);
  f.socket.emit('message',{data:JSON.stringify({response:'my_push',result:'ok',request_id:10001})});f.socket.emit('message',{data:JSON.stringify({response:'send_message',result:'ok',request_id:999,msg_id:'777'})});
  f.socket.emit('message',{data:JSON.stringify({response:'send_message',result:'ok',request_id:10001,msg_id:'123456'})});assert.equal((await result).msg_id,'123456');
});
test('pausing or a different merchant cannot write to the captured connection',async()=>{
  const f=fixture();f.auth();for(const options of [{merchantUid:'merchant',runNonce:8},{merchantUid:'other',runNonce:7}])await assert.rejects(f.bridge.sendPacket(packet,options));assert.equal(f.socket.sent.length,0);
});
test('a connection lost after sending is uncertain and does not open another socket',async()=>{
  const f=fixture();f.auth();const pending=f.bridge.sendPacket(packet,{merchantUid:'merchant',runNonce:7});f.socket.emit('close');await assert.rejects(pending,/结果待核实/);assert.equal(f.socket.sent.length,1);assert.equal(f.sockets.length,1);assert.equal(f.bridge.status('merchant').ready,false);
});
test('an explicit authentication rejection and unrelated socket hosts cannot enable sending',()=>{
  const f=fixture();f.socket.emit('message',{data:JSON.stringify({response:'auth',result:'ok',auth:false,uid:'merchant'})});assert.equal(f.bridge.status('merchant').ready,false);
  vm.runInNewContext(`new WebSocket('wss://titan-ws.pinduoduo.com/')`,f.context);f.sockets[1].emit('message',{data:JSON.stringify({response:'auth',result:'ok',auth:null,uid:'merchant'})});assert.equal(f.bridge.status('merchant').ready,false);
  f.auth();assert.equal(f.bridge.status('merchant').ready,true);
});
test('an unauthenticated reconnect cannot hide a still-working authenticated socket',()=>{
  const f=fixture();f.auth();vm.runInNewContext(`new WebSocket('wss://m-ws.pinduoduo.com/')`,f.context);
  assert.equal(f.bridge.status('merchant').ready,true);f.socket.emit('close');assert.equal(f.bridge.status('merchant').ready,false);
  f.sockets[1].emit('message',{data:JSON.stringify({response:'auth',result:'ok',uid:'merchant'})});assert.equal(f.bridge.status('merchant').ready,true);
});
