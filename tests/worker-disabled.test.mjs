// 后台 Playwright 采集 / 登录核对已停用：采集只走 WorkBuddy 插件。组件本身、HTTP 接口、队列选路都拒绝
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { useTempWorkspace, server, SKILL } from './helpers.mjs';

const WS = useTempWorkspace();
delete process.env.XHS_ALLOW_WORKER_COLLECT;   // 这里要测的是产品默认状态：不放开
const store = await server('store.mjs'); store.ensureWorkspace();
store.saveAccount({ id: 'default', xhsId: 'test-owner' });
store.saveBridgeConfig({ mode: 'inbox', browser: 'none' });
const { BrowserWorker, workerCollectAllowed, WORKER_DISABLED } = await server('browser-worker.mjs');
const { collectionRoute } = await server('benchmark-queue.mjs');
const wait = async (fn, n = 200) => { for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } throw new Error('等待失败'); };

test('组件本身：verify / prepare 一进来就拒绝，不启动任何浏览器', async () => {
  let loaded = 0;
  const worker = new BrowserWorker({ assertAccess: () => {}, lockAccess: () => {}, load: async () => { loaded++; throw new Error('不该加载'); }, profileRoot: WS, detect: () => 'chrome' });
  const account = { id: 'default', name: '账号', xhsId: 'test-owner' };
  assert.equal(workerCollectAllowed(), false);
  await assert.rejects(worker.prepare(account), (e) => e.message === WORKER_DISABLED);
  await assert.rejects(worker.verify(account, { id: 'b_1', name: 'A', url: 'https://www.xiaohongshu.com/user/profile/x' }), (e) => e.message === WORKER_DISABLED);
  assert.equal(loaded, 0);
});

test('队列选路：只有浏览器方式是 WorkBuddy 插件才走 agent；后台组件即使「可用」也不用', () => {
  const ready = { enabled: true, available: true, compatible: true };
  assert.equal(collectionRoute({ ...ready, compatible: false }, { mode: 'cli', browser: 'workbuddy' }), 'agent');
  assert.equal(collectionRoute({ enabled: false, available: false, compatible: false }, { mode: 'cli', browser: 'playwright' }), null);
  assert.equal(collectionRoute({ enabled: false }, { mode: 'cli', browser: 'chrome' }), null);
});

test('HTTP：后台组件显示已停用；开启、后台核实、登录核对都 409', async () => {
  const child = spawn(process.execPath, [path.join(SKILL, 'server/server.mjs')], { env: { ...process.env, XHS_WORKSPACE: WS }, stdio: 'ignore' });
  try {
    const info = await wait(() => store.readJson(path.join(WS, 'run/server.json'), null));
    const token = fs.readFileSync(path.join(WS, 'run/token'), 'utf8');
    const call = async (method, route, body) => {
      const r = await fetch(`http://127.0.0.1:${info.port}${route}`, { method, headers: { 'X-Workbench-Token': token, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const w = (await call('GET', '/api/bridge')).body.status.browserWorker;
    assert.equal(w.disabled, true); assert.equal(w.enabled, false); assert.equal(w.compatible, false);
    const on = await call('POST', '/api/browser/worker', { enabled: true });
    assert.equal(on.status, 409); assert.match(on.body.error, /已停用/);
    await call('POST', '/api/benchmarks?account=default', { name: '对标 A' });
    const b = (await call('GET', '/api/benchmarks?account=default')).body.items[0];
    for (const taskKind of ['benchmark.verify', 'browser.prepare']) {
      const r = await call('POST', '/api/chat/send', { accountId: 'default', text: 'x', taskKind, benchmarkId: b.id });
      assert.equal(r.status, 409, taskKind); assert.match(r.body.error, /WorkBuddy 浏览器插件/);
    }
  } finally { child.kill(); await new Promise((r) => child.once('exit', r)); }
});
