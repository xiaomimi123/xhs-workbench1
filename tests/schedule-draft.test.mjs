import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {useTempWorkspace,server} from './helpers.mjs';useTempWorkspace();const store=await server('store.mjs'),c=await server('content.mjs'),ops=await server('automation.mjs');store.ensureWorkspace();
const {preflight}=await server('preflight.mjs');
const later=()=>new Date(Date.now()+3600000).toISOString();
function setup(){const a=store.saveAccount({name:'排期检查'}).id;ops.saveAutomation(a,{curator:{everyHours:0}});const n=c.saveNote(a,{create:true,title:'审片流程',content:'先检查主题，再确认素材。',tags:['审片'],coverMode:'first'});c.uploadNoteImage(a,n.id,'one.png',fs.readFileSync(new URL('./fixtures/card.png',import.meta.url)).toString('base64'));return {a,n};}
test('检查实际图片和文案，缺图与同名内容变化使指纹变化',()=>{
 const {a,n}=setup();const report=preflight(a,n.id);assert.equal(report.ok,true);assert.equal(report.images.length,1);
 const file=path.join(c.accRoot(a),'notes',n.id,'images/one.png');fs.appendFileSync(file,'changed');assert.notEqual(preflight(a,n.id).fingerprint,report.fingerprint);
 fs.unlinkSync(file);assert.equal(preflight(a,n.id).ok,false);
});
test('草案创建、重复、改期、取消保留稿件；拒绝过期检查与非法转换',()=>{
 const {a,n}=setup();let r=preflight(a,n.id);const j=ops.scheduleDraft(a,{noteId:n.id,publishAt:later(),fingerprint:r.fingerprint});
 assert.equal(j.mode,'draft');assert.equal(j.status,'planned');assert.equal(ops.scheduleDraft(a,{noteId:n.id,publishAt:later(),fingerprint:r.fingerprint}).id,j.id);
 assert.equal(c.noteDetail(a,n.id).status,'draft');assert.throws(()=>ops.updateSchedule(a,{id:j.id,mode:'auto'}),/草案/);assert.throws(()=>ops.updateSchedule(a,{id:j.id,status:'published'}),/草案/);
 assert.throws(()=>ops.scheduleDraft(a,{id:j.id,publishAt:'yesterday',fingerprint:r.fingerprint}),/时间/);
 c.saveNote(a,{id:n.id,content:'新正文'});assert.throws(()=>ops.scheduleDraft(a,{id:j.id,publishAt:later(),fingerprint:r.fingerprint}),/检查|变化/);
 r=preflight(a,n.id);const changed=ops.scheduleDraft(a,{id:j.id,publishAt:new Date(Date.now()+7200000).toISOString(),fingerprint:r.fingerprint});assert.notEqual(changed.publishAt,j.publishAt);
 assert.throws(()=>ops.cancelDraft('default',j.id),/不存在/);ops.cancelDraft(a,j.id);assert.equal(ops.listSchedule(a).find(x=>x.id===j.id).status,'cancelled');assert.equal(c.noteDetail(a,n.id).content,'新正文');
});
test('草案到点不分派发布、不提醒发布且不改变草稿状态',()=>{
 const {a,n}=setup();const r=preflight(a,n.id);const j=ops.scheduleDraft(a,{noteId:n.id,publishAt:later(),fingerprint:r.fingerprint});
 const file=path.join(c.accRoot(a),'schedule.json'),data=store.readJson(file);Object.assign(data.items.find(x=>x.id===j.id),{publishAt:new Date(Date.now()-60000).toISOString(),status:'scheduled'});store.writeJson(file,data);
 const tasks=[],notifications=[];const scheduler=new ops.Scheduler({runTask:(account,text)=>{tasks.push({account,text});return 'unexpected';},notify:e=>notifications.push(e),log(){}});scheduler.tick();assert.equal(tasks.filter(t=>t.account===a).length,0);assert.equal(notifications.filter(e=>e.account===a).length,0);assert.equal(c.noteDetail(a,n.id).status,'draft');
});
test('伪造 PNG 与超长标题阻断检查',()=>{
 const {a,n}=setup();const file=path.join(c.accRoot(a),'notes',n.id,'images/one.png');const b=Buffer.alloc(28);Buffer.from([137,80,78,71,13,10,26,10]).copy(b);b.writeUInt32BE(1080,16);b.writeUInt32BE(1440,20);b.write('IEND',24);fs.writeFileSync(file,b);assert.equal(preflight(a,n.id).ok,false);
 fs.copyFileSync(new URL('./fixtures/card.png',import.meta.url),file);c.saveNote(a,{id:n.id,title:'这是一个超过二十字限制不能通过发布前检查的标题'});assert.equal(preflight(a,n.id).ok,false);
});
