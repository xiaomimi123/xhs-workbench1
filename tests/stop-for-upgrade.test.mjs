import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { VERSION } from '../xhs-workbench/server/version.mjs';

const CLI = path.join(import.meta.dirname, '..', 'xhs-workbench', 'scripts', 'workbench.mjs');

async function freePort() {
  return new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

// 假的「正在运行的旧工作台」：只回答 /api/health 和 /api/bridge，版本和忙闲由参数决定
async function fakeRunning({ version, running = 0, pending = 0 }) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-sfu-'));
  fs.mkdirSync(path.join(ws, 'run'), { recursive: true });
  const port = await freePort();
  const code = `require('http').createServer((q,r)=>{r.setHeader('content-type','application/json');
    if(q.url==='/api/health')return r.end(JSON.stringify({name:'xhs-workbench'}));
    if(q.url==='/api/bridge')return r.end(JSON.stringify({status:{running:${running},pending:${pending}}}));
    r.statusCode=404;r.end('{}');}).listen(${port},'127.0.0.1');`;
  const child = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
  fs.writeFileSync(path.join(ws, 'run', 'server.json'), JSON.stringify({ pid: child.pid, port, version }));
  fs.writeFileSync(path.join(ws, 'run', 'token'), 'tok');
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch { /* 还没起来 */ } await new Promise((r) => setTimeout(r, 100)); }
  return { ws, child, alive: () => { try { process.kill(child.pid, 0); return true; } catch { return false; } } };
}

const stop = (ws) => spawnSync(process.execPath, [CLI, 'stop', '--for-upgrade'], { env: { ...process.env, XHS_WORKSPACE: ws }, encoding: 'utf8' });

test('运行中的版本和本包一样新：什么都不做', async () => {
  const f = await fakeRunning({ version: VERSION });
  try {
    const r = stop(f.ws);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /不用升级/);
    assert.ok(f.alive());
  } finally { f.child.kill(); }
});

test('运行中的旧版本还有任务在跑：不停，退出码 3，输出 BUSY', async () => {
  const f = await fakeRunning({ version: '0.0.1', running: 1, pending: 1 });
  try {
    const r = stop(f.ws);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /BUSY/);
    assert.match(r.stdout, /2 个任务/);
    assert.ok(f.alive(), '有任务在跑时绝不能停');
  } finally { f.child.kill(); }
});

test('运行中的旧版本空闲：停掉它并等到端口释放', async () => {
  const f = await fakeRunning({ version: '0.0.1' });
  try {
    const r = stop(f.ws);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /已停止/);
    await new Promise((r2) => setTimeout(r2, 300));
    assert.ok(!f.alive());
  } finally { f.child.kill(); }
});

test('没有版本信息的更老的工作台当作旧版本；没在运行时 stop 照常说未运行', async () => {
  const f = await fakeRunning({ version: undefined });
  try {
    assert.equal(stop(f.ws).status, 0);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!f.alive());
  } finally { f.child.kill(); }
  const none = stop(fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-sfu-')));
  assert.equal(none.status, 0);
  assert.match(none.stdout, /未运行/);
});
