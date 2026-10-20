import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync(new URL('../xhs-workbench/web/modules/video-creation.js',import.meta.url),'utf8').replace(/^import .*$/gm,'').replace(/export /g,'');
function setup(){const calls=[];const root={innerHTML:'',querySelectorAll:()=>[]};const ctx=vm.createContext({S:{accountId:'a',view:'video'},root,structuredClone,esc:String,fileUrl:String,api:async(method,url,data)=>{calls.push({method,url,data});return {items:[]};},startVideoPolling:()=>()=>{},go:()=>{}});vm.runInContext(source,ctx);return {ctx,root,calls};}
test('image handoff prefills i2v without submission, preserves exact duration and explicit action',async()=>{const {ctx,root,calls}=setup();await vm.runInContext("render(root,{imageJobId:'imagejob_test',index:0})",ctx);assert.match(root.innerHTML,/5.17 秒/);assert.equal(calls.every(c=>c.method==='GET'),true);await root.onclick({target:{closest:()=>({dataset:{videoAction:'start'}})}});const submitted=calls.find(c=>c.method==='POST');assert.match(submitted.url,/videos\/start/);assert.equal(submitted.data.mode,'i2v');assert.equal(submitted.data.references[0],'image:imagejob_test:0');assert.equal(submitted.data.seconds,5);});
test('account form state is isolated',()=>{const {ctx}=setup();vm.runInContext("videoForm('a').prompt='private'",ctx);assert.equal(vm.runInContext("videoForm('b').prompt",ctx),'');assert.equal(vm.runInContext('durationLabel(8)',ctx),'8.00 秒 · 192 帧 / 24fps');});
test('local content notification refreshes records without a generation POST',async()=>{const {ctx,root,calls}=setup();await vm.runInContext('render(root)',ctx);const before=calls.length;await vm.runInContext("onContent({area:'videos',account:'a'})",ctx);assert.ok(calls.length>before);assert.equal(calls.every(c=>c.method==='GET'),true);});
test('reference modes show video input and correctly separate product-image selection',async()=>{const {ctx,root}=setup();vm.runInContext("videoForm('a').mode='v2v'",ctx);await vm.runInContext('render(root)',ctx);assert.match(root.innerHTML,/参考视频复刻/);assert.match(root.innerHTML,/data-video-file/);assert.doesNotMatch(root.innerHTML,/data-video-upload/);vm.runInContext("videoForm('a').mode='rv2v'",ctx);await vm.runInContext('render(root)',ctx);assert.match(root.innerHTML,/data-video-upload/);});
test('description generation is separate from paid generation; explicit apply preserves previous prompt',async()=>{const {ctx,root,calls}=setup();ctx.api=async(method,url,data)=>{calls.push({method,url,data});if(url.includes('/descriptions'))return method==='GET'?{items:[{id:'d1',status:'done',sourceVideoId:'vref_x',result:{prompt:'new action',observations:[],limitations:[]}}]}:{id:'d1'};return {items:[]};};vm.runInContext("Object.assign(videoForm('a'),{mode:'v2v',sourceVideoId:'vref_x',prompt:'original'})",ctx);await vm.runInContext('render(root)',ctx);await root.onclick({target:{closest:()=>({dataset:{videoAction:'describe'}})}});assert.equal(calls.filter(c=>c.method==='POST').length,1);assert.match(calls.find(c=>c.method==='POST').url,/descriptions/);assert.equal(vm.runInContext("videoForm('a').prompt",ctx),'original');await root.onclick({target:{closest:()=>({dataset:{videoAction:'apply',job:'d1'}})}});assert.equal(vm.runInContext("videoForm('a').prompt",ctx),'new action');assert.equal(vm.runInContext("videoForm('a').previousPrompt",ctx),'original');assert.equal(calls.filter(c=>c.method==='POST').length,1);});

// ── 首屏简化：方式名用人话并带一句说明；技术参数不占正文；长须知折叠 ──
test('生成方式用人话命名，并随选择显示一句说明（不出现 v2v/rv2v 缩写）', async () => {
  const { ctx, root } = setup();
  await vm.runInContext('render(root)', ctx);
  const visible = root.innerHTML.replace(/<[^>]*>/g, '|'); // 只看用户看得见的文字，不看 value 等内部取值
  assert.doesNotMatch(visible, /v2v|rv2v/);
  assert.match(root.innerHTML, /复刻参考视频，并换成我的产品/);
  assert.match(root.innerHTML, /只根据文字描述生成视频/);
  vm.runInContext("videoForm('a').mode='rv2v'", ctx);
  await vm.runInContext('render(root)', ctx);
  assert.match(root.innerHTML, /保留它的动作和镜头，并把主体换成你选的产品图/);
});
test('时长只在正文显示“预计成片约 X 秒”，帧数/fps 只放在提示里；9:16 才提示对齐像素', async () => {
  const { ctx, root } = setup();
  await vm.runInContext('render(root)', ctx);
  const body = root.innerHTML.replace(/title="[^"]*"/g, '');
  assert.match(body, /预计成片约 5\.2 秒/);
  assert.doesNotMatch(body, /124 帧|24fps/);
  assert.doesNotMatch(body, /对齐像素/);
  vm.runInContext("videoForm('a').ratio='9:16'", ctx);
  await vm.runInContext('render(root)', ctx);
  assert.match(root.innerHTML, /对齐像素/);
});
test('提交前须知折叠，但完整内容仍在，并保留“提交后不能取消”的醒目一句', async () => {
  const { ctx, root } = setup();
  await vm.runInContext('render(root)', ctx);
  assert.match(root.innerHTML, /提交后不能取消；生成需要几分钟/);
  assert.match(root.innerHTML, /<details class="video-notice"><summary>提交前须知<\/summary>[\s\S]*发送给已配置的视频服务[\s\S]*单轮自动取回最长30分钟/);
});

// ── 描述任务的等待与失败：已用时间、看图自检失败的出路 ──
test('描述任务：检测/分析中显示已用时间；自检未通过时说明不用 AI 描述也能继续，并给出去设置的按钮', async () => {
  const { ctx, root } = setup();
  const failed = { id: 'vdesc_1', sourceVideoId: 'vref_a', status: 'error', createdAt: new Date().toISOString(), error: '当前 Agent 的模型没有通过看图自检：……', visionCheck: { passed: false, correct: 0 } };
  const checking = { id: 'vdesc_2', sourceVideoId: 'vref_a', status: 'checking', createdAt: new Date(Date.now() - 65000).toISOString() };
  vm.runInContext('globalThis.__jobs=' + JSON.stringify([checking, failed]), ctx);
  const ctx2 = vm.createContext({ ...ctx, S: { accountId: 'a', view: 'video' }, api: async (method, url) => (url.includes('/descriptions') ? { items: [checking, failed] } : url.includes('/reference-videos') ? { items: [{ id: 'vref_a', title: 'ref', media: { duration: 3 } }] } : { items: [] }), root, esc: String, fileUrl: String, structuredClone, startVideoPolling: () => () => {}, go: () => {} });
  vm.runInContext(source, ctx2);
  vm.runInContext("videoForm('a').mode='rv2v';videoForm('a').sourceVideoId='vref_a'", ctx2);
  await vm.runInContext('render(root)', ctx2);
  const html = root.innerHTML;
  assert.match(html, /正在检测 Agent 能否看清图片/);
  assert.match(html, /已用 <span data-elapsed="[^"]+">1:0\d<\/span>/);
  assert.match(html, /不用 AI 描述也能继续/);
  assert.match(html, /data-video-action="settings">去连接与设置换 Agent/);
  assert.match(html, /每次会先让它做一次“看图自检”/);
});

test('视频任务排队/生成中显示已等待时间和按模式区分的预计时长；完成的不显示', async () => {
  const mk = (over) => ({ id: 'videojob_x', status: 'running', createdAt: new Date(Date.now() - 125000).toISOString(), remoteId: 'r1', input: { prompt: 'p', mode: 't2v', width: 576, height: 768, total_frames: 73, frame_rate: 24 }, ...over });
  const render = async (jobs) => {
    const root = { innerHTML: '', querySelectorAll: () => [] };
    const ctx = vm.createContext({ S: { accountId: 'a', view: 'video' }, root, structuredClone, esc: String, fileUrl: String, api: async (_m, url) => ({ items: url.includes('/videos/jobs') ? jobs : [] }), startVideoPolling: () => () => {}, go: () => {} });
    vm.runInContext(source, ctx);
    await vm.runInContext('render(root)', ctx);
    return root.innerHTML;
  };
  const t2v = await render([mk({})]);
  assert.match(t2v, /已等待 <span data-elapsed="[^"]+">2:0\d<\/span> · 通常需要 1–3 分钟/);
  const clone = await render([mk({ input: { prompt: 'p', mode: 'rv2v', width: 576, height: 768, total_frames: 73, frame_rate: 24 } })]);
  assert.match(clone, /参考视频复刻通常需要几分钟/);
  assert.doesNotMatch(await render([mk({ status: 'done', path: 'x.mp4', media: { width: 1, height: 1, duration: 3 } })]), /已等待/);
  assert.match(await render([mk({ status: 'queued' })]), /已等待/);
});
