// 采集节奏：真实 HTTP + 真实检查点文件。总开关 / 冷静期 / 上限只能走接口改；读太快会自动关总开关；闸门在服务端，不是只在界面上拦
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { useTempWorkspace, server, SKILL, PNG_1PX } from './helpers.mjs';

delete process.env.XHS_PACE_RELAX;   // 这里要测真实的闸门，不能放宽
const WS = useTempWorkspace();
const store = await server('store.mjs'); store.ensureWorkspace();
store.saveAccount({ id: 'default', xhsId: 'test-owner' });
store.saveBridgeConfig({ mode: 'inbox', browser: 'none' });
const ops = await server('automation.mjs'); ops.saveAutomation('default', { curator: { everyHours: 0 } });
const wait = async (fn, n = 200) => { for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } throw new Error('等待失败'); };

test('闸门：默认关着；冷静期、总开关、上限都走接口；不满足时开始采集 409 并说明原因', async () => {
  const child = spawn(process.execPath, [path.join(SKILL, 'server/server.mjs')], { env: { ...process.env, XHS_WORKSPACE: WS }, stdio: 'ignore' });
  try {
    const info = await wait(() => store.readJson(path.join(WS, 'run/server.json'), null));
    const token = fs.readFileSync(path.join(WS, 'run/token'), 'utf8');
    const call = async (method, route, body) => {
      const r = await fetch(`http://127.0.0.1:${info.port}${route}`, { method, headers: { 'X-Workbench-Token': token, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const pace = async () => (await call('GET', '/api/browse/pace?account=default')).body;
    const policy = (body) => call('POST', '/api/browse/policy?account=default', body);

    // 1) 全新账号：总开关关着，开始采集被拒，原因写在返回里
    assert.equal((await pace()).status, 'block');
    await call('POST', '/api/benchmarks?account=default', { name: '对标 A' });
    let r = await call('POST', '/api/benchmarks/collection?account=default', { action: 'fill' });
    assert.equal(r.status, 409); assert.match(r.body.error, /总开关是关着的/);
    assert.equal((await call('GET', '/api/agent/next')).body.task, null);          // 没有派发任何任务

    // 2) 打开总开关（时段放宽到全天，免得测试随一天里的时间变化）
    assert.equal((await policy({ action: 'set-limits', limits: { windowStart: '00:00', windowEnd: '23:59' } })).status, 200);
    assert.equal((await policy({ action: 'enable' })).body.status, 'go');
    // 节奏都满足，但浏览器方式不是 WorkBuddy 插件（新机器默认 none）：当场拒绝并说明去哪里改
    r = await call('POST', '/api/benchmarks/collection?account=default', { action: 'fill' });
    assert.equal(r.status, 409); assert.match(r.body.error, /WorkBuddy 浏览器插件.*连接与设置 → 执行 Agent 与浏览器/);
    assert.equal((await policy({ action: 'set-limits', limits: { notesPerDay: 999 } })).status, 400);

    // 3) 冷静期：设上之后总开关被关、采集被拒；解除冷静期不会替用户把总开关打开
    const cool = await policy({ action: 'set-cooldown', days: 7, reason: '收到平台提示' });
    assert.equal(cool.body.enabled, false); assert.equal(cool.body.cooldown.active, true);
    r = await call('POST', '/api/benchmarks/collection?account=default', { action: 'resume' });
    assert.equal(r.status, 409);
    const cleared = await policy({ action: 'clear-cooldown' });
    assert.equal(cleared.body.cooldown, null); assert.equal(cleared.body.enabled, false);
    assert.match((await pace()).reason, /总开关是关着的/);
    assert.equal((await policy({ action: 'bogus' })).status, 400);

    // 4) 策略文件损坏按「禁止」（接中枢时文件放在状态目录里，见 pace.test.mjs；这里没接中枢，放账号目录）
    fs.writeFileSync(path.join(WS, 'accounts/default/pace-policy.json'), '{坏');
    assert.match((await pace()).reason, /策略文件损坏/);
    assert.equal((await policy({ action: 'enable' })).status, 200);                // 通过接口重写后恢复

    // 5) 插件方式下的「核实主页」入口：不是插件配置就拒绝
    const bad = await call('POST', '/api/chat/send', { accountId: 'default', text: 'x', taskKind: 'benchmark.agent', benchmarkId: 'b_x' });
    assert.equal(bad.status, 409); assert.match(bad.body.error, /WorkBuddy 插件/);
  } finally { child.kill(); await new Promise((r) => child.once('exit', r)); }
});

test('读得太快：agent 连着写两篇笔记检查点，工作台记账、判定违规、自动关掉总开关；账本里没有 xsec_token', async () => {
  fs.rmSync(path.join(WS, 'run/server.json'), { force: true });   // 上一个服务退出后留下的旧端口信息
  const child = spawn(process.execPath, [path.join(SKILL, 'server/server.mjs')], { env: { ...process.env, XHS_WORKSPACE: WS }, stdio: 'ignore' });
  try {
    const info = await wait(() => store.readJson(path.join(WS, 'run/server.json'), null));
    const token = fs.readFileSync(path.join(WS, 'run/token'), 'utf8');
    const call = async (method, route, body) => {
      const r = await fetch(`http://127.0.0.1:${info.port}${route}`, { method, headers: { 'X-Workbench-Token': token, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    await call('POST', '/api/browse/policy?account=default', { action: 'enable' });
    assert.equal((await call('GET', '/api/browse/pace?account=default')).body.enabled, true);
    const pending = path.join(WS, 'accounts/default/benchmarks/checkpoints/pending');
    const id = 'b_fast'; const url = 'https://www.xiaohongshu.com/user/profile/testfast';
    const common = { id, url, xhsId: 'test-target', profileName: '测试作者', observedAt: new Date().toISOString() };
    store.writeJson(path.join(pending, `${id}.candidate.json`), { id, stage: 'candidate', name: '测试作者' });
    store.writeJson(path.join(pending, `${id}.verified.json`), { ...common, stage: 'verified' });
    const dir = path.join(WS, 'accounts/default/benchmarks', id); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'avatar-source-0123456789abcdef.png'), PNG_1PX);
    const obs = (step, fields) => store.writeJson(path.join(pending, `${id}.observation-1234abcd-${step}.json`), { ...common, stage: 'observation', source: 'agent-visible', state: 'profile', ...fields });
    obs(0, { profile: { bio: '仅隔离测试' }, avatarFile: 'avatar-source-0123456789abcdef.png', discoveredCount: 2 });
    await wait(async () => (await call('GET', `/api/benchmarks/detail?account=default&id=${id}`)).body.observation?.avatar);
    for (let i = 1; i <= 2; i++) {
      obs(i, { notes: [{ url: `https://www.xiaohongshu.com/explore/fastnote${i}?xsec_token=SECRETTOKEN`, title: `笔记 ${i}`, position: i - 1 }], attemptedCount: i });
    }
    // 两份几乎同时到：第二篇距第一篇不到 20 秒 → 违规 → 总开关自动关
    const after = await wait(async () => { const p = (await call('GET', '/api/browse/pace?account=default')).body; return p.enabled === false ? p : null; }, 300);
    assert.equal(after.today.notes, 2); assert.equal(after.today.profiles, 1);
    const ledger = fs.readFileSync(path.join(WS, 'accounts/default/pace-ledger.jsonl'), 'utf8');
    assert.match(ledger, /"kind":"violation"/); assert.match(ledger, /fastnote1/); assert.doesNotMatch(ledger, /SECRETTOKEN|xsec/);
    assert.match((await call('POST', '/api/benchmarks/collection?account=default', { action: 'resume' })).body.error, /总开关是关着的/);
  } finally { child.kill(); await new Promise((r) => child.once('exit', r)); }
});
