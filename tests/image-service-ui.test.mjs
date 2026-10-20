import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=name=>fs.readFileSync(new URL('../xhs-workbench/web/'+name,import.meta.url),'utf8').replace(/^import .*;$/gm,'').replace(/export /g,'');
function setup(api,view='cover',module='image-workspace.js'){const root={isConnected:true,innerHTML:''};const ctx=vm.createContext({S:{accountId:'a',view},api,root,esc:x=>String(x??''),fileUrl:x=>x,toast:()=>{},structuredClone});vm.runInContext(source('image-polling.js'),ctx);vm.runInContext(source('image-service-settings.js'),ctx);if(module)vm.runInContext(source(module),ctx);return {root,ctx};}
const click=(root,attribute,action,id)=>root.onclick({target:{closest:()=>({dataset:{[attribute]:action,job:id}})},stopPropagation(){}});
test('APIMart selection restricts count, submits settings and queries without a second generation',async()=>{const posts=[];const job={id:'j',provider:'apimart',taskId:'remote-1',status:'needs_review',assets:[],error:'等待核对'};const {root,ctx}=setup(async(method,url,data)=>{if(method!=='GET'){posts.push({url,data});return {};}return url==='/api/images/service'?{defaultProvider:'apimart',model:'gpt-image-2-ext',size:'3:4',resolution:'2k'}:{items:url.includes('/jobs')?[job]:[]};});await vm.runInContext("mountCreation(root,{entry:'free'})",ctx);assert.match(root.innerHTML,/第三方 APIMart/);assert.match(root.innerHTML,/<option disabled >2/);assert.doesNotMatch(root.innerHTML,/生成任务指令|复制任务指令/);assert.match(root.innerHTML,/查询进度/);await click(root,'createAction','start');assert.equal(posts[0].data.provider,'apimart');assert.equal(posts[0].data.count,1);assert.equal(posts[0].data.size,'3:4');assert.equal(posts[0].data.model,'gpt-image-2-ext');await click(root,'createAction','query','j');assert.match(posts[1].url,/\/api\/images\/refresh/);assert.equal(posts[1].data.id,'j');assert.equal(posts.length,2);});
test('note editor APIMart records never expose Agent handoff',async()=>{const posts=[];const {root,ctx}=setup(async(method,url,data)=>{if(method!=='GET'){posts.push({url,data});return {};}return url==='/api/images/service'?{defaultProvider:'apimart'}:{items:[{id:'j',provider:'apimart',status:'processing',taskId:'task',assets:[],handoff:'SHOULD_NOT_RENDER'}]};},'cover','image-studio.js');await vm.runInContext("mountImageStudio(root,{id:'n',images:[]},()=>{})",ctx);assert.doesNotMatch(root.innerHTML,/SHOULD_NOT_RENDER|复制交接指令/);await click(root,'imageAction','query','j');assert.match(posts[0].url,/\/refresh/);});
test('settings keep blank keys out of payload and never populate saved secret',async()=>{const calls=[];const settings={defaultProvider:'current-agent',model:'gpt-image-2',size:'16:9',resolution:'2k',hasKey:true,keyMasked:'••••1234'};const {root,ctx}=setup(async(method,url,data)=>{calls.push({method,url,data});return method==='POST'?{connected:true,authenticated:true,generationTested:false}:settings;},'settings',null);await vm.runInContext('mountImageServiceSettings(root)',ctx);assert.match(root.innerHTML,/type="password" data-service-key/);assert.match(root.innerHTML,/••••1234/);await click(root,'serviceAction','save');assert.equal(Object.hasOwn(calls[1].data,'apiKey'),false);root.oninput({target:{matches:()=>true,value:'new-key'}});await click(root,'serviceAction','save');assert.equal(calls[2].data.apiKey,'new-key');assert.doesNotMatch(root.innerHTML,/new-key/);await click(root,'serviceAction','test');assert.equal(calls[3].url,'/api/images/service/test');assert.match(root.innerHTML,/连接与认证成功/);assert.equal(JSON.stringify(calls[3].data),'{}');await click(root,'serviceAction','delete');assert.equal(calls[4].data.deleteKey,true);});

// ── 进度与提示：已等待时间、被拒绝卡片、第三方发送提醒 ──
test('进行中的任务显示已等待时间和预计时长；完成的不显示', () => {
  const { ctx } = setup(async () => ({ items: [] }), 'cover', null);
  const j = { id: 'j', provider: 'apimart', status: 'processing', taskId: 'task_1', createdAt: new Date(1_000_000).toISOString(), model: 'gpt-image-2', size: '3:4', resolution: '1k' };
  const html = vm.runInContext('imageJobProgress', ctx)(j, 'data-create-action', false, 1_000_000 + 83_000);
  assert.match(html, /已等待 <span data-elapsed="[^"]+">1:23<\/span>/);
  assert.match(html, /通常需要 1–2 分钟/);
  assert.match(html, /页面会自动更新进度/);
  assert.doesNotMatch(vm.runInContext('imageJobProgress', ctx)({ ...j, status: 'done' }, 'a', false), /已等待|查询进度/);
});
test('被网关明确拒绝的任务：不再出现“查询进度”和“核对任务编号”；密钥问题给出去设置的按钮', () => {
  const { ctx } = setup(async () => ({ items: [] }), 'cover', null);
  const f = vm.runInContext('imageJobProgress', ctx);
  const rejected = { id: 'j', provider: 'apimart', status: 'error', notSubmitted: true, diag: { httpStatus: 401 }, model: 'm', size: 's', resolution: 'r' };
  const html = f(rejected, 'data-create-action', false);
  assert.doesNotMatch(html, /查询进度|核对服务记录/);
  assert.match(html, /这次没有创建任务，修改后可以重新提交/);
  assert.match(html, /data-nav="settings">去检查 API Key/);
  assert.doesNotMatch(f({ ...rejected, diag: { httpStatus: 402 } }, 'a', false), /检查 API Key/);
});
test('参考图会离开本机：APIMart 点明第三方，当前 Agent 点明交给它的生图工具；没有参考图且是 Agent 时不提示', () => {
  const { ctx } = setup(async () => ({ items: [] }), 'cover', null);
  const f = vm.runInContext('imageSendNotice', ctx);
  assert.match(f('apimart', 2, true), /将把 2 张参考图和画面要求、笔记文案发送给第三方 APIMart/);
  assert.match(f('apimart', 0, false), /将把画面要求发送给第三方 APIMart/);
  assert.match(f('current-agent', 1), /1 张参考图会交给你当前连接的 Agent/);
  assert.equal(f('current-agent', 0), '');
});
test('已等待时间每秒更新文字、不重绘；页面离开后停止', () => {
  let t = 1_000_000; const els = [{ dataset: { elapsed: new Date(1_000_000).toISOString() }, textContent: '' }];
  const intervals = []; let current = true; let cleared = 0;
  const ctx2 = vm.createContext({ setInterval: (fn) => { intervals.push(fn); return 1; }, clearInterval: () => { cleared++; }, Date });
  vm.runInContext(source('image-polling.js'), ctx2);
  const root = { querySelectorAll: () => els };
  vm.runInContext('startImagePolling', ctx2)({ root, formatElapsed: (ms) => `${Math.floor(ms / 1000)}s`, current: () => current, jobs: () => [], refresh: async () => ({}), load: async () => {}, draw: () => {}, now: () => t, setTimer: () => 1, clearTimer: () => {} });
  t += 5000; intervals[0]();
  assert.equal(els[0].textContent, '5s');
  current = false; intervals[0]();
  assert.equal(cleared, 1);
});
