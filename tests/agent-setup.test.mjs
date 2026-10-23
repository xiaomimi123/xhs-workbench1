// 第一阶段：网页里完成 agent 设置（默认连 CodeBuddy、登录检查、浏览器方式、权限档）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTempWorkspace, server } from './helpers.mjs';

useTempWorkspace();
const store = await server('store.mjs');
store.ensureWorkspace();
const setup = await server('agent-setup.mjs');
const cb = () => [{ id: 'codebuddy', name: 'CodeBuddy Code', command: 'C:/x/codebuddy.cmd' }];

test('没有连接配置、本机有 CodeBuddy CLI 时直接连它；已有配置或没有 CodeBuddy 时不动', () => {
  assert.equal(setup.ensureDefaultConnection(() => []), false);
  assert.equal(store.getBridgeConfig(), null);
  assert.equal(setup.ensureDefaultConnection(cb), true);
  const cfg = store.getBridgeConfig();
  assert.deepEqual([cfg.mode, cfg.adapter.id, cfg.adapter.command, cfg.browser, cfg.autoConfigured], ['cli', 'codebuddy', 'C:/x/codebuddy.cmd', 'none', true]);
  assert.equal(setup.ensureDefaultConnection(cb), false);  // 已有配置：不改（员工选过收件箱也不会被改回来）
});

test('登录检查：没登录时标记 needsLogin，登录后变成 ok', async () => {
  let s = await setup.checkCodebuddy(async () => ({ ok: false, error: '回复中没有 PONG（实际回复：空）；错误输出：Authentication required. Please use /login command' }), cb);
  assert.equal(s.installed, true); assert.equal(s.ok, false); assert.equal(s.needsLogin, true);
  s = await setup.checkCodebuddy(async () => ({ ok: true }), cb);
  assert.equal(s.ok, true); assert.equal(s.needsLogin, false);
  s = await setup.checkCodebuddy(async () => ({ ok: false, error: '超时（120 秒）未完成' }), cb);
  assert.equal(s.needsLogin, false);  // 别的错误不算「没登录」
  assert.throws(() => setup.openCodebuddyLogin(() => []), /没有检测到 CodeBuddy/);
});

test('浏览器方式：连接测试通过才保存；WorkBuddy 插件找不到时说明怎么装；切到测试档必须确认', async () => {
  const before = store.getBridgeConfig();
  await assert.rejects(setup.setBrowserEngine('workbuddy', { detectWb: () => null, ping: async () => ({ ok: true }) }), /没有找到 WorkBuddy 浏览器插件/);
  await assert.rejects(setup.setBrowserEngine('workbuddy', { detectWb: () => 'C:/wb/browser-mcp.exe', ping: async () => ({ ok: false, error: 'Authentication required' }) }), /原设置保持不变/);
  assert.deepEqual(store.getBridgeConfig(), before);
  const r = await setup.setBrowserEngine('workbuddy', { detectWb: () => 'C:/wb/browser-mcp.exe', ping: async () => ({ ok: true }) });
  assert.deepEqual(r, { ok: true, browser: 'workbuddy', browserMode: 'readonly' });
  assert.equal(store.getBridgeConfig().adapter.workbuddyMcp, 'C:/wb/browser-mcp.exe');
  assert.throws(() => setup.setBrowserMode('test'), /需要确认/);
  assert.equal(setup.setBrowserMode('test', true).browserMode, 'test');
  assert.equal(setup.setBrowserMode('readonly').browserMode, 'readonly');
  await setup.setBrowserEngine('none', { ping: async () => ({ ok: true }) });
  assert.equal(store.getBridgeConfig().browser, 'none');
  assert.throws(() => setup.setBrowserMode('readonly'), /先在上面选一种浏览器方式/);
  await assert.rejects(setup.setBrowserEngine('chrome'), /不支持/);
});
