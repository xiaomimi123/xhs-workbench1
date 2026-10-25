import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const src=name=>fs.readFileSync(new URL('../xhs-workbench/web/'+name,import.meta.url),'utf8').replace(/^import .*;$/gm,'').replace(/export /g,'');
test('草案时间固定北京时间，拒绝溢出日期',()=>{const ctx=vm.createContext({});vm.runInContext(src('schedule-draft.js'),ctx);assert.equal(vm.runInContext("draftTime('2026-10-19T11:18')",ctx),'2026-10-19T03:18:00.000Z');assert.throws(()=>vm.runInContext("draftTime('2026-02-30T11:18')",ctx),/时间/);});
test('旧账号加载完成不得绘制新账号页面',async()=>{let resolve;const pending=new Promise(r=>resolve=r);let draws=0;const ctx=vm.createContext({S:{accountId:'a',view:'schedule'},api:()=>pending,acc:()=>'',esc:x=>x});vm.runInContext(src('modules/schedule.js'),ctx);ctx.draw=()=>draws++;vm.runInContext('draw=globalThis.draw',ctx);const p=vm.runInContext('render({})',ctx);ctx.S.accountId='b';resolve({items:[],publish:{}});await p;assert.equal(draws,0);});
test('检查期间离开再返回，完成后恢复当前面板按钮',async()=>{let resolve;const pending=new Promise(r=>resolve=r);const ctx=vm.createContext({S:{accountId:'a',view:'schedule'},api:()=>pending,esc:x=>x,opt:()=>'',toast(){},CustomEvent:class{}});vm.runInContext(src('schedule-draft.js'),ctx);const root=()=>({isConnected:true,innerHTML:'',dispatchEvent(){}});ctx.old=root();ctx.fresh=root();vm.runInContext("renderDraft(old,[{id:'n',title:'test'}],[])",ctx);const action=vm.runInContext("old.onclick({target:{closest:()=>({dataset:{draft:'check'}})},stopPropagation(){}})",ctx);ctx.old.isConnected=false;vm.runInContext("renderDraft(fresh,[{id:'n',title:'test'}],[])",ctx);assert.match(ctx.fresh.innerHTML,/data-draft="check" disabled/);resolve({ok:true,images:[],errors:[],warnings:[],unverified:[]});await action;assert.doesNotMatch(ctx.fresh.innerHTML,/data-draft="check" disabled/);});

test('发布排期只提供手动助手及提醒，保留草案面板',()=>{
 const ctx=vm.createContext({S:{view:'schedule'},acc:()=>'',esc:x=>x,icon:()=>'',opt:(v,label)=>`<option value="${v}">${label}</option>`,fmtTime:x=>x,renderDraft(){},draftBusy:()=>false,readonlyNotice:()=>''});
 vm.runInContext(src('modules/schedule.js'),ctx);
 ctx.main={innerHTML:'',addEventListener(){},querySelector(){return {};}};
 vm.runInContext("V.cfg={publish:{defaultMode:'auto',dailyLimit:3,minIntervalMin:60}};V.notes=[{id:'n2',title:'可排期'}];V.items=[{id:'s1',noteId:'n1',title:'历史自动',mode:'auto',status:'scheduled',publishAt:new Date().toISOString()},{id:'s2',title:'到点',mode:'auto',status:'due',publishAt:new Date().toISOString()}];V.showSettings=true;draw(main)",ctx);
 assert.doesNotMatch(ctx.main.innerHTML,/value="auto"|data-act="agent-now"|data-act="switch-mode"/);
 assert.match(ctx.main.innerHTML,/手动/);assert.match(ctx.main.innerHTML,/draft-panel/);
});
