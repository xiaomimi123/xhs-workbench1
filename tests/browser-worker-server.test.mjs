// 真实 HTTP 路由 + 模拟 Playwright 运行时；只使用临时数据目录，不触碰本机登录资料。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { useTempWorkspace, server, fakeAdapter, PNG_1PX, SKILL } from './helpers.mjs';

const WS = useTempWorkspace();
const store = await server('store.mjs');
store.ensureWorkspace();
store.saveAccount({ id: 'default', xhsId: 'my-account' });
const extra = store.saveAccount({ name: '测试第二账号', xhsId: 'another-account' });
const automation = await server('automation.mjs');
automation.saveAutomation('default', { curator: { everyHours: 0 } });
automation.saveAutomation(extra.id, { curator: { everyHours: 0 } });
store.saveBridgeConfig({ mode: 'cli', browser: 'playwright', adapter: fakeAdapter('claude-stream-json', {
  id: 'claude-code', playwrightMcp: '@playwright/mcp@0.0.1',
  args: [fakeAdapter().args[0], '--mcp-config', '{mcpConfig}'], resumeArgs: ['--resume', '{agentSessionId}'],
}) });
store.writeJson(path.join(WS, 'config', 'settings.json'), { backgroundBrowser: true });
const root = path.join(WS, 'browser-runtime', 'node_modules', 'playwright-core');
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'playwright-core', version: '1.64.1' }));
fs.writeFileSync(path.join(root, 'index.mjs'), `
import fs from 'node:fs';
import path from 'node:path';
const trace = path.join(process.env.XHS_WORKSPACE, 'run', 'worker-trace.log');
const log = (line) => fs.appendFileSync(trace, line + '\\n');
export const chromium = { async launchPersistentContext(dir, opts) {
  if (opts.headless !== false) throw new Error('worker 必须有头');
  log('launch:' + dir);
  const page = { current: '', on() {}, url() { return this.current; },
    async goto(url) { this.current = url; log('goto:' + url); },
    locator(selector) { const loc = { click: async () => { page.current = 'https://www.xiaohongshu.com/explore/' + /note[0-9]+abcd/.exec(selector)[0]; log('click:' + page.current); }, evaluate: async () => '', innerText: async () => '搜索结果', first() { return { click: this.click, count: async () => 1, screenshot: async () => {
      if (selector.includes('avatar') && fs.existsSync(path.join(process.env.XHS_WORKSPACE, 'run', 'invalid-avatar'))) { const bad = Buffer.alloc(24); bad.writeUInt32BE(1, 16); bad.writeUInt32BE(1, 20); return bad; }
      return Buffer.from('${PNG_1PX.toString('base64')}', 'base64');
    } }; } }; return { ...loc, ...loc.first() }; },
    async evaluate() {
      if (this.current.startsWith('https://creator.')) return { url: this.current, header: '我的账号 小红书号：my-account', accountMenu: '', text: '创作者中心' };
      if (this.current.includes('/search_result') && this.current.includes(encodeURIComponent('自动目标'))) return [{ url: 'https://www.xiaohongshu.com/user/profile/auto123', name: '自动目标', text: '小红书号：auto-account' }];
      if (this.current.includes('/search_result')) return [
        { url: 'https://www.xiaohongshu.com/user/profile/one', name: '同名', text: '小红书号：one' },
        { url: 'https://www.xiaohongshu.com/user/profile/two', name: '同名', text: '小红书号：two' },
      ];
      if (this.current.includes('/explore/')) return { url: this.current, title: '可见笔记', details: '点赞・23 收藏・5 评论・2', pageText: '正常页面', publishedAt: '2天前' };
      return { url: this.current, name: this.current.includes('auto123') ? '自动目标' : '目标作者', details: '小红书号：' + (this.current.includes('auto123') ? 'auto-account' : 'somebody') + ' 粉丝・3500 关注・42', bio: '分享真实经验',
        noteRows: [{ url: 'https://www.xiaohongshu.com/explore/note1abcd', title: '一' }, { url: 'https://www.xiaohongshu.com/explore/note2abcd', title: '二' }], text: '目标作者' };
    },
  };
  return { pages: () => [page], on() {}, async route() {}, async newCDPSession() { return { async send(cmd, data) {
    if (cmd === 'Browser.getWindowForTarget') return { windowId: 1 };
    log('window:' + data.bounds.windowState);
    return {};
  } }; }, async close() { log('close:' + dir); } };
} };
`);

const audit = path.join(WS, 'audit');
let proc;
let base;
let token;
let sseAbort;
let ssePump;
const sseSeen = [];
async function waitFor(fn, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const res = await fn();
    if (res) return res;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('等待状态超时');
}
const api = async (method, route, body) => {
  const res = await fetch(base + route, { method,
    headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': token },
    body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const completed = (id) => waitFor(async () => {
  const r = await api('GET', `/api/chat?id=${id}`);
  return ['done', 'error'].includes(r.body.messages.at(-1).status) ? r.body : null;
}, 30_000);
const events = () => fs.readFileSync(path.join(WS, 'run', 'worker-trace.log'), 'utf8').trim().split('\n');
const audits = () => fs.existsSync(audit) ? fs.readdirSync(audit).sort().map((f) => JSON.parse(fs.readFileSync(path.join(audit, f), 'utf8'))) : [];

await test('后台核实 HTTP/SSE、逐条检查点与无模型调用', async () => {
  try {
    proc = spawn(process.execPath, ['--loader', path.join(SKILL, '..', 'tests', 'fixtures', 'ocr-loader.mjs'), path.join(SKILL, 'server', 'server.mjs')], {
      env: { ...process.env, XHS_WORKSPACE: WS, FAKE_AGENT_MODE: 'claude-json', FAKE_AGENT_AUDIT_DIR: audit },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const info = await waitFor(() => store.readJson(path.join(WS, 'run', 'server.json'), null));
    base = `http://127.0.0.1:${info.port}`;
    token = fs.readFileSync(path.join(WS, 'run', 'token'), 'utf8').trim();
    await waitFor(async () => (await fetch(base + '/api/health').catch(() => null))?.ok);
    sseAbort = new AbortController();
    const stream = await fetch(`${base}/api/events?t=${token}`, { signal: sseAbort.signal });
    ssePump = (async () => {
      const reader = stream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop();
        for (const event of events) {
          const line = event.split('\n').find((part) => part.startsWith('data: '));
          if (line) sseSeen.push(JSON.parse(line.slice(6)));
        }
      }
    })();
    const b = (await api('POST', '/api/benchmarks?account=default', {
      name: '目标作者', url: 'https://www.xiaohongshu.com/user/profile/abc123', followers: '待核实',
    })).body;
    const status = await api('GET', '/api/bridge');
    assert.equal(status.body.status.browserWorker.available, true);
    assert.equal(status.body.status.browserWorker.enabled, true);
    const badType = await api('POST', '/api/chat/send', { accountId: 'default', text: 'x', taskKind: 'browser.admin' });
    assert.equal(badType.status, 400);
    const missing = await api('POST', '/api/chat/send', { accountId: 'default', text: 'x', taskKind: 'benchmark.verify', benchmarkId: 'b_missing' });
    assert.equal(missing.status, 404);
    const sent = await api('POST', '/api/chat/send', { accountId: 'default', text: '别读这个文本', taskKind: 'benchmark.verify', benchmarkId: b.id });
    assert.equal(sent.status, 200);
    const done = await completed(sent.body.id);
    assert.equal(done.messages.at(-1).status, 'done');
    assert.match(done.messages.at(-1).text, /未调用模型/);
    await waitFor(() => sseSeen.some((ev) => ev.type === 'browser.changed')
      && sseSeen.some((ev) => ev.type === 'content.changed' && ev.area === 'benchmarks')
      && sseSeen.some((ev) => ev.type === 'chat.done'));
    assert.equal(audits().length, 0);
    const list = (await api('GET', '/api/benchmarks?account=default')).body.items;
    assert.equal(list.find((item) => item.id === b.id).observedFollowers, '3500');
    assert.equal(list.find((item) => item.id === b.id).verificationSource.kind, 'profile-visible');
    const detail = (await api('GET', `/api/benchmarks/detail?account=default&id=${b.id}`)).body;
    assert.equal(detail.observation.notes.length, 2);
    assert.equal(detail.observation.profile.following.value, '42');
    assert.equal(detail.observation.notes[0].fields.likes.value, '23');
    assert.equal(detail.item.avatar.kind, 'captured');
    const portrait = await fetch(`${base}/api/files?account=default&path=${encodeURIComponent(detail.item.avatar.path)}&t=${token}`);
    assert.equal(portrait.status, 200);
    assert.ok((await portrait.arrayBuffer()).byteLength > 20);
    assert.equal(store.readJson(path.join(WS, 'accounts', 'default', 'browser.json'), {}).xhsId, 'my-account');
    assert.equal(events().filter((e) => e.startsWith('launch:')).length, 1);
    // 一次推荐任务落下候选/核实检查点，服务必须自动接续，无单卡操作。
    const recommendation = await api('POST', '/api/chat/send', { accountId: 'default', text: 'BENCHMARK_AUTO_FIXTURE 推荐并采集' });
    await completed(recommendation.body.id);
    await waitFor(async () => {
      const d = await api('GET', '/api/benchmarks/detail?account=default&id=b_auto');
      return d.body.observation?.state === 'complete';
    }, 30000);
    const automatic = (await api('GET', '/api/benchmarks/detail?account=default&id=b_auto')).body;
    assert.equal(automatic.observation.notes.length, 2);
    assert.equal(automatic.item.avatar.kind, 'captured');
    const queue = (await api('GET', '/api/benchmarks?account=default')).body.collection;
    assert.equal(queue.items.find(x => x.id === 'b_auto').state, 'complete');
    fs.writeFileSync(path.join(WS, 'run', 'invalid-avatar'), '模拟坏截图');
    const again = await api('POST', '/api/chat/send', { accountId: 'default', taskKind: 'benchmark.verify', benchmarkId: b.id });
    const againDone = await completed(again.body.id);
    fs.unlinkSync(path.join(WS, 'run', 'invalid-avatar'));
    assert.equal(againDone.messages.at(-1).status, 'done');
    assert.match(againDone.messages.at(-1).text, /头像截图未能保存/);
    const partial = (await api('GET', `/api/benchmarks/detail?account=default&id=${b.id}`)).body;
    assert.equal(partial.observation.state, 'partial');
    assert.equal(partial.observation.notes.length, 2);
    assert.equal(partial.item.avatar.kind, 'captured'); // 坏截图不能抹掉旧头像
    assert.equal(events().filter((e) => e.startsWith('launch:')).length, 2);
    const ambiguous = (await api('POST', '/api/benchmarks?account=default', { name: '同名' })).body;
    const amb = await api('POST', '/api/chat/send', { accountId: 'default', taskKind: 'benchmark.verify', benchmarkId: ambiguous.id });
    const ambDone = await completed(amb.body.id);
    assert.equal(ambDone.messages.at(-1).status, 'done');
    assert.match(ambDone.messages.at(-1).text, /多个同名账号/);
    assert.equal((await api('GET', '/api/benchmarks?account=default')).body.items.find((x) => x.id === ambiguous.id).verifiedAt, undefined);
    const manual = await api('POST', '/api/benchmarks/avatar?account=default', { id: ambiguous.id,
      filename: 'face.png', data: `data:image/png;base64,${PNG_1PX.toString('base64')}` });
    assert.equal(manual.status, 200);
    assert.equal((await api('GET', '/api/benchmarks?account=default')).body.items.find((x) => x.id === ambiguous.id).avatar.kind, 'manual');
    assert.equal(audits().length, 1);
    const mismatch = await api('POST', '/api/chat/send', { accountId: extra.id, taskKind: 'browser.prepare' });
    assert.match((await completed(mismatch.body.id)).messages.at(-1).text, /不一致/);
    assert.equal(store.readJson(path.join(WS, 'accounts', extra.id, 'browser.json'), null), null);
    // 同一资料：普通 MCP agent 任务接管前 worker 必须退出。
    const cli = await api('POST', '/api/chat/send', { accountId: 'default', text: '原 agent 任务' });
    await completed(cli.body.id);
    assert.equal(audits().length, 2);
    assert.ok(events().some((line) => line.startsWith('close:')));
    const workerInChat = await api('POST', '/api/chat/send', { sessionId: cli.body.id, accountId: 'default',
      taskKind: 'benchmark.verify', benchmarkId: b.id });
    await completed(workerInChat.body.id);
    const follow = await api('POST', '/api/chat/send', { sessionId: cli.body.id, accountId: 'default', text: '继续分析刚才结果' });
    await completed(follow.body.id);
    assert.equal(audits().length, 3);
    assert.ok(!audits()[2].args.includes('--resume'));
    assert.ok(audits()[2].prompt.includes('已核实主页'));
    const second = await api('POST', '/api/chat/send', { sessionId: follow.body.id, accountId: extra.id, text: '切换账号后的任务' });
    await completed(second.body.id);
    assert.equal(audits().length, 4);
    assert.ok(!audits()[3].args.includes('--resume'));
    assert.notEqual(second.body.id, cli.body.id);
    assert.ok(!audits()[3].prompt.includes('原 agent 任务'));
    const blocked = await api('POST', '/api/bridge/headless', { on: true });
    assert.equal(blocked.status, 409);
    assert.equal((await api('POST', '/api/browser/worker', { enabled: false })).body.enabled, false);
    const headless = await api('POST', '/api/bridge/headless', { on: true });
    assert.equal(headless.status, 200);
    assert.equal(headless.body.headless, true);
  } finally {
    sseAbort?.abort();
    await ssePump?.catch(() => {});
    if (proc) { proc.kill(); await new Promise((resolve) => proc.once('exit', resolve)); }
  }
});
