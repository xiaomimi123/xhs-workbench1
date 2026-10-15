// Agent 桥接：调用命令行、解析输出、取消、超时、重试、收件箱、按账号排队
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useTempWorkspace, server, fakeAdapter } from './helpers.mjs';

useTempWorkspace();
const store = await server('store.mjs');
const { runCli, pingAdapter, Bridge } = await server('bridge.mjs');
store.ensureWorkspace();

const withMode = (mode, fn) => async () => {
  process.env.FAKE_AGENT_MODE = mode;
  try {
    await fn();
  } finally {
    delete process.env.FAKE_AGENT_MODE;
  }
};

test('纯文本输出', withMode('text', async () => {
  const chunks = [];
  const { text } = await runCli(fakeAdapter(), '你好', { onText: (t) => chunks.push(t) }).promise;
  assert.match(text, /收到/);
  assert.ok(chunks.length >= 1);
}));

test('Claude 流式 JSON：正文、工具调用、会话 id', withMode('claude-json', async () => {
  const tools = [];
  let sid = null;
  const { text, agentSessionId } = await runCli(fakeAdapter('claude-stream-json'), '写点东西', {
    onTool: (name, detail) => tools.push(`${name} ${detail}`),
    onSession: (s) => (sid = s),
  }).promise;
  assert.equal(text, '第一段\n\n第二段');
  assert.deepEqual(tools, ['Write /tmp/x.md']);
  assert.equal(agentSessionId, 'sess-123');
  assert.equal(sid, 'sess-123');
}));

test('出错退出时带上错误信息', withMode('fail', async () => {
  await assert.rejects(runCli(fakeAdapter(), 'x').promise, /退出码 2.*模拟的错误信息/);
}));

test('取消与超时会结束进程', withMode('slow', async () => {
  const run = runCli(fakeAdapter(), 'x');
  setTimeout(() => run.cancel(), 200);
  await assert.rejects(run.promise, /已取消/);
  await assert.rejects(runCli(fakeAdapter(), 'x', { timeoutMs: 300 }).promise, /超时/);
}));

test('连接自检：第一次没回 PONG 时重试', withMode('flaky', async () => {
  process.env.FAKE_AGENT_COUNTER = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cnt-')), 'n');
  const r = await pingAdapter(fakeAdapter());
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(process.env.FAKE_AGENT_COUNTER, 'utf8'), '2');
}));

test('收件箱模式：领取、进度、完成、断线放回队列', async () => {
  store.saveBridgeConfig({ mode: 'inbox' });
  const b = new Bridge();
  const ev = [];
  for (const k of ['claimed', 'tool', 'done', 'error']) b.on(k, (e) => ev.push([k, e]));
  b.submit({ id: 't1', sessionId: 's', accountId: 'default', prompt: 'p1' });
  assert.equal(b.status().pending, 1);
  const task = await b.next(1000);
  assert.equal(task.id, 't1');
  b.requeue('t1');
  assert.equal((await b.next(0)).id, 't1');
  assert.ok(b.reply('t1', { text: '进行中' }));
  assert.ok(b.reply('t1', { text: '完成了', final: true }));
  assert.equal(b.reply('t1', { text: '再来' }), false);
  assert.deepEqual(ev.map(([k]) => k), ['claimed', 'claimed', 'tool', 'done']);
  assert.equal(await b.next(50), null); // 没有任务时超时返回 null
});

test('CLI 模式：开启浏览器隔离后，同一账号的任务排队执行', withMode('text', async () => {
  const adapter = fakeAdapter('text', { args: [fakeAdapter().args[0], '--mcp-config', '{mcpConfig}'], playwrightMcp: '@playwright/mcp@0.0.1' });
  store.saveBridgeConfig({ mode: 'cli', adapter });
  const b = new Bridge();
  const order = [];
  const done = new Promise((resolve) => {
    b.on('done', ({ taskId }) => {
      order.push(`done:${taskId}`);
      if (order.filter((x) => x.startsWith('done')).length === 3) resolve();
    });
  });
  b.on('claimed', ({ taskId }) => order.push(`start:${taskId}`));
  b.submit({ id: 'a1', accountId: 'A', prompt: 'x' });
  b.submit({ id: 'a2', accountId: 'A', prompt: 'x' });
  b.submit({ id: 'b1', accountId: 'B', prompt: 'x' });
  assert.equal(b.status().pending, 1); // a2 在排队
  await done;
  assert.ok(order.indexOf('start:a2') > order.indexOf('done:a1'));
  assert.ok(order.indexOf('start:b1') < order.indexOf('done:a1')); // 不同账号并行
}));
