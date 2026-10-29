'use strict';
// Run with the Miniflare dependency supplied by a local Wrangler installation.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
async function run(){
  const {Miniflare,convertV4MiniflareOptions}=require(path.resolve(process.argv[2]||'work/cloudflare-tools/node_modules/miniflare'));
  const root=path.resolve(__dirname,'cloud-watchdog'),requests=[];let redirect=false;
  const mf=new Miniflare(convertV4MiniflareOptions({cf:false,workers:[{name:'watchdog-runtime-test',compatibilityDate:'2026-10-29',modules:[
    {type:'ESModule',path:path.join(root,'runtime-entry.mjs'),contents:`import {notify} from './worker.mjs';export default {async fetch(request,env){return Response.json(await notify(env,{id:'fixture-runtime',reason:'offline',startedAt:1000000}));}};`},
    {type:'ESModule',path:path.join(root,'worker.mjs'),contents:fs.readFileSync(path.join(root,'worker.mjs'),'utf8')}
  ],bindings:{SERVERCHAN_SENDKEY:'SCT'+'fixture'.repeat(8)},outboundService:async request=>{
    requests.push({url:request.url,redirect:request.redirect});
    assert.equal(new URL(request.url).hostname,'sctapi.ftqq.com');assert.equal(request.method,'POST');
    return redirect?new Response(null,{status:302,headers:{location:'https://example.test/never-follow'}}):Response.json({code:0,data:{pushid:'fixture-runtime-receipt'}});
  }}]}));
  try{
    const accepted=await (await mf.dispatchFetch('https://example.test/')).json();assert.equal(accepted.status,'accepted',JSON.stringify({result:accepted,outboundRequests:requests.length}));assert.equal(accepted.receiptId,'fixture-runtime-receipt');assert.equal(requests.length,1);
    redirect=true;const rejected=await (await mf.dispatchFetch('https://example.test/')).json();assert.equal(rejected.status,'failed');assert.equal(requests.length,2);
    const result={ok:true,runtime:'Cloudflare workerd via Miniflare',actualPushRequests:0,assertions:['supported redirect mode constructs and sends a Worker request','receipt required for accepted status','cross-host redirect does not forward the key']};
    fs.mkdirSync(path.resolve(__dirname,'../work'),{recursive:true});fs.writeFileSync(path.resolve(__dirname,'../work/cloud-watchdog-runtime-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  }finally{await mf.dispose();}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
