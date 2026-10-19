import {checkPng} from './png-check.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {accRoot,noteDetail} from './content.mjs';
import {readJson,writeJson} from './store.mjs';
import {lint} from '../web/lint.js';
import {CopyWorkflow} from './copy-workflow.mjs';
import {imagePages} from '../web/note-preview.js';
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
export function preflight(a,id,{persist=false}={}){
 const n=noteDetail(a,id),dir=path.join(accRoot(a),'notes',id),raw=readJson(path.join(dir,'meta.json'),{}),errors=[],warnings=[];
 if(n.status==='published')errors.push('已发布笔记请先另存草稿');
 if(!n.title?.trim())errors.push('标题不能为空');if(!n.content?.trim())errors.push('正文不能为空');
 const checked=lint({title:n.title||'',body:n.content||'',tags:n.tags||[]});
 for(const x of checked.issues)(x.level==='error'?errors:warnings).push(`${x.where||x.category}：${x.tip}`);
 if(n.video)errors.push('当前检查支持图文笔记，请单独核实视频素材');
 if(n.coverStale)errors.push('封面与当前封面配置不一致，请重新生成');
 const pages=imagePages(n);if(!pages.length)errors.push('至少需要一张图片');if(pages.length>18)errors.push('图片超过 18 张');
 for(const m of raw.media||[])if(!pages.some(p=>p.path===`images/${m.file}`))errors.push(`缺少素材：${m.file}`);
 if(raw.coverMode==='template'&&!n.hasCover)errors.push('缺少模板封面');
 const images=pages.map(p=>{
  try{
   const file=path.resolve(dir,p.path);if(!file.startsWith(dir+path.sep)||fs.lstatSync(file).isSymbolicLink())throw Error('路径无效');
   const stat=fs.statSync(file);if(stat.size>30*1024*1024)throw Error('文件超过 30 MB');
   const b=fs.readFileSync(file);const {width,height}=checkPng(b);
   return {...p,width,height,sha256:hash(b),bytes:b.length};
  }catch(e){errors.push(`${p.label}：${e.message}`);return {...p,error:e.message};}
 });
 const contentCheck=new CopyWorkflow({submit(){}}).jobs(a,id).filter(j=>j.kind==='check'&&j.status==='done')[0]||null;
 if(!contentCheck)warnings.push('尚无内容检查报告');else if(contentCheck.stale)warnings.push('最近内容检查已过期，请重新检查');
 const fingerprint=hash(JSON.stringify({title:n.title,content:n.content,tags:n.tags,sources:n.sources,status:n.status,visibility:n.visibility,cover:n.cover,coverMode:n.coverMode,media:raw.media,images}));
 const report={noteId:id,title:n.title,excerpt:(n.content||'').slice(0,150),createdAt:new Date().toISOString(),ok:!errors.length,fingerprint,errors,warnings,images,contentCheck,unverified:['未验证平台审核结果、事实准确性和素材授权；检查通过不等于可以直接发布。']};
 if(persist)writeJson(path.join(accRoot(a),'preflight',`${id}.json`),report);return report;
}
