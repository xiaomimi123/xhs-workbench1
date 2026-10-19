// 真实服务 + 假 agent：任务超时仍能从逐条检查点恢复已保存的对标候选
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { useTempWorkspace, server, fakeAdapter, SKILL } from './helpers.mjs';

const WS = useTempWorkspace();
const store = await server('store.mjs');
store.ensureWorkspace();
store.saveBridgeConfig({ mode: 'cli', adapter: fakeAdapter(), timeoutMs: 350 });
const entry = path.join(SKILL, 'server', 'server.mjs');
let proc;
let base;
let token;

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('等待服务或任务状态超时');
}

async function start(mode) {
  proc = spawn(process.execPath, [entry], {
    env: { ...process.env, XHS_WORKSPACE: WS, FAKE_AGENT_MODE: mode },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const info = await waitFor(() => {
    const current = store.readJson(path.join(WS, 'run', 'server.json'), null);
    return current?.pid === proc.pid ? current : null;
  });
  base = `http://127.0.0.1:${info.port}`;
  token = fs.readFileSync(path.join(WS, 'run', 'token'), 'utf8').trim();
  await waitFor(async () => (await fetch(`${base}/api/health`).catch(() => null))?.ok);
}

async function stop() {
  if (!proc) return;
  const running = proc;
  proc = null;
  running.kill();
  await new Promise((resolve) => running.once('exit', resolve));
}

const api = async (method, url, body) => {
  const response = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': token },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};

test('超时后保留已写检查点，残缺文件不入库，重启仍可见', async () => {
  try {
    await start('checkpoint-slow');
    const sent = await api('POST', '/api/chat/send', { accountId: 'default', text: '推荐对标账号' });
    assert.equal(sent.status, 200);
    const chat = await waitFor(async () => {
      const response = await api('GET', `/api/chat?id=${sent.body.id}`);
      return response.body.messages.at(-1).status === 'error' ? response.body : null;
    });
    assert.match(chat.messages.at(-1).error, /超时/);
    const index = store.readJson(path.join(WS, 'accounts', 'default', 'benchmarks', 'index.json'), null);
    assert.deepEqual(index.items.map((b) => b.id), ['b_timeout', 'b_verified']); // 未请求列表前已在任务终止时合并
    const listed = await api('GET', '/api/benchmarks?account=default');
    assert.deepEqual(listed.body.items.map((b) => b.id), ['b_timeout', 'b_verified']);
    assert.equal(listed.body.items[0].verifiedAt, undefined);
    assert.equal(listed.body.items[1].followers, '3000');
    assert.ok(listed.body.items[1].verifiedAt);
    assert.equal(listed.body.checkpointIssues.incomplete, 1);
    await stop();
    const pending = path.join(WS, 'accounts', 'default', 'benchmarks', 'checkpoints', 'pending');
    fs.writeFileSync(path.join(pending, 'b_restart.candidate.json'), JSON.stringify({
      id: 'b_restart', stage: 'candidate', name: '重启时恢复',
    }));
    await start('text');
    const afterStart = store.readJson(path.join(WS, 'accounts', 'default', 'benchmarks', 'index.json'), null);
    assert.ok(afterStart.items.some((b) => b.id === 'b_restart')); // 启动阶段合并，而不是等首次 GET
    const reopened = await api('GET', '/api/benchmarks?account=default');
    assert.deepEqual(reopened.body.items.map((b) => b.id), ['b_timeout', 'b_verified', 'b_restart']);
    assert.equal((await api('GET', `/api/chat?id=${sent.body.id}`)).body.messages.at(-1).status, 'error');
  } finally {
    await stop();
  }
});
