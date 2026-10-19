import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync(new URL('../xhs-workbench/web/modules/copywriting.js',import.meta.url),'utf8').replace(/^import .*;$/gm,'').replace(/export /g,'');
function setup(api){const panel={innerHTML:''};const ctx=vm.createContext({api,S:{accountId:'a'},acc:s=>s||'',esc:s=>String(s),fmtTime:s=>s,toast(){},$:s=>s==='#copy-jobs'?panel:null,setTimeout,clearTimeout});vm.runInContext(source,ctx);vm.runInContext("V.current='n';V.note={id:'n',title:'旧标题',content:'原稿',tags:[]};V.jobs=[];",ctx);return {ctx,panel,run:s=>vm.runInContext(s,ctx)};}
test('异步读取期间输入的新修改不会被刷新覆盖',async()=>{
 let resolve;const pending=new Promise(r=>resolve=r);const {run}=setup(async url=>pending);
 const operation=run("loadNote('n',{guard:true})");run("V.revision++;V.dirty=true;V.note.title='用户新标题'");resolve({id:'n',title:'服务端旧标题',items:[]});
 assert.equal(await operation,false);assert.equal(run('V.note.title'),'用户新标题');assert.equal(run('V.dirty'),true);
});
test('检查报告在未保存的编辑后立即提示过期',()=>{
 const {run}=setup(()=>{});run("V.jobs=[{kind:'check',status:'done',stale:false,result:{summary:'检查完成',issues:[],unverified:[]},lint:{titleLen:3,bodyLen:5,issues:[]}}]");
 assert.doesNotMatch(run('jobsHtml()'),/报告已过期/);run('V.dirty=true');assert.match(run('jobsHtml()'),/报告已过期/);
});
test('保存后刷新列表期间的新输入让保存返回未完成，调用者不得重绘',async()=>{
 let resolve;const pending=new Promise(r=>resolve=r);const {ctx,run}=setup(async method=>method==='POST'?{id:'n',title:'旧标题',content:'原稿',tags:[]}:pending);
 const fields={'#note-title':{value:'旧标题'},'#note-body':{value:'原稿'},'#note-tags':{value:''},'#note-status':{value:'draft'},'#note-visibility':{value:'public'}};ctx.$=s=>fields[s]||{};
 const operation=run('save(true)');await new Promise(r=>setImmediate(r));run('V.revision++;V.dirty=true');resolve({items:[]});assert.equal(await operation,false);assert.equal(run('V.dirty'),true);
});
test('重试请求期间的新输入不被读取结果清除',async()=>{
 let resolve;const pending=new Promise(r=>resolve=r);const {ctx,run}=setup(async method=>method==='POST'?pending:{items:[]});ctx.main={};run('bind(main)');
 const operation=ctx.main.onclick({target:{closest:()=>({dataset:{copyRetry:'job'}})}});run("V.revision++;V.dirty=true;V.note.title='新的输入'");resolve({});await operation;
 assert.equal(run('V.dirty'),true);assert.equal(run('V.note.title'),'新的输入');
});
