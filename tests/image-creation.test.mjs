import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync(new URL('../xhs-workbench/web/image-workspace.js',import.meta.url),'utf8').replace(/^import .*;$/gm,'').replace(/export /g,'');
function setup(api){const root={isConnected:true,innerHTML:''};const ctx=vm.createContext({S:{accountId:'a',view:'cover'},api,esc:x=>x,fileUrl:x=>x,toast:()=>{},structuredClone,root});vm.runInContext(fs.readFileSync(new URL('../xhs-workbench/web/image-polling.js',import.meta.url),'utf8').replace(/^import .*;$/gm,'').replace(/export /g,''),ctx);vm.runInContext(fs.readFileSync(new URL('../xhs-workbench/web/image-service-settings.js',import.meta.url),'utf8').replace(/^import .*;$/gm,'').replace(/export /g,''),ctx);vm.runInContext(source,ctx);return {root,ctx};}
test('自由生图无需笔记；不同账号、入口和草稿隔离输入',async()=>{const {root,ctx}=setup(async()=>({items:[]}));await vm.runInContext("mountCreation(root,{entry:'free'})",ctx);assert.match(root.innerHTML,/无需先写文案/);vm.runInContext("creationForm('a','free').prompt='hello'",ctx);for(const args of ["'b','free'","'a','reference'","'a','note','n'"])assert.equal(vm.runInContext(`creationForm(${args}).prompt`,ctx),'');});
test('生成提交冻结标题和引用角色；等待期间输入不会丢失',async()=>{let resolve,payload;const pending=new Promise(r=>resolve=r);const {root,ctx}=setup(async(method,url,data)=>{if(method==='GET')return {items:[]};payload=data;await pending;return {};});await vm.runInContext("mountCreation(root,{entry:'free'})",ctx);vm.runInContext("Object.assign(creationForm('a','free'),{prompt:'场景',headline:'原标题',references:[{file:'ref.png',role:'product',source:'studio'}]})",ctx);const op=root.onclick({target:{closest:()=>({dataset:{createAction:'start'}})},stopPropagation(){}});root.oninput({target:{dataset:{createField:'headline'},value:'新标题'}});resolve();await op;assert.equal(payload.noteId,null);assert.equal(payload.headline,'原标题');assert.equal(payload.references[0].role,'product');assert.match(root.innerHTML,/新标题/);assert.equal(vm.runInContext("creationBusy('a','free')",ctx),false);});
test('旧账号请求完成不能替换新账号页面',async()=>{let resolve;const pending=new Promise(r=>resolve=r);const {root,ctx}=setup(async method=>method==='GET'?{items:[]}:pending);await vm.runInContext("mountCreation(root,{entry:'free'})",ctx);const op=root.onclick({target:{closest:()=>({dataset:{createAction:'start'}})},stopPropagation(){}});ctx.S.accountId='b';root.innerHTML='账号乙';resolve({});await op;assert.equal(root.innerHTML,'账号乙');});

// ── 首屏简化：画面要求在最前，低频设置折叠；APIMart 没密钥时就地提示 ──
const api = (service) => async (_m, url) => (url.includes('/api/images/service') ? service : { items: [] });
const idx = (html, text) => html.indexOf(text);
test('自由生图：画面要求和风格排在折叠的“更多设置”之前，服务/成品方式/标题/数量/参考图都在折叠里', async () => {
  const { root, ctx } = setup(api({ defaultProvider: 'current-agent', hasKey: false }));
  await vm.runInContext("mountCreation(root,{entry:'free'})", ctx);
  const html = root.innerHTML;
  const details = idx(html, '<details class="creation-advanced"');
  assert.ok(details > 0);
  assert.ok(idx(html, 'data-create-field="prompt"') < details);
  assert.ok(idx(html, 'data-create-field="style"') < details);
  for (const key of ['provider', 'outputMode', 'headline', 'count', 'uploadRole']) assert.ok(idx(html, `data-create-field="${key}"`) > details, key);
  assert.ok(idx(html, '创建生图任务') > idx(html, '</details>'));
  assert.doesNotMatch(html, /<details class="creation-advanced" open/); // 默认折叠
});
test('参考图复刻：参考图保持在折叠之外，因为这个入口必须先选参考图', async () => {
  const { root, ctx } = setup(api({ defaultProvider: 'current-agent' }));
  await vm.runInContext("mountCreation(root,{entry:'reference'})", ctx);
  const html = root.innerHTML;
  assert.ok(idx(html, 'data-create-field="uploadRole"') < idx(html, '<details class="creation-advanced"'));
  assert.match(html, /更多设置：生图服务、成品方式、标题文字、候选数量</);
});
test('选了 APIMart 但没配密钥：就地提示并给出去设置的入口；配了密钥就不提示', async () => {
  const none = setup(api({ defaultProvider: 'apimart', hasKey: false }));
  await vm.runInContext("mountCreation(root,{entry:'free'})", none.ctx);
  assert.match(none.root.innerHTML, /还没有配置 APIMart 密钥[\s\S]*data-nav="settings"/);
  const ok = setup(api({ defaultProvider: 'apimart', hasKey: true }));
  await vm.runInContext("mountCreation(root,{entry:'free'})", ok.ctx);
  assert.doesNotMatch(ok.root.innerHTML, /还没有配置 APIMart 密钥/);
});
test('已有参考图被勾选时折叠区自动展开，避免用户看不到已选内容', async () => {
  const { root, ctx } = setup(api({ defaultProvider: 'current-agent' }));
  await vm.runInContext("mountCreation(root,{entry:'free'})", ctx);
  vm.runInContext("creationForm('a','free').references=[{file:'r.png',role:'style',source:'studio'}];creationForm('a','free').redraw()", ctx);
  assert.match(root.innerHTML, /<details class="creation-advanced" open/);
});
