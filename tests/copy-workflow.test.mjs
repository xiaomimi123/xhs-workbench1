import {test} from 'node:test';
import assert from 'node:assert/strict';
import {useTempWorkspace,server} from './helpers.mjs';
useTempWorkspace();const store=await server('store.mjs');const content=await server('content.mjs');store.ensureWorkspace();
const {CopyWorkflow}=await server('copy-workflow.mjs');
const make=()=>{const account=store.saveAccount({name:'文案验证'}).id;const note=content.saveNote(account,{create:true,title:'原标题',content:'原正文',tags:['原标签'],sources:[{benchmarkName:'小互',url:'https://www.xiaohongshu.com/explore/abc'}],basis:'observed'});return {account,note,w:new CopyWorkflow({submit(){},sources:()=>[]})};};
const finish=(w,j,result)=>{store.writeJson(j.outputFile,result);w.finish(j.id);return w.jobs(j.accountId,j.noteId).find(x=>x.id===j.id);};
test('改写保留原稿、来源、标题，重复任务复用，标题优化不改正式标题',()=>{
 const {account,note,w}=make();const j=w.start(account,{noteId:note.id,kind:'rewrite',instruction:'简洁'});
 assert.equal(w.start(account,{noteId:note.id,kind:'rewrite',instruction:'简洁'}).id,j.id);
 assert.equal(finish(w,j,{content:'新的正文',tags:['新标签']}).status,'done');
 const fresh=content.noteDetail(account,note.id);assert.equal(fresh.content,'新的正文');assert.equal(fresh.title,'原标题');assert.equal(fresh.sources[0].benchmarkName,'小互');assert.equal(store.readJson(j.inputFile).note.content,'原正文');
 const t=w.start(account,{noteId:note.id,kind:'titles'});assert.equal(finish(w,t,{titles:['标题甲','标题乙','标题丙','标题丁','标题戊'].map(title=>({title,reason:'对应正文'}))}).status,'done');
 assert.equal(content.noteDetail(account,note.id).title,'原标题');assert.equal(content.noteDetail(account,note.id).titleOptions.length,5);
});
test('检查保存结构化报告并只读稿件，内容变化后过期',()=>{
 const {account,note,w}=make();const j=w.start(account,{noteId:note.id,kind:'check'});
 const done=finish(w,j,{summary:'需核实',issues:[{severity:'warning',quote:'原正文',suggestion:'补充依据'}],unverified:['产品效果']});
 assert.equal(done.status,'done');assert.equal(done.stale,false);assert.equal(done.result.unverified[0],'产品效果');assert.equal(content.noteDetail(account,note.id).content,'原正文');assert.ok(done.lint);
 content.saveNote(account,{id:note.id,title:'新标题'});assert.equal(w.jobs(account,note.id).find(x=>x.id===j.id).stale,true);
});
test('编辑冲突、错误结果、跨账号、重试和重启保护',()=>{
 const {account,note,w}=make();let j=w.start(account,{noteId:note.id,kind:'rewrite'});content.saveNote(account,{id:note.id,content:'手工修改'});
 assert.equal(finish(w,j,{content:'不得覆盖',tags:[]}).status,'error');assert.equal(content.noteDetail(account,note.id).content,'手工修改');assert.throws(()=>w.retry(account,j.id),/修改/);assert.throws(()=>w.retry('default',j.id),/不存在/);
 j=w.start(account,{noteId:note.id,kind:'titles'});assert.equal(finish(w,j,{titles:[{title:'无效',reason:'不足5个'}]}).status,'error');
 j=w.retry(account,j.id);assert.notEqual(j.status,'done');const recovered=new CopyWorkflow({submit(){},sources:()=>[]});recovered.recover();assert.equal(recovered.jobs(account,note.id).find(x=>x.id===j.id).status,'error');
 j=recovered.retry(account,j.id);recovered.finish(j.id);assert.match(recovered.jobs(account,note.id).find(x=>x.id===j.id).error,/结果/);
});
