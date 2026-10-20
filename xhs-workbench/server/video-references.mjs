import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {accRoot} from './content.mjs';
import {readJson,writeJson,httpError} from './store.mjs';
const exec=promisify(execFile);
export const MAX_SOURCE_BYTES=60_000_000;
export const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const bin=name=>['/opt/homebrew/bin/','/usr/local/bin/'].map(p=>p+name).find(p=>fs.existsSync(p))||name;
export function readVideoFile(file,root,max=MAX_SOURCE_BYTES){
 let p=file;while(p!==root){if(fs.lstatSync(p).isSymbolicLink())throw httpError(400,'文件路径不能包含软链接');p=path.dirname(p);if(p===path.dirname(p))throw httpError(400,'文件不在账号内');}
 const s=fs.statSync(file);if(!s.isFile()||s.size>max)throw httpError(400,'参考视频不能超过60MB');return fs.readFileSync(file);
}
function extension(bytes){if(bytes.toString('ascii',4,8)==='ftyp')return '.mp4';if(bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])))return '.mkv';if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='AVI ')return '.avi';throw httpError(400,'请选择有效的 MP4/MOV/WebM/MKV/AVI 视频');}
export class VideoReferences {
 dir(a){return path.join(accRoot(a),'video-references');}
 list(a){const dir=this.dir(a);return fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>/^vref_[a-f0-9]{64}\.json$/.test(f)).map(f=>readJson(path.join(dir,f),null)).filter(r=>r?.accountId===a).sort((x,y)=>y.createdAt.localeCompare(x.createdAt)):[];}
 get(a,id){if(typeof id!=='string'||!/^vref_[a-f0-9]{64}$/.test(id))throw httpError(400,'参考视频编号无效');const r=this.list(a).find(r=>r.id===id);if(!r)throw httpError(404,'当前账号没有这段参考视频');return r;}
 read(a,id){const r=this.get(a,id);const file=path.join(this.dir(a),id,r.file);const bytes=readVideoFile(file,accRoot(a));if(digest(bytes)!==r.hash)throw httpError(409,'参考视频已改变，请重新上传');return {...r,filename:r.file,bytes,absolutePath:file};}
 async upload(a,{filename,data}={}){
  if(typeof filename!=='string'||!filename.trim()||filename.length>240||typeof data!=='string'||data.length>80_000_200)throw httpError(400,'参考视频文件无效或超过60MB');
  const encoded=data.replace(/^data:[^;,]+;base64,/,'');if(!encoded||encoded.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw httpError(400,'视频编码无效');
  const bytes=Buffer.from(encoded,'base64');if(bytes.length>MAX_SOURCE_BYTES)throw httpError(400,'参考视频不能超过60MB');const detected=extension(bytes),ext=detected==='.mkv'&&path.extname(filename).toLowerCase()==='.webm'?'.webm':detected,hash=digest(bytes),id='vref_'+hash;
  const old=this.list(a).find(r=>r.id===id);if(old){this.read(a,id);return old;}
  fs.mkdirSync(this.dir(a),{recursive:true});const temp=fs.mkdtempSync(path.join(this.dir(a),'.upload-')),file='source'+ext;
  try{
   fs.writeFileSync(path.join(temp,file),bytes,{flag:'wx'});
   let info;try{const r=await exec(bin('ffprobe'),['-v','error','-protocol_whitelist','file','-show_streams','-show_format','-of','json',path.join(temp,file)],{timeout:20000,maxBuffer:1024*1024});info=JSON.parse(r.stdout);}catch{throw httpError(400,'视频无法读取，请确认文件有效且已安装 ffprobe');}
   const s=info.streams?.find(s=>s.codec_type==='video'),duration=Number(info.format?.duration);
   if(!s?.width||!s.height||s.width>8192||s.height>8192||!Number.isFinite(duration)||duration<=0||duration>120)throw httpError(400,'参考视频须有有效画面，时长不超过120秒，分辨率不超过8192');
   const [rateNum,rateDen]=String(s.avg_frame_rate||'0/1').split('/').map(Number);const fps=rateNum/rateDen;
   const r={id,accountId:a,title:path.basename(filename),file,path:`video-references/${id}/${file}`,hash,bytes:bytes.length,media:{width:s.width,height:s.height,duration,fps:Number.isFinite(fps)&&fps>0?fps:24},createdAt:new Date().toISOString()};
   try{fs.renameSync(temp,path.join(this.dir(a),id));}catch(e){if(this.list(a).some(r=>r.id===id))return this.get(a,id);throw e;}
   writeJson(path.join(this.dir(a),id+'.json'),r);return r;
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
 }
 async frames(a,id,destination){
  const source=this.read(a,id);fs.mkdirSync(destination,{recursive:true});const frames=[];
  for(let i=0;i<12;i++){const time=Number((Math.max(0,source.media.duration-Math.max(0.15,2/source.media.fps))*i/11).toFixed(3)),file=path.join(destination,`frame-${String(i).padStart(2,'0')}.jpg`);
   try{await exec(bin('ffmpeg'),['-v','error','-nostdin','-protocol_whitelist','file','-ss',String(time),'-i',source.absolutePath,'-map','0:v:0','-frames:v','1','-vf','scale=640:640:force_original_aspect_ratio=decrease','-y',file],{timeout:20000,maxBuffer:1024*1024});if(!fs.existsSync(file))throw Error();}catch{throw httpError(400,'参考视频抽帧失败，请确认已安装 ffmpeg 并使用可解码的视频');}
   frames.push({time,path:file});
  }return frames;
 }
}
