'use strict';
const {contextBridge}=require('electron');

// Capture only the official page's own connection. No cookies, tokens, new
// handshakes, independent socket connections or vendor signing code are used.
function installPddSocketTracker() {
  if(location.origin!=='https://mms.pinduoduo.com'||!location.pathname.startsWith('/chat-merchant/'))return;
  if(globalThis.__localWorkbenchPddSocket)return;
  const Native=globalThis.WebSocket;const entries=new Set();let Wrapped;
  const cleanId=value=>['string','number'].includes(typeof value)?String(value):'';
  Wrapped=new Proxy(Native,{construct(Target,args,newTarget){
    const socket=Reflect.construct(Target,args,newTarget===Wrapped?Target:newTarget);
    let url;try{url=new URL(String(args[0]));}catch{return socket;}
    if(url.protocol!=='wss:'||url.hostname!=='m-ws.pinduoduo.com'||url.pathname!=='/')return socket;
    const entry={socket,authenticated:false,merchantUid:''};entries.add(entry);
    socket.addEventListener('message',event=>{
      if(typeof event.data!=='string')return;
      let data;try{data=JSON.parse(event.data);}catch{return;}
      if(data.response==='auth'){
        // Current official auth receipts use a non-boolean auth value; success is carried
        // by result:'ok' and the authenticated merchant UID, not auth===true.
        entry.authenticated=data.result==='ok'&&data.auth!==false&&!!cleanId(data.uid);
        entry.merchantUid=entry.authenticated?cleanId(data.uid):'';
      }
    });
    socket.addEventListener('close',()=>{entry.authenticated=false;entries.delete(entry);});
    return socket;
  }});
  globalThis.WebSocket=Wrapped;
  const current=merchantUid=>[...entries].reverse().find(entry=>entry.authenticated&&entry.socket.readyState===Native.OPEN&&entry.merchantUid===cleanId(merchantUid));
  const status=merchantUid=>({ready:!!current(merchantUid),channel:'official_m_ws',state:current(merchantUid)?'ready':entries.size?'auth_pending':'disconnected'});
  const sendPacket=(packet,options)=>new Promise((resolve,reject)=>{
    if(globalThis.__localDeliveryRunNonce!==options.runNonce){reject(Error('自动处理已暂停'));return;}
    if(!status(options.merchantUid).ready){reject(Error('官方消息连接尚未认证完成'));return;}
    if(packet?.cmd!=='send_message'||!packet.message||typeof packet.message.content!=='string'||!cleanId(packet.request_id)){reject(Error('官方消息包不完整'));return;}
    const socket=current(options.merchantUid).socket;let done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);socket.removeEventListener('message',received);socket.removeEventListener('close',closed);if(error)reject(error);else resolve(value);};
    const received=event=>{
      if(typeof event.data!=='string')return;let response;try{response=JSON.parse(event.data);}catch{return;}
      if(response.response==='send_message'&&cleanId(response.request_id)===cleanId(packet.request_id))finish(null,response);
    };
    const closed=()=>finish(Error('发送后官方连接断开，结果待核实'));
    const timer=setTimeout(()=>finish(Error('等待官方消息回执超时')),12000);
    socket.addEventListener('message',received);socket.addEventListener('close',closed);
    // These identity fields match the original desktop-web message contract.
    // All risk/signature fields and the text come from the official builder.
    const outgoing={...packet,client:'WEB',message:{...packet.message,msg_id:packet.request_id}};
    try{socket.send(JSON.stringify(outgoing));}catch(error){finish(error);}
  });
  Object.defineProperty(globalThis,'__localWorkbenchPddSocket',{value:Object.freeze({status,sendPacket}),configurable:false});
}

if(contextBridge?.executeInMainWorld)contextBridge.executeInMainWorld({func:installPddSocketTracker});
if(typeof module!=='undefined')module.exports={installPddSocketTracker};
