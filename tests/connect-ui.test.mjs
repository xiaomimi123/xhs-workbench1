// 网页内连接 agent：列出本机检测到的 agent、一键连接、继续刚才的操作
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../xhs-workbench/web/connect.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/export /g, '');

function setup({ detect = { adapters: [{ id: 'claude-code', name: 'Claude Code' }], desktop: [{ id: 'workbuddy', name: 'WorkBuddy' }] }, put = () => ({ ok: true }) } = {}) {
  const calls = [];
  const toasts = [];
  const overlay = { html: '', hidden: true };
  const sent = [];
  let changed = 0;
  const ctx = vm.createContext({
    S: { bridge: null, detected: null, detectedDesktop: null },
    esc: (x) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    toast: (m) => toasts.push(m),
    showOverlay: (html) => { overlay.html = html; overlay.hidden = false; },
    withBusy: async (_btn, _label, fn) => fn(),
    api: async (method, url, body) => {
      calls.push([method, url, body]);
      if (method === 'GET') return detect;
      const r = await put(body);
      if (r instanceof Error) throw r;
      return r;
    },
    document: { querySelector: () => ({ set hidden(v) { overlay.hidden = v; } }) },
    navigator: { clipboard: { writeText: async () => {} } },
  });
  vm.runInContext(source, ctx);
  vm.runInContext('initConnect', ctx)({ onChanged: async () => { changed++; ctx.S.bridge = { configured: true }; }, send: (t) => sent.push(t) });
  const call = (name, ...args) => vm.runInContext(name, ctx)(...args);
  const btn = (attr, value) => ({ dataset: { [attr]: value } });
  return { ctx, calls, toasts, overlay, sent, call, btn, changed: () => changed };
}

test('检测中先显示占位，检测后同时列出命令行、桌面类和“其他 agent”，名称被转义', async () => {
  const t = setup({ detect: { adapters: [{ id: 'x', name: '<b>坏</b>' }], desktop: [{ id: 'workbuddy', name: 'WorkBuddy' }] } });
  assert.match(t.call('connectOptionsHtml'), /正在检测/);
  await t.call('detect');
  const html = t.call('connectOptionsHtml');
  assert.match(html, /&lt;b>坏&lt;\/b>/);
  assert.match(html, /data-quick-connect="cli:x"/);
  assert.match(html, /data-quick-connect="host:workbuddy"/);
  assert.match(html, /data-quick-connect="inbox:"/);
  assert.match(html, /不需要一直开着它的窗口/);
  assert.match(html, /需要保持它的窗口打开/);
});

test('什么都没检测到时仍有“其他 agent”出口', async () => {
  const t = setup({ detect: { adapters: [], desktop: [] } });
  await t.call('detect');
  const html = t.call('connectOptionsHtml');
  assert.match(html, /没有检测到常见的 agent/);
  assert.match(html, /data-quick-connect="inbox:"/);
});

test('命令行 agent：提交 adapterId，测试通过后刷新状态并显示完成页（不要求值守）', async () => {
  const t = setup();
  await t.call('openConnectDialog');
  assert.equal(t.overlay.hidden, false);
  assert.match(t.overlay.html, /选哪一个由你决定/);
  const handled = await t.call('handleConnectClick', t.btn('quickConnect', 'cli:claude-code'));
  assert.equal(handled, true);
  assert.deepEqual(JSON.parse(JSON.stringify(t.calls.at(-1))), ['PUT', '/api/bridge', { adapterId: 'claude-code' }]);
  assert.equal(t.changed(), 1);
  assert.match(t.overlay.html, /已选择 Claude Code/);
  assert.doesNotMatch(t.overlay.html, /进入小红书工作台值守模式/);
});

test('命令行 agent 测试失败：提示原因，不进入完成页', async () => {
  const t = setup({ put: () => ({ ok: false, error: '回复中没有 PONG' }) });
  await t.call('openConnectDialog');
  const before = t.overlay.html;
  await t.call('handleConnectClick', t.btn('quickConnect', 'cli:claude-code'));
  assert.match(t.toasts.at(-1), /没通过.*PONG/);
  assert.equal(t.overlay.html, before);
  assert.equal(t.changed(), 0);
});

test('桌面类 agent：以收件箱模式记录由谁值守，并给出要对它说的那句话', async () => {
  const t = setup();
  await t.call('openConnectDialog');
  await t.call('handleConnectClick', t.btn('quickConnect', 'host:workbuddy'));
  assert.deepEqual(JSON.parse(JSON.stringify(t.calls.at(-1))), ['PUT', '/api/bridge', { mode: 'inbox', hostAgentId: 'workbuddy' }]);
  assert.match(t.overlay.html, /已选择 WorkBuddy/);
  assert.match(t.overlay.html, /回到 <strong>WorkBuddy<\/strong>/);
  assert.match(t.overlay.html, /data-copy-text="进入小红书工作台值守模式"/);
});

test('其他 agent：收件箱模式但不记录名字', async () => {
  const t = setup();
  await t.call('openConnectDialog');
  await t.call('handleConnectClick', t.btn('quickConnect', 'inbox:'));
  assert.deepEqual(JSON.parse(JSON.stringify(t.calls.at(-1))), ['PUT', '/api/bridge', { mode: 'inbox' }]);
  assert.match(t.overlay.html, /已设为收件箱模式/);
  assert.match(t.overlay.html, /你正在用的 agent/);
});

test('带着待发送内容打开：连接成功后点“继续”才发送一次，并关闭弹窗', async () => {
  const t = setup();
  await t.call('openConnectDialog', '请帮我找热点选题');
  assert.match(t.overlay.html, /连接成功后会继续刚才的操作/);
  await t.call('handleConnectClick', t.btn('quickConnect', 'host:workbuddy'));
  assert.deepEqual(t.sent, []); // 选完不自动发，等用户看完“去值守”的提示
  await t.call('handleConnectClick', t.btn('connectContinue', ''));
  assert.deepEqual(t.sent, ['请帮我找热点选题']);
  assert.equal(t.overlay.hidden, true);
  await t.call('handleConnectClick', t.btn('connectContinue', ''));
  assert.equal(t.sent.length, 1); // 不会重复发送
});

test('与连接无关的点击不被拦截；复制失败时给出可操作的提示', async () => {
  const t = setup();
  assert.equal(await t.call('handleConnectClick', t.btn('nav', 'topics')), false);
  t.ctx.navigator.clipboard.writeText = async () => { throw new Error('denied'); };
  await t.call('handleConnectClick', t.btn('copyText', 'x'));
  assert.match(t.toasts.at(-1), /手动/);
});
