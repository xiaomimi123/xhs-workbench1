import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { compareVersions, restartBlocker, UpdateChecker, spawnRestartHelper } from '../xhs-workbench/server/self-update.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-su-'));
function mcpFile(dir) {
  const f = path.join(dir, 'hub-mcp.json');
  fs.writeFileSync(f, JSON.stringify({ mcpServers: { 'enterprise-hub': { command: 'uv', args: ['run', '--quiet', '/x/hub_agent.py', 'mcp', '--nested'] } } }));
  return f;
}

test('版本比较：逐段按数字，不是按字符串', () => {
  assert.equal(compareVersions('0.8.21', '0.8.12'), 1);
  assert.equal(compareVersions('0.8.9', '0.8.12'), -1);
  assert.equal(compareVersions('0.9.0', '0.8.99'), 1);
  assert.equal(compareVersions('0.8.21', '0.8.21'), 0);
  assert.equal(compareVersions('0.8', '0.8.0'), 0);
  assert.equal(compareVersions(undefined, '0.1'), -1);
});

test('有任务在跑或排队时不允许重启', () => {
  assert.equal(restartBlocker({ running: 0, pending: 0 }).ok, true);
  const r = restartBlocker({ running: 1, pending: 2 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /3 个任务/);
});

test('中枢版本更高才提示；带接入器才能重启', async () => {
  const dir = tmp();
  const env = { HUB_MCP_SERVERS_FILE: mcpFile(dir) };
  const hubGen = { available: () => true, request: async () => ({ apps: [{ id: 'other', version: '9.9.9' }, { id: 'xhs-workbench', version: '0.8.21' }] }) };
  const u = await new UpdateChecker({ hubGen, current: '0.8.12', env }).check();
  assert.equal(u.available, true);
  assert.equal(u.latest, '0.8.21');
  assert.equal(u.canRestart, true);
  const same = await new UpdateChecker({ hubGen, current: '0.8.21', env }).check();
  assert.equal(same.available, false);
  const noConnector = await new UpdateChecker({ hubGen, current: '0.8.12', env: {} }).check();
  assert.equal(noConnector.canRestart, false);
});

test('没接中枢、中枢报错或中枢太旧没有这个接口：静默不提示，不抛错', async () => {
  const off = await new UpdateChecker({ hubGen: { available: () => false }, current: '0.8.12', env: {} }).check();
  assert.equal(off.available, false);
  const bad = await new UpdateChecker({ hubGen: { available: () => true, request: async () => { throw new Error('404'); } }, current: '0.8.12', env: {} }).check();
  assert.equal(bad.available, false);
  assert.match(bad.reason, /404/);
});

test('10 分钟内用缓存，force 才重查', async () => {
  let calls = 0, t = 1000;
  const hubGen = { available: () => true, request: async () => { calls++; return { apps: [{ id: 'xhs-workbench', version: '0.8.21' }] }; } };
  const c = new UpdateChecker({ hubGen, current: '0.8.12', env: {}, now: () => t });
  await c.check(); await c.check();
  assert.equal(calls, 1);
  t += 11 * 60 * 1000; await c.check();
  assert.equal(calls, 2);
  await c.check({ force: true });
  assert.equal(calls, 3);
});

test('找不到接入器就不拉辅助进程', () => {
  const r = spawnRestartHelper({ env: {}, logFile: path.join(tmp(), 'l.log') });
  assert.equal(r.ok, false);
  assert.match(r.error, /接入器/);
});

test('辅助进程参数：带上旧 pid 和 open-app 命令，且脱离父进程', () => {
  const dir = tmp();
  let seen;
  const fake = (cmd, args, opts) => { seen = { cmd, args, opts }; return { unref() {} }; };
  const r = spawnRestartHelper({ env: { HUB_MCP_SERVERS_FILE: mcpFile(dir) }, pid: 4242, logFile: path.join(dir, 'l.log'), spawnImpl: fake });
  assert.equal(r.ok, true);
  assert.equal(seen.args[1], '4242');
  assert.deepEqual(JSON.parse(seen.args[2]), { command: 'uv', args: ['run', '--quiet', '/x/hub_agent.py', 'open-app', 'xhs-workbench'] });
  assert.equal(seen.opts.detached, true);
  assert.equal(seen.opts.windowsHide, true);
});

test('restart-self：等旧进程退出之后才启动接入器（真实进程）', async () => {
  const dir = tmp();
  const marker = path.join(dir, 'marker.txt');
  const fakeConnector = path.join(dir, 'connector.mjs');
  fs.writeFileSync(fakeConnector, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, String(Date.now())); console.log('started');`);
  const old = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 1500)'], { stdio: 'ignore' });
  const helper = path.join(import.meta.dirname, '..', 'xhs-workbench', 'scripts', 'restart-self.mjs');
  const spec = JSON.stringify({ command: process.execPath, args: [fakeConnector] });
  const t0 = Date.now();
  const child = spawn(process.execPath, [helper, String(old.pid), spec], { stdio: 'pipe' });
  let out = ''; child.stdout.on('data', (d) => { out += d; });
  await new Promise((r) => child.on('close', r));
  assert.ok(fs.existsSync(marker), out);
  assert.ok(Number(fs.readFileSync(marker, 'utf8')) - t0 >= 1200, '应当等到旧进程退出（约 1.5 秒）之后才启动');
  assert.match(out, /接入器退出码 0/);
});
