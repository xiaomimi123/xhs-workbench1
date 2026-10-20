// Agent 探测与选择：桌面类 agent 可被探测，多选项时不替用户决定，已有选择不被悄悄改掉
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { server } from './helpers.mjs';

const { detectDesktopAgents, planConnection, DESKTOP_AGENTS, findDesktopAgent } = await server('adapters.mjs');

test('探测桌面类 agent：用户目录配置夹或应用目录任一存在即可', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-home-'));
  try {
    assert.deepEqual(detectDesktopAgents({ home, env: {}, platform: 'win32' }), []);
    fs.mkdirSync(path.join(home, '.workbuddy'));
    const found = detectDesktopAgents({ home, env: {}, platform: 'win32' });
    assert.deepEqual(found.map((a) => a.id), ['workbuddy']);
    assert.equal(found[0].mode, 'inbox');
    const app = path.join(home, 'AppData', 'Local', 'Programs', 'cursor');
    fs.mkdirSync(app, { recursive: true });
    const withApp = detectDesktopAgents({ home, env: { LOCALAPPDATA: path.join(home, 'AppData', 'Local') }, platform: 'win32' });
    assert.deepEqual(withApp.map((a) => a.id).sort(), ['cursor', 'workbuddy']);
    // 缺少环境变量时不能把 %LOCALAPPDATA% 展开成根目录误判
    assert.deepEqual(detectDesktopAgents({ home: path.join(home, 'none'), env: {}, platform: 'win32', exists: (p) => p.startsWith('/Programs') }), []);
    // macOS 应用目录
    const mac = detectDesktopAgents({ home: path.join(home, 'none'), env: {}, platform: 'darwin', exists: (p) => p === '/Applications/Trae.app' });
    assert.deepEqual(mac.map((a) => a.id), ['trae']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('桌面类 id 不会与命令行 agent id 冲突', () => {
  const adapters = ['claude-code', 'codex', 'codebuddy', 'gemini', 'qwen', 'opencode'];
  for (const d of DESKTOP_AGENTS) assert.equal(adapters.includes(d.id), false);
  assert.equal(findDesktopAgent('workbuddy').name, 'WorkBuddy');
  assert.equal(findDesktopAgent('claude-code'), undefined);
});

test('同时有 Claude Code 和 WorkBuddy 时不替用户决定', () => {
  const plan = planConnection({ cliIds: ['claude-code'], desktopIds: ['workbuddy'] });
  assert.equal(plan.action, 'choose');
  assert.deepEqual(plan.options, ['claude-code', 'workbuddy']);
  assert.equal(planConnection({ cliIds: ['claude-code', 'codex'], desktopIds: [] }).action, 'choose');
});

test('明确指定：桌面类走收件箱并记录是谁，命令行类只测试该命令行', () => {
  assert.deepEqual(planConnection({ cliIds: ['claude-code'], desktopIds: ['workbuddy'], prefer: 'workbuddy' }), { action: 'inbox', hostId: 'workbuddy' });
  assert.deepEqual(planConnection({ cliIds: ['claude-code'], desktopIds: ['workbuddy'], prefer: 'claude-code' }), { action: 'cli', id: 'claude-code' });
});

test('只有一个选项时直接用；一个都没有时收件箱兜底', () => {
  assert.deepEqual(planConnection({ cliIds: ['codex'], desktopIds: [] }), { action: 'cli', id: 'codex' });
  assert.deepEqual(planConnection({ cliIds: [], desktopIds: ['workbuddy'] }), { action: 'inbox', hostId: 'workbuddy' });
  assert.deepEqual(planConnection({ cliIds: [], desktopIds: [] }), { action: 'inbox', hostId: null });
});

test('已有选择会被沿用，不会被另一个 agent 悄悄改掉；--auto 才恢复自动挑选', () => {
  const both = { cliIds: ['claude-code'], desktopIds: ['workbuddy'] };
  assert.deepEqual(planConnection({ ...both, current: { mode: 'inbox', hostAgent: { id: 'workbuddy' } } }), { action: 'inbox', hostId: 'workbuddy' });
  assert.deepEqual(planConnection({ ...both, current: { mode: 'cli', adapter: { id: 'claude-code' } } }), { action: 'cli', id: 'claude-code' });
  // 原 CLI 已卸载：重新让用户选
  assert.equal(planConnection({ cliIds: ['codex'], desktopIds: ['workbuddy'], current: { mode: 'cli', adapter: { id: 'claude-code' } } }).action, 'choose');
  assert.equal(planConnection({ ...both, auto: true }).action, 'cli');
});
