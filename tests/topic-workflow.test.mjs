import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {useTempWorkspace,server} from './helpers.mjs';
const ws=useTempWorkspace();const store=await server('store.mjs');const content=await server('content.mjs');store.ensureWorkspace();
test('同一选题重复创建稿件只创建一份，保留选题来源',()=>{
 const t=content.saveTopic('default',{title:'测试选题',source:'对标观察'});
 const a=content.saveNote('default',{create:true,title:'测试',topicId:t.id});
 const b=content.saveNote('default',{create:true,title:'测试',topicId:t.id});
 assert.equal(a.id,b.id);assert.equal(content.listTopics('default').find(x=>x.id===t.id).source,'对标观察');
});
test('来源任务重复请求复用、只有校验后的结果进入选题池，写稿失败可恢复',async()=>{
 const {TopicWorkflow}=await server('topic-workflow.mjs');const submitted=[];
 const source={id:'b_source',name:'测试对标',basis:'observed',notes:[{url:'https://www.xiaohongshu.com/explore/abcdef123',observedAt:'2026-10-17T00:00:00Z',title:'已观察标题',description:'仅观察内容'}]};
 const workflow=new TopicWorkflow({submit:t=>submitted.push(t),changed(){},sources:()=>[source]});
 const job=workflow.generate('default',{benchmarkId:'b_source'});
 assert.equal(workflow.generate('default',{benchmarkId:'b_source'}).id,job.id);assert.equal(submitted.length,1);
 store.writeJson(job.outputFile,{topics:[{title:'一个新角度',angle:'小团队检查清单',reason:'参考其结构，未核实实时热度',sourceUrls:[source.notes[0].url],score:99}]});
 workflow.finish(job.id);const done=workflow.jobs('default').find(j=>j.id===job.id);assert.equal(done.status,'done');
 const topic=content.listTopics('default').find(t=>t.id===done.topicIds[0]);assert.equal(topic.score,undefined);assert.equal(topic.basis,'observed');assert.equal(topic.sources[0].url,source.notes[0].url);
 const draft=workflow.write('default',{topicId:topic.id});assert.equal(workflow.write('default',{topicId:topic.id}).id,draft.id);
 workflow.finish(draft.id,'模拟失败');const retry=workflow.retry('default',draft.id);assert.equal(retry.noteId,draft.noteId);
 store.writeJson(retry.outputFile,{title:'小团队检查清单',content:'先写清目标，再检查素材是否齐全。',tags:['工作方法']});workflow.finish(retry.id);
 assert.equal(workflow.jobs('default').find(j=>j.id===retry.id).status,'done');assert.match(content.noteDetail('default',retry.noteId).content,/目标/);
 assert.equal(workflow.write('default',{topicId:topic.id}).noteId,draft.noteId);
});
test('伪造来源、空产出、跨账号和用户编辑冲突不被当成完成；重启允许重试',async()=>{
 const {TopicWorkflow}=await server('topic-workflow.mjs');const a=store.saveAccount({name:'隔离任务'}).id;const other=store.saveAccount({name:'另一账号'}).id;
 const source={id:'b_secure',name:'来源',basis:'observed',notes:[{url:'https://www.xiaohongshu.com/explore/abcdef456',title:'来源标题',observedAt:'2026-10-17T00:00:00Z'}]};
 const w=new TopicWorkflow({submit(){},sources:()=>[source]});let j=w.generate(a,{benchmarkId:source.id});
 store.writeJson(j.outputFile,{topics:[{title:'伪造',angle:'a',reason:'b',sourceUrls:['https://evil.example/']}]});w.finish(j.id);assert.equal(w.jobs(a)[0].status,'error');assert.equal(content.listTopics(a).length,0);assert.throws(()=>w.retry(other,j.id),/不存在/);
 j=w.retry(a,j.id);w.finish(j.id);assert.equal(w.jobs(a)[0].status,'error');
 j=w.retry(a,j.id);const recovered=new TopicWorkflow({submit(){},sources:()=>[source]});recovered.recover();assert.equal(recovered.jobs(a)[0].status,'error');assert.match(recovered.jobs(a)[0].error,/重启/);
 const t=content.saveTopic(a,{title:'待写稿'});const draft=w.write(a,{topicId:t.id});content.saveNote(a,{id:draft.noteId,content:'用户手写的内容'});
 store.writeJson(draft.outputFile,{title:'生成的标题',content:'生成的内容'});w.finish(draft.id);assert.match(w.jobs(a).find(x=>x.id===draft.id).error,/已被修改/);assert.equal(content.noteDetail(a,draft.noteId).content,'用户手写的内容');
});
test('重试不能覆盖用户只改过的标题；保留已有正文后持久任务应结束',async()=>{
 const {TopicWorkflow}=await server('topic-workflow.mjs');const a=store.saveAccount({name:'编辑保护'}).id;const w=new TopicWorkflow({submit(){},sources:()=>[]});
 const t=content.saveTopic(a,{title:'原题'});const j=w.write(a,{topicId:t.id});content.saveNote(a,{id:j.noteId,title:'用户标题'});w.finish(j.id,'网络失败');
 assert.throws(()=>w.retry(a,j.id),/手动修改/);
 content.saveNote(a,{id:j.noteId,content:'用户正文'});const kept=w.retry(a,j.id);assert.equal(kept.reused,true);assert.equal(w.jobs(a).find(x=>x.id===j.id).status,'done');assert.equal(content.noteDetail(a,j.noteId).title,'用户标题');
});
test('旧式已拆解报告及笔记仍能作为选题来源',async()=>{
 const {topicSources}=await server('topic-workflow.mjs');const a=store.saveAccount({name:'旧报告'}).id;
 const b=content.saveBenchmark(a,{name:'旧对标',status:'analyzed',url:'https://www.xiaohongshu.com/user/profile/legacy123'});
 const dir=path.join(ws,'accounts',a,'benchmarks',b.id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'report.md'),'已完成的结构拆解');store.writeJson(path.join(dir,'notes.json'),[{url:'https://www.xiaohongshu.com/explore/legacy123',title:'旧笔记'}]);
 const source=topicSources(a).find(s=>s.id===b.id);assert.equal(source?.basis,'analyzed');assert.equal(source.notes[0].title,'旧笔记');
});
