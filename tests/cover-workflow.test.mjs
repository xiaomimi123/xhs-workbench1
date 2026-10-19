import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {useTempWorkspace,server} from './helpers.mjs';useTempWorkspace();const store=await server('store.mjs'),c=await server('content.mjs');store.ensureWorkspace();
const {CoverWorkflow}=await server('cover-workflow.mjs');
const specs=()=>['bigtext','list','memo'].map((template,i)=>({template,palette:'blue',title:'审片'+i,subtitle:'先写清问题',badge:'清单',items:['目标','反馈'],emphasis:['审片'],image:''}));
const png=()=> 'data:image/png;base64,'+fs.readFileSync(new URL('./fixtures/card.png',import.meta.url)).toString('base64');
const setup=()=>{const a=store.saveAccount({name:'图片验证'}).id,n=c.saveNote(a,{create:true,title:'原文标题',content:'原文正文',tags:['审片'],sources:[{benchmarkName:'小互'}]});return {a,n,w:new CoverWorkflow({submit(){}})};};
const finish=(w,j)=>{store.writeJson(j.outputFile,{specs:specs().map(s=>j.kind==='cards'?{...s,template:'list'}:s)});w.finish(j.id);return w.jobs(j.accountId,j.noteId).find(x=>x.id===j.id);};
test('封面方案不改稿件，卡片逐张保存幂等，完成依赖实际图片',()=>{
 const {a,n,w}=setup();const j=w.start(a,{noteId:n.id,kind:'cards'});assert.equal(w.start(a,{noteId:n.id,kind:'cards'}).id,j.id);assert.equal(finish(w,j).status,'ready');
 for(let i=0;i<3;i++){const job=w.jobs(a,n.id)[0];w.renderCard(a,{id:j.id,index:i,spec:job.specs[i],expectedSpec:job.specHashes[i],data:png()});w.renderCard(a,{id:j.id,index:i,spec:job.specs[i],expectedSpec:job.specHashes[i],data:png()});}
 assert.equal(w.jobs(a,n.id)[0].status,'done');assert.equal(c.noteDetail(a,n.id).media.length,3);assert.equal(c.noteDetail(a,n.id).content,'原文正文');assert.equal(c.noteDetail(a,n.id).title,'原文标题');assert.equal(c.noteDetail(a,n.id).sources[0].benchmarkName,'小互');
 const cover=w.start(a,{noteId:n.id,kind:'options'});assert.equal(finish(w,cover).status,'done');assert.equal(c.noteDetail(a,n.id).cover,undefined);
});
test('过期、无效输出与跨账号不能写图，重启保留待渲染任务',()=>{
 const {a,n,w}=setup();let j=w.start(a,{noteId:n.id,kind:'cards'});finish(w,j);const re=new CoverWorkflow({submit(){}});re.recover();assert.equal(re.jobs(a,n.id)[0].status,'ready');
 assert.throws(()=>w.renderCard('default',{id:j.id,index:0,data:png()}),/不存在/);
 c.saveNote(a,{id:n.id,content:'用户新稿'});assert.equal(w.jobs(a,n.id)[0].stale,true);assert.throws(()=>w.renderCard(a,{id:j.id,index:0,data:png()}),/修改|过期/);assert.equal(c.noteDetail(a,n.id).media.length,0);
 j=w.start(a,{noteId:n.id,kind:'options'});store.writeJson(j.outputFile,{specs:[{template:'photo',image:'../../bad'}]});w.finish(j.id);assert.equal(w.jobs(a,n.id).find(x=>x.id===j.id).status,'error');
});
test('保存封面检查文案与封面版本并备份现有图片',()=>{
 const {a,n,w}=setup();let state=w.state(a,n.id);w.saveCover(a,{noteId:n.id,spec:specs()[0],data:png(),expected:state.version,expectedCover:state.coverHash});
 state=w.state(a,n.id);w.saveCover(a,{noteId:n.id,spec:specs()[1],data:png(),expected:state.version,expectedCover:state.coverHash});
 const dir=path.join(c.accRoot(a),'notes',n.id,'cover-backups');assert.ok(fs.readdirSync(dir).some(f=>f.endsWith('.png')));assert.equal(c.noteDetail(a,n.id).content,'原文正文');
 assert.throws(()=>w.saveCover(a,{noteId:n.id,spec:specs()[0],data:png(),expected:state.version,expectedCover:state.coverHash}),/封面|修改/);
 assert.throws(()=>w.saveCover(a,{noteId:n.id,spec:specs()[0],data:'data:image/png;base64,YQ==',expected:w.state(a,n.id).version,expectedCover:w.state(a,n.id).coverHash}),/PNG/);
});
test('封面模式并发修改不能被较早保存请求覆盖',()=>{
 const {a,n,w}=setup(),state=w.state(a,n.id);c.saveNote(a,{id:n.id,coverMode:'first'});
 assert.throws(()=>w.saveCover(a,{noteId:n.id,spec:specs()[0],data:png(),expected:state.version,expectedCover:state.coverHash}),/修改/);assert.equal(c.noteDetail(a,n.id).coverMode,'first');
});
test('渲染失败可继续、卡片编辑保留顺序与旧图、素材上限拒绝追加',()=>{
 const {a,n,w}=setup();const j=w.start(a,{noteId:n.id,kind:'cards'});finish(w,j);w.renderError(a,j.id,'模拟网络失败');assert.equal(w.jobs(a,n.id)[0].status,'render_error');assert.equal(w.retry(a,j.id).status,'ready');
 for(let i=0;i<3;i++){const job=w.jobs(a,n.id)[0];w.renderCard(a,{id:j.id,index:i,spec:job.specs[i],expectedSpec:job.specHashes[i],data:png()});}
 const before=c.noteDetail(a,n.id).media,job=w.jobs(a,n.id)[0];w.renderCard(a,{id:j.id,index:0,spec:{...job.specs[0],title:'编辑后的卡片'},expectedSpec:job.specHashes[0],data:png()});assert.deepEqual(c.noteDetail(a,n.id).media,before);
 assert.ok(fs.readdirSync(path.join(c.accRoot(a),'notes',n.id,'cover-backups')).some(f=>f.endsWith('.png')));
 const another=c.saveNote(a,{create:true,title:'素材已满',content:'正文'});for(let i=0;i<15;i++)c.uploadNoteImage(a,another.id,`existing${i}.png`,png());
 assert.throws(()=>w.start(a,{noteId:another.id,kind:'cards'}),/18/);assert.equal(c.noteDetail(a,another.id).media.length,15);
});
