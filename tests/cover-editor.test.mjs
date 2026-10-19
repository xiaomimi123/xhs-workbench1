import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync(new URL('../xhs-workbench/web/modules/cover.js',import.meta.url),'utf8').replace(/^import .*;$/gm,'').replace(/export /g,'');
test('离开封面页后的旧刷新不得重画新页面',async()=>{
 let resolve;const pending=new Promise(r=>resolve=r);let draws=0;
 const ctx=vm.createContext({S:{accountId:'a',view:'cover'},acc:()=>'',api:async()=>pending,$:()=>({}),normalizeSpec:x=>x,setTimeout,clearTimeout});vm.runInContext(source,ctx);vm.runInContext("V.note={id:'n'};loadNote=async()=>true;",ctx);ctx.draw=()=>draws++;vm.runInContext('draw=globalThis.draw',ctx);
 const op=vm.runInContext("onContent({area:'notes'})",ctx);ctx.S.view='copywriting';resolve({items:[],jobs:[]});await op;assert.equal(draws,0);
});
