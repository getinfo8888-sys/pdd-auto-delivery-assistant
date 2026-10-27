'use strict';
function validateToken(provider,value){
  const token=typeof value==='string'?value.trim():'';
  if(provider==='serverchan'?!/^SCT[A-Za-z0-9]{12,220}$/.test(token):!/^[A-Fa-f0-9]{32}$/.test(token))throw Error(provider==='serverchan'?'请填写SCT开头的Server酱Turbo SendKey':'请填写32位PushPlus Token');
  return token;
}
function safeError(message){const error=Error(message);error.safeMessage=message;return error;}
async function sendAlert({provider,channel,token,message,fetchImpl=fetch}){
  token=validateToken(provider,token);
  const url=provider==='serverchan'?`https://sctapi.ftqq.com/${token}.send`:'https://www.pushplus.plus/send';
  const options={method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'content-type':provider==='serverchan'?'application/x-www-form-urlencoded':'application/json'},body:provider==='serverchan'?new URLSearchParams({title:message.title,desp:message.content,noip:'1'}).toString():JSON.stringify({token,title:message.title,content:message.content,template:'txt',channel,timestamp:Date.now()+300000})};
  let response;
  try{response=await fetchImpl(url,options);}catch{throw safeError('推送连接未取得响应，提交状态可能不明，将退避重试');}
  if(!response.ok)throw safeError(`推送服务返回HTTP ${Number(response.status)||0}，请检查网络及服务状态`);
  let data;
  try{const text=await response.text();if(text.length>32768)throw Error();data=JSON.parse(text);}catch{throw safeError('推送服务响应无法核验');}
  const accepted=provider==='serverchan'?data.code===0&&(data.data?.errno===undefined||data.data.errno===0)&&!!data.data?.pushid:data.code===200&&typeof data.data==='string'&&data.data.length>0;
  if(!accepted)throw safeError(`推送服务未受理，错误码 ${Number(data.code)||'未知'}；请在服务官网检查密钥、绑定、实名或额度`);
  return {accepted:true,receiptId:provider==='serverchan'?String(data.data?.pushid||''):typeof data.data==='string'?data.data:''};
}
module.exports={sendAlert,validateToken};
