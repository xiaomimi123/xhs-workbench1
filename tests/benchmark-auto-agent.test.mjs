// 真实 HTTP + 收件箱 agent 协议，观察值为隔离测试数据，并非真实页面证据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { useTempWorkspace, server, SKILL, PNG_1PX } from './helpers.mjs';
const WS = useTempWorkspace();
const store = await server('store.mjs'); store.ensureWorkspace();
store.saveAccount({ id: 'default', xhsId: 'test-owner' });
store.saveBridgeConfig({ mode: 'inbox', browser: 'builtin' });
const ops = await server('automation.mjs'); ops.saveAutomation('default', { curator: { everyHours: 0 } });
const wait = async (fn) => { for (let i = 0; i < 150; i++) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 50)); } throw new Error('等待失败'); };
test('worker 关闭：一次推荐请求，agent 原任务就地逐篇落盘，服务不重复派发', async () => {
  const child = spawn(process.execPath, [path.join(SKILL, 'server/server.mjs')], { env: { ...process.env, XHS_WORKSPACE: WS }, stdio: 'ignore' });
  try {
    const info = await wait(() => store.readJson(path.join(WS, 'run/server.json'), null));
    const token = fs.readFileSync(path.join(WS, 'run/token'), 'utf8');
    const api = async (method, route, body) => {
      const r = await fetch(`http://127.0.0.1:${info.port}${route}`, { method, headers: { 'X-Workbench-Token': token, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
      assert.equal(r.status, 200); return r.json();
    };
    await api('POST', '/api/chat/send', { accountId: 'default', text: '推荐并抓取对标' });
    const { task } = await api('GET', '/api/agent/next');
    assert.ok(task);
    const pending = path.join(WS, 'accounts/default/benchmarks/checkpoints/pending');
    const id = 'b_agent'; const url = 'https://www.xiaohongshu.com/user/profile/testagent';
    const common = { id, url, xhsId: 'test-target', profileName: '测试作者', observedAt: new Date().toISOString() };
    store.writeJson(path.join(pending, `${id}.candidate.json`), { id, stage: 'candidate', name: '测试作者' });
    store.writeJson(path.join(pending, `${id}.verified.json`), { ...common, stage: 'verified' });
    const dir = path.join(WS, 'accounts/default/benchmarks', id); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'avatar-source-0123456789abcdef.png'), PNG_1PX);
    const obs = (step, fields) => store.writeJson(path.join(pending, `${id}.observation-1234abcd-${step}.json`), { ...common, stage: 'observation', source: 'agent-visible', state: 'profile', ...fields });
    obs(0, { profile: { bio: '仅隔离测试' }, avatarFile: 'avatar-source-0123456789abcdef.png', discoveredCount: 2 });
    await wait(async () => (await api('GET', `/api/benchmarks/detail?account=default&id=${id}`)).observation?.avatar);
    assert.equal((await api('GET', '/api/agent/next')).task, null);
    for (let i = 1; i <= 2; i++) {
      obs(i, { notes: [{ url: `https://www.xiaohongshu.com/explore/testnote${i}`, title: `测试笔记 ${i}`, position: i - 1 }], attemptedCount: i });
      await wait(async () => (await api('GET', `/api/benchmarks/detail?account=default&id=${id}`)).observation?.notes.length === i);
    }
    obs(6, { state: 'complete', attemptedCount: 2 });
    await api('POST', '/api/agent/reply', { taskId: task.id, final: true, text: '已完成隔离数据观察' });
    await wait(async () => (await api('GET', '/api/benchmarks?account=default')).collection.items[0]?.state === 'complete');
    assert.equal((await api('GET', '/api/agent/next')).task, null);
    // 批量入口不重采已完成目标；缺项目标自动转入 agent 任务，错误准确暂停。
    await api('POST', '/api/benchmarks?account=default', { name: '未采集旧目标' });
    await api('POST', '/api/benchmarks/collection?account=default', { action: 'fill' });
    const next = await wait(async () => (await api('GET', '/api/agent/next')).task);
    await api('POST', '/api/agent/reply', { taskId: next.id, error: '需要本人登录' });
    const state = (await api('GET', '/api/benchmarks?account=default')).collection;
    assert.equal(state.paused, true); assert.equal(state.reason, '需要本人登录');
    assert.equal(state.items[0].state, 'complete');
    console.log(`隔离演示目录：${WS}；真实页面：未验证`);
  } finally { child.kill(); await new Promise(r => child.once('exit', r)); }
});
