// 打开应用时发现正在跑的是旧版本：空闲就换成新版本，不用员工理解「重启」；同版本不动；问不到状态时不打断
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { useTempWorkspace, server, SKILL } from './helpers.mjs';

const WS = useTempWorkspace();
const wait = async (fn, n = 200) => { for (let i = 0; i < n; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } throw new Error('等待失败'); };
const readInfo = () => { try { return JSON.parse(fs.readFileSync(path.join(WS, 'run/server.json'), 'utf8')); } catch { return null; } };
const version = async (info) => (await (await fetch(`http://127.0.0.1:${info.port}/api/health`)).json()).version;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const start = () => spawnSync(process.execPath, [path.join(SKILL, 'scripts/workbench.mjs'), 'start'], { env: { ...process.env, XHS_WORKSPACE: WS }, encoding: 'utf8', timeout: 60_000 });

test('旧版本在跑且空闲：start 把它换成当前版本；同版本再 start 不重启', async () => {
  // 造一个「旧版本」：复制整个应用目录，把版本号改小
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-old-'));
  fs.cpSync(SKILL, old, { recursive: true, filter: (p) => !p.includes('node_modules') });
  const verFile = path.join(old, 'server/version.mjs');
  fs.writeFileSync(verFile, fs.readFileSync(verFile, 'utf8').replace(/VERSION = '[^']+'/, "VERSION = '0.0.1'"));
  const oldProc = spawn(process.execPath, [path.join(old, 'server/server.mjs')], { env: { ...process.env, XHS_WORKSPACE: WS }, stdio: 'ignore' });
  let newPid = null;
  try {
    const oldInfo = await wait(() => readInfo());
    await wait(async () => (await version(oldInfo).catch(() => '')) === '0.0.1');
    const r = start();
    assert.match(r.stdout, /正在运行的是旧版本 v0\.0\.1，现在没有任务，换成 v/);
    assert.match(r.stdout, /工作台已启动/);
    const now = await wait(() => { const i = readInfo(); return i && i.pid !== oldInfo.pid ? i : null; });
    newPid = now.pid;
    assert.notEqual(await version(now), '0.0.1');
    assert.equal(alive(oldInfo.pid), false);
    // 同版本再 start：直接复用，不重启
    const again = start();
    assert.match(again.stdout, /工作台已在运行/); assert.doesNotMatch(again.stdout, /旧版本/);
    assert.equal(readInfo().pid, newPid);
  } finally {
    oldProc.kill();
    if (newPid) { try { process.kill(newPid); } catch { /* 已退出 */ } }
    fs.rmSync(old, { recursive: true, force: true });
  }
});

test('旧版本在跑但有任务排着：不打断，只说明；任务结束后再打开才会换', async () => {
  fs.rmSync(path.join(WS, 'run/server.json'), { force: true });
  const store = await server('store.mjs'); store.ensureWorkspace();
  store.saveAccount({ id: 'default', xhsId: 'test-owner' });
  store.saveBridgeConfig({ mode: 'inbox', browser: 'none' });
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-old-'));
  fs.cpSync(SKILL, old, { recursive: true, filter: (p) => !p.includes('node_modules') });
  const verFile = path.join(old, 'server/version.mjs');
  fs.writeFileSync(verFile, fs.readFileSync(verFile, 'utf8').replace(/VERSION = '[^']+'/, "VERSION = '0.0.2'"));
  const oldProc = spawn(process.execPath, [path.join(old, 'server/server.mjs')], { env: { ...process.env, XHS_WORKSPACE: WS }, stdio: 'ignore' });
  try {
    const info = await wait(() => readInfo());
    await wait(async () => (await version(info).catch(() => '')) === '0.0.2');
    const token = fs.readFileSync(path.join(WS, 'run/token'), 'utf8').trim();
    const sent = await fetch(`http://127.0.0.1:${info.port}/api/chat/send`, { method: 'POST', headers: { 'X-Workbench-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: 'default', text: '排一个任务' }) });
    assert.equal(sent.status, 200);                                  // 收件箱模式：任务排着等 agent 来领
    const r = start();
    assert.match(r.stdout, /正在运行的是旧版本 v0\.0\.2.*有任务在跑（1 个任务在排队）.*没有自动重启/);
    assert.equal(alive(info.pid), true); assert.equal(readInfo().pid, info.pid);
    assert.equal(await version(info), '0.0.2');
  } finally { oldProc.kill(); fs.rmSync(old, { recursive: true, force: true }); }
});
