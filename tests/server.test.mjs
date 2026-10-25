// 本地服务集成测试：真实启动 server.mjs，用假 agent 走完整的 HTTP 流程
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { useTempWorkspace, server, fakeAdapter, SKILL } from './helpers.mjs';

const WS = useTempWorkspace();
const store = await server('store.mjs');
store.ensureWorkspace();
store.saveBridgeConfig({ mode: 'cli', adapter: fakeAdapter('claude-stream-json'), testedAt: new Date().toISOString() });

const SERVER = path.join(SKILL, 'server', 'server.mjs');
let proc;
let base;
let token;

function startServer() {
  return spawn(process.execPath, [SERVER], { env: { ...process.env, XHS_WORKSPACE: WS, FAKE_AGENT_MODE: 'claude-json' }, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function waitFor(fn, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('等待超时');
}

const api = async (method, p, body, headers = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': token, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

before(async () => {
  proc = startServer();
  const info = await waitFor(() => store.readJson(path.join(WS, 'run', 'server.json'), null));
  base = `http://127.0.0.1:${info.port}`;
  token = fs.readFileSync(path.join(WS, 'run', 'token'), 'utf8').trim();
  await waitFor(async () => (await fetch(`${base}/api/health`).catch(() => null))?.ok);
});

after(() => proc && proc.kill());

test('安全：没有令牌 401，非本机 Host 403，静态页面无需令牌', async () => {
  assert.equal((await api('GET', '/api/state', null, { 'X-Workbench-Token': 'wrong' })).status, 401);
  // fetch 不允许改 Host，用 http 模块伪造 DNS 重绑定的请求
  const status = await new Promise((resolve, reject) => {
    http.get(`${base}/api/health`, { headers: { Host: 'evil.example.com' } }, (res) => resolve(res.statusCode)).on('error', reject);
  });
  assert.equal(status, 403);
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/../../etc/passwd`)).status, 404);
});

test('单实例：同一数据目录再启动一个服务会自动退出', async () => {
  const second = startServer();
  const code = await new Promise((resolve) => second.on('exit', resolve));
  assert.equal(code, 0);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test('对话：发送 → agent 回复（流式 JSON）→ 记录会话 id', async () => {
  const send = await api('POST', '/api/chat/send', { accountId: 'default', text: '你好' });
  assert.equal(send.status, 200);
  const id = send.body.id;
  const s = await waitFor(async () => {
    const r = await api('GET', `/api/chat?id=${id}`);
    const last = r.body.messages.at(-1);
    return last.status === 'done' ? r.body : null;
  });
  assert.equal(s.messages.at(-1).text, '第一段\n\n第二段');
  assert.equal(s.agentSessionId, 'sess-123');
  assert.equal(s.messages.at(-1).tools[0].name, 'Write');
});

test('知识库：写入、检索、删除、从回收站恢复', async () => {
  assert.equal((await api('PUT', '/api/knowledge/file', { path: '方法/标题公式.md', content: '# 标题公式\n数字开头的标题' })).status, 200);
  const found = await api('GET', `/api/knowledge/search?q=${encodeURIComponent('怎么写标题')}`);
  assert.equal(found.body.results[0].path, '方法/标题公式.md');
  await api('DELETE', `/api/knowledge/file?path=${encodeURIComponent('方法/标题公式.md')}`);
  const trash = await api('GET', '/api/trash');
  const entry = trash.body.items.find((e) => e.label.includes('标题公式'));
  assert.ok(entry);
  assert.equal((await api('POST', '/api/trash/restore', { id: entry.id })).status, 200);
  assert.equal((await api('GET', `/api/knowledge/file?path=${encodeURIComponent('方法/标题公式.md')}`)).status, 200);
});

test('笔记、排期、提醒、素材打包、数据导出', async () => {
  const n = (await api('POST', '/api/notes?account=default', { create: true, title: '集成测试笔记' })).body;
  const at = new Date(Date.now() + 3600_000).toISOString();
  assert.equal((await api('POST', '/api/schedule?account=default', { noteId: n.id, publishAt: at, mode: 'remind' })).status, 200);
  assert.equal((await api('POST', '/api/schedule?account=default', { noteId: n.id, publishAt: at })).status, 400);
  const bundle = await fetch(`${base}/api/notes/bundle?account=default&id=${n.id}&t=${token}`);
  assert.equal(bundle.headers.get('content-type'), 'application/zip');
  const csv = await fetch(`${base}/api/analytics/export?account=default&t=${token}`);
  const bytes = Buffer.from(await csv.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]); // BOM，Excel 打开不乱码
  assert.match(bytes.toString('utf8'), /"笔记","发布时间"/);
  assert.equal((await api('GET', '/api/alerts')).status, 200);
});

test('视频笔记与对标追踪：流式上传、设置视频、雷达提醒与已读', async () => {
  const n = (await api('POST', '/api/notes?account=default', { create: true, title: '视频集成' })).body;
  // 流式上传：请求体直接写盘
  const up = await fetch(`${base}/api/notes/upload-file?account=default&noteId=${n.id}&filename=demo.mp4&t=${token}`, {
    method: 'POST',
    headers: { 'X-Workbench-Token': token },
    body: Buffer.from('fake-video-bytes'),
  });
  assert.equal(up.status, 200);
  assert.equal((await up.json()).name, 'demo.mp4');
  const bad = await fetch(`${base}/api/notes/upload-file?account=default&noteId=${n.id}&filename=x.exe&t=${token}`, {
    method: 'POST',
    headers: { 'X-Workbench-Token': token },
    body: 'x',
  });
  assert.equal(bad.status, 400); // 扩展名白名单

  const wrongCover = await api('POST', '/api/notes/video?account=default', { id: n.id, file: 'demo.mp4', cover: 'demo.mp4' });
  assert.equal(wrongCover.status, 400); // 视频不能当封面
  const set = await api('POST', '/api/notes/video?account=default', { id: n.id, file: 'demo.mp4' });
  assert.equal(set.status, 200);
  assert.equal(set.body.video.file, 'demo.mp4');
  assert.deepEqual(set.body.media, []);
  const cleared = await api('POST', '/api/notes/video?account=default', { id: n.id, file: '' });
  assert.equal(cleared.body.video, null);

  // 设置视频后只传封面（file 键缺失）：视频不能被误清
  await api('POST', '/api/notes/video?account=default', { id: n.id, file: 'demo.mp4' });
  const coverOnly = await api('POST', '/api/notes/video?account=default', { id: n.id, cover: 'frame.jpg' });
  assert.equal(coverOnly.status, 400); // 封面文件不存在被拒绝
  const still = await api('GET', `/api/notes/detail?account=default&id=${n.id}`);
  assert.equal(still.body.video.file, 'demo.mp4'); // 视频保持不变

  // 对标追踪：agent 回写 → 提醒 → 看过清零
  const b = (await api('POST', '/api/benchmarks?account=default', { name: '集成雷达', tracking: true })).body;
  await api('POST', '/api/benchmarks?account=default', { id: b.id, newCount: 2, radarNote: '《新笔记》点赞 3000' });
  assert.ok((await api('GET', '/api/alerts')).body.items.some((a) => a.kind === 'radar' && a.id === b.id));
  const seen = await api('POST', '/api/benchmarks/seen?account=default', { id: b.id });
  assert.equal(seen.body.item.newCount, 0);
  assert.ok(!((await api('GET', '/api/alerts')).body.items.some((a) => a.kind === 'radar' && a.id === b.id)));
});

test('备份：创建、列表、下载', async () => {
  const b = (await api('POST', '/api/backups')).body;
  assert.ok(b.files > 0);
  const list = (await api('GET', '/api/backups')).body;
  assert.ok(list.items.some((x) => x.name === b.name));
  const dl = await fetch(`${base}/api/backup/download?name=${b.name}&t=${token}`);
  assert.equal(dl.status, 200);
  assert.ok((await dl.arrayBuffer()).byteLength > 100);
});

test('系统设置：防休眠模式可切换', async () => {
  const r = await api('POST', '/api/system', { keepAwake: 'off' });
  assert.equal(r.body.keepAwake.mode, 'off');
  assert.equal(typeof r.body.autostart.enabled, 'boolean');
});

test('选题 HTTP 全流程：已有对标资料 → 来源选题 → 单份草稿，重复点击不重复建稿', async()=>{
 const content=await server('content.mjs');const {mergeObservation}=await server('benchmark-observation.mjs');
 const b=content.saveBenchmark('default',{name:'隔离来源',url:'https://www.xiaohongshu.com/user/profile/abcdef123',xhsId:'fixture'});
 const index=path.join(WS,'accounts/default/benchmarks/index.json');const data=store.readJson(index,{});data.items.find(x=>x.id===b.id).verifiedAt='2026-10-17T00:00:00Z';store.writeJson(index,data);
 mergeObservation('default',{...b,verifiedAt:'2026-10-17T00:00:00Z'},{id:b.id,stage:'observation',url:b.url,xhsId:'fixture',profileName:b.name,source:'agent-visible',state:'partial',observedAt:'2026-10-17T00:00:00Z',notes:[{url:'https://www.xiaohongshu.com/explore/abcdef123',title:'参考笔记',description:'资料内容'}]});
 const first=await api('POST','/api/topics/generate?account=default',{benchmarkId:b.id});assert.equal(first.status,200);
 const same=await api('POST','/api/topics/generate?account=default',{benchmarkId:b.id});assert.equal(same.body.id,first.body.id);
 const done=await waitFor(async()=>{const d=(await api('GET','/api/topics?account=default')).body;const j=d.jobs.find(j=>j.id===first.body.id);if(j?.status==='error')throw Error(j.error);return j?.status==='done'?j:null;});
 const topicId=done.topicIds[0];const draft=await api('POST','/api/topics/write?account=default',{topicId});
 const again=await api('POST','/api/topics/write?account=default',{topicId});assert.equal(again.body.noteId,draft.body.noteId);
 await waitFor(async()=>{const d=(await api('GET','/api/topics?account=default')).body;const j=d.jobs.find(j=>j.id===draft.body.id);if(j?.status==='error')throw Error(j.error);return j?.status==='done';});
 const note=(await api('GET',`/api/notes/detail?account=default&id=${draft.body.noteId}`)).body;assert.match(note.content,/检查清单/);assert.equal(note.status,'draft');assert.equal(note.sources[0].benchmarkId,b.id);
 const listing=(await api('GET','/api/topics?account=default')).body;assert.equal(listing.items.find(t=>t.id===topicId).basis,'observed');assert.equal(listing.items.find(t=>t.id===topicId).score,undefined);
});

test('文案 HTTP 流程：改写、标题优化、检查及报告过期',async()=>{
 const n=(await api('POST','/api/notes?account=default',{create:true,title:'原始标题',content:'原始正文',tags:['审片']})).body;
 for(const kind of ['rewrite','titles','check']){
  const start=await api('POST','/api/notes/run?account=default',{noteId:n.id,kind});assert.equal(start.status,200);
  const done=await waitFor(async()=>{const jobs=(await api('GET',`/api/notes/jobs?account=default&noteId=${n.id}`)).body.items;const j=jobs.find(x=>x.id===start.body.id);if(j?.status==='error')throw Error(j.error);return j?.status==='done'?j:null;});
  assert.equal(done.kind,kind);
 }
 const fresh=(await api('GET',`/api/notes/detail?account=default&id=${n.id}`)).body;
 assert.equal(fresh.title,'原始标题');assert.match(fresh.content,/修改后的/);assert.equal(fresh.titleOptions.length,5);assert.equal(fresh.status,'draft');
 await api('POST','/api/notes?account=default',{id:n.id,title:'修改标题'});
 const jobs=(await api('GET',`/api/notes/jobs?account=default&noteId=${n.id}`)).body.items;assert.equal(jobs.find(j=>j.kind==='check').stale,true);
});

test('封面 HTTP 流程：方案生成、卡片 PNG 落盘与文案保留',async()=>{
 const note=(await api('POST','/api/notes?account=default',{create:true,title:'图片流程原稿',content:'先看目标，再写反馈。',tags:['审片']})).body;
 const image='data:image/png;base64,'+fs.readFileSync(new URL('./fixtures/card.png',import.meta.url)).toString('base64');
 for(const kind of ['options','cards']){
  const started=await api('POST','/api/covers/run?account=default',{noteId:note.id,kind});assert.equal(started.status,200);
  const j=await waitFor(async()=>{const jobs=(await api('GET',`/api/covers/jobs?account=default&noteId=${note.id}`)).body.items;const x=jobs.find(x=>x.id===started.body.id);if(x?.status==='error')throw Error(x.error);return ['done','ready'].includes(x?.status)?x:null;});
  if(kind==='cards')for(let index=0;index<3;index++){const r=await api('POST','/api/covers/render?account=default',{id:j.id,index,spec:j.specs[index],expectedSpec:j.specHashes[index],data:image});assert.equal(r.status,200);}
  else {const state=(await api('GET',`/api/covers/state?account=default&noteId=${note.id}`)).body;assert.equal((await api('POST','/api/covers/save?account=default',{noteId:note.id,spec:j.specs[0],expected:state.version,expectedCover:state.coverHash,data:image})).status,200);}
 }
 const n=(await api('GET',`/api/notes/detail?account=default&id=${note.id}`)).body;assert.equal(n.content,note.content);assert.equal(n.title,note.title);assert.equal(n.media.length,3);assert.equal(n.hasCover,true);assert.equal(n.coverStale,false);assert.equal(n.status,'draft');
});
test('复盘 HTTP 全流程：账号数据 → 报告 → 幂等入池 → 新稿',async()=>{
 store.writeJson(path.join(WS,'accounts/default/analytics/notes.json'),{updatedAt:'2026-10-16T00:00:00Z',items:[{id:'a_review',title:'历史样本',metrics:{views:100,likes:2,collects:1,comments:0},url:'https://www.xiaohongshu.com/explore/abcdef123'}]});
 const start=await api('POST','/api/analytics/review?account=default',{sourceId:'account'});assert.equal(start.status,200);
 const report=await waitFor(async()=>{const d=(await api('GET','/api/analytics/workflow?account=default')).body;const j=d.jobs.find(j=>j.id===start.body.id);if(j?.status==='error')throw Error(j.error);return j?.status==='done'?j:null;});assert.equal(report.dataset.kind,'account');
 const t=await api('POST','/api/analytics/review/topic?account=default',{id:report.id,index:0});assert.equal(t.status,200);assert.equal((await api('POST','/api/analytics/review/topic?account=default',{id:report.id,index:0})).body.id,t.body.id);
 const startWrite=(await api('POST','/api/topics/write?account=default',{topicId:t.body.id})).body;
 await waitFor(async()=>{const j=(await api('GET','/api/topics?account=default')).body.jobs.find(j=>j.id===startWrite.id);if(j?.status==='error')throw Error(j.error);return j?.status==='done';});
 const note=(await api('GET',`/api/notes/detail?account=default&id=${startWrite.noteId}`)).body;assert.equal(note.status,'draft');assert.equal(note.sources[0].kind,'account');assert.equal(note.sources[0].reportId,report.id);
});
test('评论私信 HTTP：草稿编辑和本地确认撤回不写发送队列',async()=>{
 const file=path.join(WS,'accounts/default/engage/items.json');store.writeJson(file,{items:[{id:'e_review_local',type:'dm',user:'示例读者',content:'列表预览',status:'ignored'}]});const original=fs.readFileSync(file);
 const start=await api('POST','/api/engage/review?account=default',{itemIds:['e_review_local']});assert.equal(start.status,200);
 const done=await waitFor(async()=>{const j=(await api('GET','/api/engage/workflow?account=default')).body.jobs.find(j=>j.id===start.body.id);if(j?.status==='error')throw Error(j.error);return j?.status==='done'?j:null;});let r=done.reviews[0];assert.equal(r.incomplete,true);
 const payload=()=>({jobId:done.id,itemId:r.itemId,version:r.version});
 r=(await api('POST','/api/engage/review/edit?account=default',{...payload(),draft:'请补充你想了解的问题。'})).body;
 r=(await api('POST','/api/engage/review/confirm?account=default',payload())).body;assert.equal(r.status,'confirmed_local');assert.equal(r.nonExecuting,true);
 r=(await api('POST','/api/engage/review/revoke?account=default',payload())).body;assert.equal(r.status,'drafted');assert.ok(fs.readFileSync(file).equals(original));
 const cfg=(await api('GET','/api/automation?account=default')).body;assert.equal(cfg.engage.autoSend,false);
});
test('生图 HTTP：交接结果校验、候选访问与重复应用',async()=>{
 const note=(await api('POST','/api/notes?account=default',{create:true,title:'生图测试',content:'保留正文'})).body;
 const started=await api('POST','/api/images/start?account=default',{noteId:note.id,prompt:'编辑台插画',count:1});assert.equal(started.status,200);const j=started.body;
 assert.equal((await api('POST','/api/images/complete?account=default',{id:j.id})).status,400);
 fs.copyFileSync(new URL('./fixtures/card.png',import.meta.url),path.join(j.outputDir,'candidate.png'));store.writeJson(j.outputFile,{images:[{file:'candidate.png'}]});
 const done=await api('POST','/api/images/complete?account=default',{id:j.id});assert.equal(done.status,200);assert.equal(done.body.status,'done');
 const apply=await api('POST','/api/images/apply?account=default',{id:j.id,index:0});assert.equal(apply.status,200);assert.equal((await api('POST','/api/images/apply?account=default',{id:j.id,index:0})).body.file,apply.body.file);assert.equal(apply.body.note.content,'保留正文');assert.equal(apply.body.note.media.length,1);
});
test('独立海报 HTTP：参考图、素材库与首图封面',async()=>{
 const png=fs.readFileSync(new URL('./fixtures/card.png',import.meta.url));const ref=await api('POST','/api/images/references?account=default',{filename:'style.png',data:png.toString('base64'),role:'style',style:'powder'});assert.equal(ref.status,200);
 const started=await api('POST','/api/images/start?account=default',{prompt:'暖光',outputMode:'poster',headline:'标题',references:[{file:ref.body.file,role:'style',source:'studio'}]});assert.equal(started.status,200);const j=started.body;assert.equal(j.noteId,null);fs.writeFileSync(path.join(j.outputDir,'candidate.png'),png);store.writeJson(j.outputFile,{images:[{file:'candidate.png'}]});assert.equal((await api('POST','/api/images/complete?account=default',{id:j.id})).status,200);
 const saved=await api('POST','/api/images/library?account=default',{id:j.id,index:0});assert.equal(saved.status,200);assert.equal((await api('POST','/api/images/library?account=default',{id:j.id,index:0})).body.id,saved.body.id);
 const note=(await api('POST','/api/notes?account=default',{create:true,title:'海报草稿',content:'原正文'})).body;const detail=(await api('GET',`/api/notes/detail?account=default&id=${note.id}`)).body;
 const applied=await api('POST','/api/images/apply?account=default',{id:j.id,index:0,noteId:note.id,purpose:'cover',expectedCover:[detail.coverHash,detail.coverMode,detail.media.map(m=>m.file)]});assert.equal(applied.status,200);assert.equal(applied.body.note.coverMode,'first');assert.equal(applied.body.note.content,'原正文');
});
test('实况HTTP下载错误不终止服务，缺失任务返回404',async()=>{const missing=await api('GET','/api/live/bundle?account=default&id=live_missing');assert.equal(missing.status,404);assert.equal((await api('GET','/api/live/jobs?account=default')).status,200);assert.equal((await api('POST','/api/live/start?account=default',{imageJobId:'missing',index:0})).status,404);});
test('手机接收管理接口保持工作台鉴权与任务边界',async()=>{const options=await api('GET','/api/live/receive/options?account=default');assert.equal(options.status,200);assert.ok(Array.isArray(options.body.addresses));assert.equal((await api('GET','/api/live/receive?account=default&id=missing')).status,404);assert.equal((await api('POST','/api/live/receive/revoke?account=default',{id:'missing'})).status,404);assert.equal((await api('POST','/api/live/receive?account=default',{id:'live_missing',address:'8.8.8.8'})).status,400);});

test('账号访问锁覆盖手动入口且普通恢复不能解除平台限制', async()=>{
 const r=await api('POST','/api/browser/access?account=default',{action:'restriction'});
 assert.equal(r.status,200);assert.equal(r.body.kind,'restriction');
 assert.equal((await api('POST','/api/benchmarks/collection?account=default',{action:'resume'})).status,409);
 assert.equal((await api('POST','/api/chat/send',{accountId:'default',taskKind:'browser.prepare'})).status,409);
 assert.equal((await api('POST','/api/browser/access?account=default',{action:'resolve-restriction',confirmed:false})).status,400);
 const status=await api('GET','/api/benchmarks?account=default');assert.equal(status.body.access.kind,'restriction');
 assert.equal((await api('POST','/api/browser/access?account=default',{action:'resolve-restriction',confirmed:true})).status,200);
 assert.equal((await api('GET','/api/benchmarks?account=default')).body.access.kind,'open');
});

test('生图服务配置需鉴权，密钥不回传，默认保留 Agent，不凭空生成',async()=>{
 assert.equal((await api('GET','/api/images/service',null,{'X-Workbench-Token':'wrong'})).status,401);
 const initial=await api('GET','/api/images/service');assert.equal(initial.status,200);assert.equal(initial.body.defaultProvider,'current-agent');
 const saved=await api('PUT','/api/images/service',{apiKey:'fixture-secret-never-return',model:'gpt-image-2-ext',size:'16:9',resolution:'2k'});
 assert.equal(saved.status,200);assert.equal(saved.body.hasKey,true);assert.ok(!JSON.stringify(saved.body).includes('fixture-secret-never-return'));
 const kept=await api('PUT','/api/images/service',{apiKey:''});assert.equal(kept.body.hasKey,true);
 const removed=await api('PUT','/api/images/service',{deleteKey:true});assert.equal(removed.body.hasKey,false);
 const missing=await api('POST','/api/images/start?account=default',{provider:'apimart',prompt:'fixture only',count:1});assert.ok(missing.status>=400);
 const state=await api('GET','/api/state');assert.ok(!JSON.stringify(state.body).includes('fixture-secret-never-return'));
});

test('视频配置鉴权、密钥隐藏、未配置不创建任务',async()=>{
 assert.equal((await api('GET','/api/videos/service',null,{'X-Workbench-Token':'wrong'})).status,401);
 const before=await api('GET','/api/videos/service');assert.equal(before.body.hasKey,false);
 const saved=await api('PUT','/api/videos/service',{apiKey:'video-secret-fixture'});assert.equal(saved.body.hasKey,true);assert.equal(JSON.stringify(saved.body).includes('video-secret-fixture'),false);
 assert.equal((await api('PUT','/api/videos/service',{apiKey:''})).body.hasKey,true);
 await api('PUT','/api/videos/service',{deleteKey:true});
 assert.equal((await api('POST','/api/videos/start?account=default',{mode:'t2v',prompt:'test'})).status,400);
 assert.equal((await api('GET','/api/videos/jobs?account=default')).body.items.length,0);
 assert.equal((await api('GET','/api/videos/sources?account=default')).status,200);
});

test('参考视频 HTTP：真实上传抽帧、Agent回调、描述候选与账号隔离，无生成请求',async()=>{
 const {execFileSync}=await import('node:child_process');const file=path.join(WS,'sample.mp4');const ffmpeg=fs.existsSync('/opt/homebrew/bin/ffmpeg')?'/opt/homebrew/bin/ffmpeg':'ffmpeg';execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=128x96:rate=12','-t','1','-c:v','libx264',file]);
 const up=await api('POST','/api/videos/reference-videos?account=default',{filename:'isolated.mp4',data:fs.readFileSync(file).toString('base64')});assert.equal(up.status,200);assert.equal(up.body.media.width,128);
 const media=await fetch(`${base}/api/files?account=default&path=${encodeURIComponent(up.body.path)}&t=${token}`);assert.equal(media.status,200);assert.equal(media.headers.get('content-type'),'video/mp4');
 const other=store.saveAccount({name:'other video account'}).id;assert.equal((await api('POST',`/api/videos/descriptions?account=${other}`,{kind:'generate',sourceVideoId:up.body.id})).status,404);
 for(const kind of ['generate','optimize']){
  const start=await api('POST','/api/videos/descriptions?account=default',{kind,sourceVideoId:up.body.id,prompt:'原描述',mode:'rv2v'});assert.equal(start.status,200);
  const done=await waitFor(async()=>{const j=(await api('GET','/api/videos/descriptions?account=default')).body.items.find(j=>j.id===start.body.id);if(j.status==='error')throw Error(j.error);return j.status==='done'?j:null;});assert.equal(done.originalPrompt,'原描述');assert.match(done.result.prompt,/隔离测试/);assert.equal(done.result.observations.length,12);
 }
 assert.equal((await api('GET','/api/videos/jobs?account=default')).body.items.length,0);
});

// ── 入站编码兜底：非 UTF-8 的调用方（Windows 命令行里的 curl 等）不再把中文永久替换成 U+FFFD ──
test('聊天请求体：GBK 编码的中文按 GBK 兜底解码；UTF-8 不受影响；已经含 U+FFFD 的消息被拒绝而不是交给 agent 去猜', async () => {
  const raw = (bytes) => fetch(`${base}/api/chat/send`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': token }, body: bytes });
  // “测试中文”的 GBK 字节：B2 E2 CA D4 D6 D0 CE C4
  const gbk = Buffer.concat([Buffer.from('{"accountId":"default","text":"'), Buffer.from([0xb2, 0xe2, 0xca, 0xd4, 0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('"}')]);
  const res = await raw(gbk);
  assert.equal(res.status, 200);
  const session = await res.json();
  assert.equal(session.messages.find((m) => m.role === 'user').text, '测试中文');
  const utf8 = await raw(Buffer.from(JSON.stringify({ accountId: 'default', text: '你好，UTF-8' })));
  assert.equal(utf8.status, 200);
  assert.equal((await utf8.json()).messages.filter((m) => m.role === 'user').at(-1).text, '你好，UTF-8');
  const damaged = await api('POST', '/api/chat/send', { accountId: 'default', text: `损坏${String.fromCharCode(0xfffd)}${String.fromCharCode(0xfffd)}的消息` });
  assert.equal(damaged.status, 400);
  assert.match(damaged.body.error, /无法识别的字符/);
});

test('收件箱接口：peek 只看队列不领取；requeue 对不存在的任务返回 404', async () => {
  const peek = await api('GET', '/api/agent/peek');
  assert.equal(peek.status, 200);
  assert.equal(typeof peek.body.pending, 'number');
  assert.equal((await api('POST', '/api/agent/requeue', { taskId: 'nope' })).status, 404);
});

test('素材：通过接口删一个素材，另一个素材的文件还在（XHS-01）', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const ids = [];
  for (const n of ['http-a.png', 'http-b.png']) {
    const up = await api('POST', '/api/materials/upload?account=default', { filename: n, data: png });
    assert.equal(up.status, 200);
    ids.push((await api('POST', '/api/materials?account=default', { title: n, file: up.body.name })).body);
  }
  assert.equal((await api('DELETE', `/api/materials?account=default&id=${ids[0].id}`)).status, 200);
  const files = path.join(WS, 'accounts', 'default', 'materials', 'files');
  assert.equal(fs.existsSync(path.join(files, ids[0].file)), false);
  assert.ok(fs.existsSync(path.join(files, ids[1].file)));
  assert.ok((await api('GET', '/api/materials?account=default')).body.items.some((x) => x.id === ids[1].id));
});
