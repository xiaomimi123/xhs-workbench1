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
