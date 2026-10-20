import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {WORKSPACE} from './paths.mjs';
import {httpError} from './store.mjs';
const BASE='https://api.apimart.ai';
const DEFAULTS={defaultProvider:'current-agent',baseUrl:BASE,model:'gpt-image-2',size:'16:9',resolution:'2k'};
const SIZES=['1:1','16:9','9:16','4:3','3:4','3:2','2:3','5:4','4:5','2:1','1:2','3:1','1:3','21:9','9:21'];
export function validateImageOptions(input){
 if(!['current-agent','apimart'].includes(input.defaultProvider)||!['gpt-image-2','gpt-image-2-ext'].includes(input.model)||!SIZES.includes(input.size)||!['1k','2k','4k'].includes(input.resolution))throw httpError(400,'生图服务、模型、比例或清晰度无效');
 return input;
}
export class ImageService {
 constructor({file=path.join(WORKSPACE,'.secrets','image-service.json'),fetchImpl=globalThis.fetch}={}){this.file=file;this.fetch=fetchImpl;}
 read(){try{return {...DEFAULTS,...JSON.parse(fs.readFileSync(this.file,'utf8')),baseUrl:BASE};}catch(e){if(e.code!=='ENOENT')throw httpError(500,'无法读取本机生图设置');return {...DEFAULTS};}}
 settings(){const {apiKey,...s}=this.read();return {...s,hasKey:!!apiKey,keyMasked:apiKey?'••••••••':''};}
 save(input={}){
 const s=this.read();for(const k of ['defaultProvider','model','size','resolution'])if(input[k]!==undefined)s[k]=input[k];validateImageOptions(s);
 if(input.apiKey!==undefined&&(typeof input.apiKey!=='string'||input.apiKey.length>4096||/[\r\n]/.test(input.apiKey)))throw httpError(400,'API Key格式无效');
 if(input.deleteKey===true)delete s.apiKey;else if(input.apiKey?.trim())s.apiKey=input.apiKey.trim();
 fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});const tmp=this.file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(s),{mode:0o600,flag:'wx'});fs.renameSync(tmp,this.file);fs.chmodSync(this.file,0o600);return this.settings();
 }
 requireKey(){const key=this.read().apiKey;if(!key)throw httpError(400,'请先在设置中保存APIMart API Key');return key;}
 // 提交诊断：只记录阶段、HTTP 状态、请求 ID、网络错误码和上游摘要（截断并抹去密钥），不保存完整响应。
 redact(text,token){const key=token||this.read().apiKey||'';return key?String(text||'').split(key).join('***'):String(text||'');}
 // 上游错误体通常是 {"error":{"message":"… (request id: xxx)"}}：只取 message，并把嵌在里面的请求编号拆出来
 summarize(upstream){
  let text=String(upstream||'').trim();try{const j=JSON.parse(text);const m=j?.error?.message??j?.message??j?.error;if(typeof m==='string')text=m;}catch{}
  const id=/\(request id:\s*([\w-]+)\)/i.exec(text);if(id)text=text.replace(id[0],'').trim();
  return {text:text.replace(/\s+/g,' '),requestId:id?id[1]:''};
 }
 failure(stage,{httpStatus=null,networkCode='',requestError='',upstream='',requestId='',token=''}={}){
  if(stage==='http'&&upstream){const s=this.summarize(upstream);upstream=s.text;requestId=requestId||s.requestId;}
  const err=httpError(502,stage==='connect'?'APIMart连接中断，远端状态待核对':stage==='respond'?'APIMart响应格式无效，远端状态待核对':`APIMart请求未成功（HTTP ${httpStatus}）`);
  err.diag={stage,httpStatus,networkCode:String(networkCode||'').slice(0,80),detail:this.redact(requestError||upstream,token).slice(0,300),
    ...(requestId?{requestId:String(requestId).slice(0,80)}:{}),at:new Date().toISOString()};
  return err;
 }
 async request(route,{method='GET',body,key}={}){
 const token=key||this.requireKey();let res;
 try{res=await this.fetch(BASE+route,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(45000)});}
 catch(err){throw this.failure('connect',{networkCode:err?.cause?.code||err?.code||err?.name||'',requestError:err?.message||'',token});}
 if(!res.ok){
  let upstream='';try{upstream=await res.text();}catch{}
  const requestId=res.headers?.get?.('x-request-id')||res.headers?.get?.('cf-ray')||'';
  throw this.failure('http',{httpStatus:res.status,upstream,requestId,token});
 }
 try{return await res.json();}catch(err){throw this.failure('respond',{requestError:err?.message||'',requestId:res.headers?.get?.('x-request-id')||'',token});}
 }
 async testConnection(){
 const key=this.requireKey();let networkCode='';
 // 网络偶发抖动很常见：连不上时自动再试一次；仍失败就给出具体的网络错误码，方便排查
 for(let attempt=0;attempt<2;attempt++){
  try{const r=await this.fetch(BASE+'/v1/models',{headers:{Authorization:`Bearer ${key}`},redirect:'error',signal:AbortSignal.timeout(15000)});return {connected:true,authenticated:r.ok?true:[401,403].includes(r.status)?false:null,status:r.status,generationTested:false,message:r.ok?'连接和鉴权通过；未调用生图，未验证模型权限或余额。':[401,403].includes(r.status)?'服务可连接，但鉴权失败，请检查API Key。':'服务可连接，但无法确认鉴权；未调用生图。'};}
  catch(err){networkCode=String(err?.cause?.code||err?.code||err?.name||'').slice(0,40);if(attempt===0)await new Promise((r)=>setTimeout(r,this.retryDelayMs??800));}
 }
 return {connected:false,authenticated:null,generationTested:false,networkCode,message:`无法连接APIMart${networkCode?`（${networkCode}）`:''}，已自动重试一次；未调用生图。请检查这台电脑的网络、代理或防火墙后再测试。`};
 }
 async submit(input,key){const body={model:input.model,prompt:input.prompt,n:1,size:input.size,resolution:input.resolution,official_fallback:false};if(input.image_urls?.length)body.image_urls=input.image_urls;const data=await this.request('/v1/images/generations',{method:'POST',body,key});const id=data?.data?.[0]?.task_id;if(typeof id!=='string'||!/^[-\w]{1,200}$/.test(id)){throw this.failure('respond',{requestError:'响应缺少合法任务编号，远端可能已受理',token:key});}return id;}
 async poll(id){if(!/^[-\w]{1,200}$/.test(id))throw httpError(400,'远端任务编号无效');return (await this.request('/v1/tasks/'+encodeURIComponent(id))).data;}
 async download(value){
 let u;try{u=new URL(value);}catch{throw httpError(502,'图片下载地址无效');}
 if(u.protocol!=='https:'||!['upload.apimart.ai','getapib.org'].includes(u.hostname)||u.port||u.username||u.password)throw httpError(502,'图片下载地址不在可信APIMart CDN范围');
 let res;try{res=await this.fetch(u.href,{redirect:'manual',signal:AbortSignal.timeout(45000)});}catch{throw httpError(502,'图片下载失败，可再次刷新已有任务');}
 if(!res.ok||res.status>=300||Number(res.headers.get('content-length'))>20*1024*1024)throw httpError(502,'图片下载响应或大小无效');
 const chunks=[];let length=0;try{for await(const chunk of res.body){length+=chunk.length;if(length>20*1024*1024)throw Error();chunks.push(Buffer.from(chunk));}}catch{throw httpError(502,'图片下载中断或超过20MB');}return Buffer.concat(chunks);
 }
}
export const imageService=new ImageService();
export const getImageServiceSettings=()=>imageService.settings();
export const saveImageServiceSettings=input=>imageService.save(input);
export const testImageServiceConnection=()=>imageService.testConnection();
