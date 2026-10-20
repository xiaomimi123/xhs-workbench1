import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import {WORKSPACE} from './paths.mjs';
import {httpError} from './store.mjs';
const DEFAULT_URL='https://47.94.91.17:8443/api/v1';
function base(value){let u;try{u=new URL(value);}catch{throw httpError(400,'视频服务地址无效');}if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw httpError(400,'视频服务须为不含账号、查询参数的HTTPS地址');return u.href.replace(/\/$/,'');}
export function videoParams(v={}){
 const {mode='t2v',prompt,seconds=5,ratio='3:4',references=[]}=v;
 if(!['t2v','i2v','r2v','v2v','rv2v'].includes(mode)||typeof prompt!=='string'||!prompt.trim()||prompt.length>4000)throw httpError(400,'请选择视频模式并填写4000字以内描述');
 if(!Array.isArray(references)||['t2v','v2v'].includes(mode)&&references.length||mode==='i2v'&&references.length!==1||['r2v','rv2v'].includes(mode)&&(references.length<1||references.length>9))throw httpError(400,'首帧模式须1张图片，参考主体和换主体模式须1–9张，文生视频与视频转视频不带图片');
 if(['v2v','rv2v'].includes(mode)&&(typeof v.sourceVideoId!=='string'||!/^vref_[\w-]+$/.test(v.sourceVideoId)))throw httpError(400,'请先上传并选择参考视频');
 const frames={3:73,5:124,8:192,10:243},sizes={'3:4':[576,768],'9:16':[480,864],'16:9':[864,480],'1:1':[640,640]};
 if(!Object.hasOwn(frames,seconds)||!Object.hasOwn(sizes,ratio))throw httpError(400,'视频时长或比例无效');
 return {mode,prompt:prompt.trim(),width:sizes[ratio][0],height:sizes[ratio][1],total_frames:frames[seconds],frame_rate:24,use_turbo:['t2v','i2v'].includes(mode)};
}
function transport(url,{key,ca,method='GET',body,binary=false,timeoutMs}={}){
 return new Promise((resolve,reject)=>{
  const bytes=body?Buffer.from(JSON.stringify(body)):null;const limit=binary?200*1024*1024:2*1024*1024;
  const req=https.request(url,{method,rejectUnauthorized:true,...(ca?{ca}:{}),headers:{...(key?{'X-API-Key':key}:{}),...(bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{})}},res=>{
   const chunks=[];let size=0;res.on('data',b=>{size+=b.length;if(size>limit)res.destroy(Error('limit'));else chunks.push(b);});res.on('error',()=>reject(httpError(502,'视频响应中断或超过大小上限')));res.on('end',()=>{
    if(res.statusCode<200||res.statusCode>=300){const e=httpError(502,`视频网关请求失败（HTTP ${res.statusCode}）`);e.upstreamStatus=res.statusCode;reject(e);return;}
    const data=Buffer.concat(chunks);if(binary){resolve(data);return;}try{resolve(JSON.parse(data));}catch{reject(httpError(502,'视频网关响应格式无效'));}
   });
  });
  const timer=setTimeout(()=>req.destroy(Error('timeout')),timeoutMs||(binary?300000:45000));req.on('close',()=>clearTimeout(timer));req.on('error',e=>{const tls=/CERT|SELF_SIGNED|VERIFY|ALTNAME/.test(e.code||'');const error=httpError(502,tls?'未提交到视频网关：HTTPS证书校验失败，请使用正式域名或在设置中提供受信任证书（证书须匹配地址）。':'视频网关连接中断，请核对原任务，不要重复提交');error.notSubmitted=tls;error.transportFailure=!tls;reject(error);});if(bytes)req.write(bytes);req.end();
 });
}
export class VideoService {
 constructor({file=path.join(WORKSPACE,'.secrets','video-service.json'),request=transport,browserRead=async(...args)=>(await import('./video-browser-transport.mjs')).browserVideoRead(...args),browserSubmit=async(...args)=>(await import('./video-browser-transport.mjs')).browserVideoSubmit(...args)}={}){this.file=file;this.transport=request;this.browserRead=browserRead;this.browserSubmit=browserSubmit;}
 read(){if(!fs.existsSync(this.file))return {baseUrl:DEFAULT_URL};try{return JSON.parse(fs.readFileSync(this.file,'utf8'));}catch{throw httpError(500,'视频配置读取失败');}}
 settings(){const s=this.read();return {baseUrl:s.baseUrl,hasKey:!!s.apiKey,hasCertificate:!!s.ca};}
 save(input={}){const s=this.read();if(input.baseUrl!==undefined)s.baseUrl=base(input.baseUrl);if(input.apiKey!==undefined&&(typeof input.apiKey!=='string'||input.apiKey.length>4096||/[\r\n]/.test(input.apiKey)))throw httpError(400,'密钥格式无效');if(input.deleteKey)delete s.apiKey;else if(input.apiKey?.trim())s.apiKey=input.apiKey.trim();if(input.ca!==undefined&&typeof input.ca!=='string')throw httpError(400,'证书格式无效');if(input.deleteCertificate)delete s.ca;else if(input.ca?.trim()){if(typeof input.ca!=='string'||input.ca.length>30000)throw httpError(400,'证书格式无效');try{new crypto.X509Certificate(input.ca);}catch{throw httpError(400,'请填写PEM格式的服务端或CA证书');}s.ca=input.ca.trim();}fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});const temp=this.file+'.'+crypto.randomUUID();fs.writeFileSync(temp,JSON.stringify(s),{flag:'wx',mode:0o600});fs.renameSync(temp,this.file);fs.chmodSync(this.file,0o600);return this.settings();}
 config(){const s=this.read();base(s.baseUrl);if(!s.apiKey)throw httpError(400,'请在连接与设置中填写视频API密钥');return s;}
 async request(route,options={},config=this.config()){const url=config.baseUrl+route,settings={key:config.apiKey,ca:config.ca,...options};try{return await this.transport(url,settings);}catch(e){if(e.transportFailure&&!config.ca&&(!options.method||options.method==='GET'))return this.browserRead(url,settings);throw e;}}
 async test(){const c=this.config();const health=await this.request('/health',{},c);const capabilities=await this.request('/capabilities',{},c);return {connected:true,generationTested:false,health,capabilities};}
 async selectSubmitTransport(config=this.config()){
  try{await this.transport(config.baseUrl+'/health',{timeoutMs:15000,ca:config.ca});return 'direct';}
  catch(e){try{if(!e.transportFailure||config.ca)throw e;await this.browserRead(config.baseUrl+'/health',{key:config.apiKey,timeoutMs:15000});return 'browser';}catch{const error=httpError(502,'提交前连接检查失败，未发送生成请求；请测试视频服务连接。');error.notSubmitted=true;throw error;}}
 }
 async submit(input,config=this.config()){const {mode,...body}=input;if(!['t2v','i2v','r2v','v2v','rv2v'].includes(mode))throw httpError(400,'视频模式无效');const selected=await this.selectSubmitTransport(config);const url=config.baseUrl+'/generate/'+mode,options={key:config.apiKey,ca:config.ca,method:'POST',body,timeoutMs:60000};return selected==='browser'?this.browserSubmit(url,options):this.transport(url,options);}
 async poll(id,wait=0){this.id(id);if(!Number.isInteger(wait)||wait<0||wait>120)throw httpError(400,'等待秒数无效');return this.request('/jobs/'+encodeURIComponent(id)+(wait?'?wait='+wait:''),{timeoutMs:Math.max(45000,(wait+15)*1000)});}
 async download(id){this.id(id);return this.request('/jobs/'+encodeURIComponent(id)+'/video',{binary:true,timeoutMs:300000});}
 id(id){if(typeof id!=='string'||!/^[-\w]{1,200}$/.test(id))throw httpError(400,'远端视频任务编号无效');}
}
export const videoService=new VideoService();
