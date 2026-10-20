import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync(new URL('../xhs-workbench/web/modules/cover.js',import.meta.url),'utf8').replace(/^import .*;$/gm,'').replace(/export /g,'');
test('离开封面页后的旧刷新不得重画新页面',async()=>{
 let resolve;const pending=new Promise(r=>resolve=r);let draws=0;
 const ctx=vm.createContext({S:{accountId:'a',view:'cover'},acc:()=>'',api:async()=>pending,$:()=>({}),normalizeSpec:x=>x,imageBusy:()=>false,setTimeout,clearTimeout});vm.runInContext(source,ctx);vm.runInContext("V.note={id:'n'};loadNote=async()=>true;",ctx);ctx.draw=()=>draws++;vm.runInContext('draw=globalThis.draw',ctx);
 const op=vm.runInContext("onContent({area:'notes'})",ctx);ctx.S.view='copywriting';resolve({items:[],jobs:[]});await op;assert.equal(draws,0);
});
test('内容卡片编辑中套用生图后保存到封面接口',async()=>{
 let apply,endpoint;
 const ctx=vm.createContext({S:{accountId:'a',view:'cover'},fileUrl:x=>x,imageBusy:()=>false,mountImageStudio:(_r,_n,cb)=>apply=cb,esc:x=>x,icon:()=>'',opt:()=>'',mediaHtml:()=>'',bindMedia:()=>{},$:()=>({}),normalizeSpec:x=>x,toast:()=>{},confirm:()=>true,structuredClone,drawCover:async()=>{},document:{createElement:()=>({toDataURL:()=> 'png'})},api:async(_m,p)=>{endpoint=p;return {};},setTimeout,clearTimeout});vm.runInContext(source,ctx);vm.runInContext("V.note={id:'n',content:'正文',sources:[],images:[],media:[]};V.notes=[V.note];V.jobs=[];V.spec={template:'list'};V.editCard={id:'card',index:0};V.state={version:'v',coverHash:'c'};formHtml=()=>'';redraw=()=>{};bind=()=>{};draw({});",ctx);
 await apply({file:'generated.png',note:{id:'n',content:'正文',sources:[],images:['generated.png'],media:[]}});assert.equal(vm.runInContext('V.editCard',ctx),null);vm.runInContext('loadNote=async()=>false',ctx);await vm.runInContext('save()',ctx);assert.ok(endpoint.startsWith('/api/covers/save?'));
});
test('刷新等待中开始生图操作，旧刷新不得替换操作面板',async()=>{
 let resolve,busy=false,draws=0;const pending=new Promise(r=>resolve=r);const ctx=vm.createContext({S:{accountId:'a',view:'cover'},imageBusy:()=>busy,acc:()=>'',api:()=>pending,$:()=>({}),document:{activeElement:null},normalizeSpec:x=>x,setTimeout,clearTimeout});vm.runInContext(source,ctx);vm.runInContext("V.note={id:'n'};loadNote=async()=>true",ctx);ctx.draw=()=>draws++;vm.runInContext('draw=globalThis.draw',ctx);const op=vm.runInContext("onContent({area:'notes'})",ctx);busy=true;resolve({items:[],jobs:[]});await op;assert.equal(draws,0);
});
