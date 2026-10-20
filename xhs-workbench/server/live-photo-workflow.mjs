import {createPVT} from './live-pvt.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {accountDir,P,WORKSPACE} from './paths.mjs';
import {readJson,writeJson,newId,httpError,listAccounts} from './store.mjs';
import {createZip} from './zip.mjs';
import {renderLivePhoto} from './live-photo-render.mjs';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function plain(file){let p=file;while(p!==path.resolve(WORKSPACE)&&p!==path.dirname(p)){if(fs.lstatSync(p).isSymbolicLink())throw httpError(409,'文件路径不能为软链接');p=path.dirname(p);}const s=fs.statSync(file);if(!s.isFile()||!s.size||s.size>100*1024*1024)throw httpError(409,'文件大小无效');return fs.readFileSync(file);}
export class LivePhotoWorkflow {
 constructor({images,render=renderLivePhoto,changed=()=>{}}={}){this.images=images;this.render=render;this.changed=changed;this.active=new Set();}
 dir(a,id=''){if(!listAccounts().some(x=>x.id===a))throw httpError(404,'账号不存在');return path.join(accountDir(a),'live-jobs',id);}
 list(a){const dir=this.dir(a);return fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>/^live_[\w-]+\.json$/.test(f)).map(f=>readJson(path.join(dir,f),null)).filter(j=>j?.accountId===a).sort((x,y)=>y.createdAt.localeCompare(x.createdAt)):[];}
 get(a,id){const j=this.list(a).find(j=>j.id===id);if(!j)throw httpError(404,'实况任务不存在');return j;}
 save(j){writeJson(path.join(this.dir(j.accountId),j.id+'.json'),j);this.changed(j.accountId);return j;}
 recover(){for(const a of listAccounts())for(const j of this.list(a.id))if(j.status==='running'){j.status='error';j.error='工作台重启中断，请重新制作';this.save(j);}}
 start(a,{imageJobId,index,motion='gentle',newRound=false}){
  if(motion!=='gentle')throw httpError(400,'目前仅支持轻微推近回位动效');
  const {j:source,asset,data}=this.images.asset(a,imageJobId,index),key=hash(JSON.stringify([imageJobId,index,asset.hash,motion,1]));
  const old=this.list(a).find(j=>j.key===key&&['running','done'].includes(j.status));if(old&&!newRound){if(old.status==='running')return old;try{this.files(a,old.id);return old;}catch{/* A damaged completed job is marked failed by files(); create a fresh snapshot. */}}
  if(this.active.size>=2)throw httpError(409,'已有实况制作任务运行，请稍后重试');
  const id=newId('live_'),dir=this.dir(a,id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'source.png'),data,{flag:'wx'});
  const j={id,accountId:a,imageJobId,index,key,title:source.headline||source.prompt.slice(0,80),sourceHash:asset.hash,sourcePath:`live-jobs/${id}/source.png`,motion,status:'running',createdAt:new Date().toISOString(),phone:{iphone:false,xhs:false},history:[],outputs:[]};this.save(j);this.active.add(id);
  this.run(j).finally(()=>this.active.delete(id));return j;
 }
 async run(j){try{const dir=this.dir(j.accountId,j.id);const report=await this.render({dir,source:path.join(dir,'source.png'),motion:j.motion});if(hash(plain(path.join(dir,'source.png')))!==j.sourceHash)throw Error('来源快照已改变');
   if(!report.appleRecognized||!report.pairedIdentifier||!report.motionVerified||!report.identifier||Math.abs(report.duration-3)>.1||Math.abs(report.stillImageTime-1.5)>.1)throw Error('Apple实况或运动校验未通过');
   j.outputs=['photo.jpg','paired.mov','preview.mp4'].map(file=>({file,path:`live-jobs/${j.id}/${file}`,hash:hash(plain(path.join(dir,file)))}));j.report=report;j.status='done';j.finishedAt=new Date().toISOString();this.save(j);
  }catch(e){j.status='error';j.error=String(e.message).slice(0,1200);this.save(j);}}
 files(a,id){const j=this.get(a,id);if(j.status!=='done')throw httpError(409,'实况任务未完成');try{const files=j.outputs.map(o=>{if(!['photo.jpg','paired.mov','preview.mp4'].includes(o.file))throw Error('输出路径无效');const data=plain(path.join(this.dir(a,id),o.file));if(hash(data)!==o.hash)throw Error('文件哈希不同');return {name:o.file,data};});if(files.length!==3)throw Error('文件不完整');return {j,files};}catch(e){j.status='error';j.error='实况文件已改变或缺失，请重新制作';j.phone={iphone:false,xhs:false};this.save(j);throw httpError(409,j.error);}}

 bundle(a,id,format){const {j,files}=this.files(a,id);if(format==='pvt')return createPVT(files);return createZip([...files.map(x=>({...x,name:x.name==='photo.jpg'?'LIVE.JPG':x.name==='paired.mov'?'LIVE.MOV':x.name})),{name:'导入说明.txt',data:Buffer.from('将 LIVE.JPG 和 LIVE.MOV 一起导入 Mac 照片，确认显示 LIVE 并可播放。再从照片通过 AirDrop 或已启用的 iCloud 照片传到 iPhone。不要只传单张 JPG，不要把 preview.mp4 当作实况。\n在 iPhone 照片长按播放，再在小红书添加照片时选择实况，停在编辑预览；不要发布。\nZIP是备份传输包，不能保证iPhone文件App直接保存为实况。\n')},{name:'manifest.json',data:Buffer.from(JSON.stringify({id:j.id,sourceHash:j.sourceHash,report:j.report,phone:j.phone},null,2))}]);}
 recordReceipt(a,id,receipt){const {j}=this.files(a,id);j.receiverReceipt={...receipt,source:'receiver-report'};return this.save(j);}
 confirm(a,{id,stage,confirmed,method}){if(!['iphone','xhs'].includes(stage)||typeof confirmed!=='boolean')throw httpError(400,'实测记录无效');const {j}=this.files(a,id);if(stage==='xhs'&&confirmed&&!j.phone.iphone)throw httpError(409,'请先确认iPhone照片可识别和播放');j.phone[stage]=confirmed;if(stage==='iphone'&&!confirmed)j.phone.xhs=false;j.history.push({stage,confirmed,at:new Date().toISOString(),source:'user-confirmation',...(method==='pvt'?{method:'pvt'}:{})});return this.save(j);}
}
