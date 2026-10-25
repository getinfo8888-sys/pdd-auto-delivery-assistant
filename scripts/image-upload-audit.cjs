'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {makeBridgeScript}=require('../src/platform/pdd-bridge.cjs');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run({app,engine,ensureView,dataDir}) {
 const out=path.resolve(__dirname,'../work'),report={at:new Date().toISOString(),businessWrites:0,assetUploads:0,network:[],ok:false};
 let wc,listener;
 try {
  const file=process.argv.find(value=>value.startsWith('--image-audit-file='))?.slice('--image-audit-file='.length);
  if (!file || path.dirname(path.resolve(file))!==path.join(dataDir,'assets') || !/^[a-f0-9]{64}\.(jpg|png)$/.test(path.basename(file))) throw Error('必须明确指定本机已选图片缓存');
  const bytes=fs.readFileSync(file),digest=createHash('sha256').update(bytes).digest('hex');
  if (digest!==path.basename(file).split('.')[0] || !bytes.length || bytes.length>5*1024*1024) throw Error('缓存图片校验失败');
  const image={name:'上传图片'+path.extname(file),mime:file.endsWith('.png')?'image/png':'image/jpeg',base64:bytes.toString('base64')};report.imageSha256=digest;report.imageBytes=bytes.length;
  wc=ensureView('chat').webContents;
  let identity;
  for(let n=0;n<60;n++){
   try {identity=await wc.executeJavaScript(`(()=>{const root=document.querySelector('#app')?.__vue__,user=root?.$store?.state?.userInfo;return user?.mall_id?{shopId:String(user.mall_id),hasBaseUtil:typeof baseUtil?.uploadImage==='function'}:null;})()`);if(identity)break;}catch{}
   await wait(500);
  }
  if (!identity) throw Error('官方客服尚未登录或初始化');
  const requests=new Map();
  listener=async(_event,method,params)=>{
   if(method==='Network.requestWillBeSent'){
    try {const url=new URL(params.request.url);if(/galerie\/business\/get_signature|store_image|plateau\/file\/pre_upload/.test(url.pathname))requests.set(params.requestId,{origin:url.origin,path:url.pathname,method:params.request.method});}catch{}
   }
   if(method==='Network.responseReceived' && requests.has(params.requestId)){
    const row={...requests.get(params.requestId),status:params.response.status};report.network.push(row);
    if(row.status>=400)try{const response=await wc.debugger.sendCommand('Network.getResponseBody',{requestId:params.requestId});const data=JSON.parse(response.body);row.code=data.error_code ?? data.errorCode ?? null;row.message=String(data.error_msg || data.errorMsg || data.message || '').slice(0,300);}catch{}
   }
   if(method==='Network.loadingFinished' && requests.has(params.requestId)){
    const row=report.network.findLast(item=>item.path===requests.get(params.requestId).path && item.method==='POST');
    if(row?.status===200 && row.path.includes('store_image'))try{
      const response=await wc.debugger.sendCommand('Network.getResponseBody',{requestId:params.requestId}),data=JSON.parse(response.body);
      row.responseKeys=Object.keys(data);row.resultKeys=data.result && typeof data.result==='object'?Object.keys(data.result):null;
      const value=data.url || data.result?.url;
      if(typeof value==='string'){const url=new URL(value,'https://mms.pinduoduo.com');row.returnedImageOrigin=url.origin;row.returnedImageProtocol=url.protocol;}
    }catch(error){row.bodyReadError=error.message.slice(0,100);}
   }
  };
  wc.debugger.attach('1.3');wc.debugger.on('message',listener);await wc.debugger.sendCommand('Network.enable');
  if(!process.argv.includes('--image-audit-new-only'))report.oldRoute=await wc.executeJavaScript(`(async(image)=>{try{const signature=await baseUtil.getUploadImageSignature();const raw=Uint8Array.from(atob(image.base64),char=>char.charCodeAt(0));const result=await baseUtil.uploadImage({rawImage:new File([raw],image.name,{type:image.mime}),signature},()=>{});return {status:result?.url?'uploaded':'rejected'};}catch(error){return {status:'rejected',httpStatus:error?.response?.status || error?.status || null,reason:String(error?.message || '').slice(0,300)};}})(${JSON.stringify(image)})`);
  report.newRoute=await wc.executeJavaScript(makeBridgeScript('image-upload',{allowAssetUpload:true,expectedShopId:identity.shopId,image}));
  if(report.newRoute.status==='uploaded'){report.assetUploads++;report.ok=true;}
  report.businessRunning=engine.snapshot().config.running;
  await wait(1000);
 } catch(error){report.error=error.message;}
 finally {if(wc?.debugger.isAttached()){wc.debugger.removeListener('message',listener);wc.debugger.detach();}}
 fs.writeFileSync(path.join(out,'image-upload-audit-result.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({...report,newRoute:report.newRoute?{...report.newRoute,url:report.newRoute.url?'[official CDN image]':undefined}:undefined}));
 app.exit(report.ok?0:1);
}
module.exports={run};
