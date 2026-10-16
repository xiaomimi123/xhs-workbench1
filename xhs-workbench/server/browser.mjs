// 单账号浏览器资料：一份 Playwright 配置，与用户日常浏览器登录态隔离。
// 优先用系统安装的真实浏览器（Edge / Chrome）——真实浏览器二进制的指纹和真人无差，
// 比无头 / 内置 Chromium 的封号风险低得多；都没装时才用 Playwright 内置 Chromium。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { P, WORKSPACE } from './paths.mjs';
import { readJson, writeJson, ensureDir, getAccounts } from './store.mjs';

export const PROFILES_DIR = path.join(WORKSPACE, 'browser-profiles');
const LEGACY_PROFILE = path.join(WORKSPACE, 'browser-profile'); // v0.3 只有一份资料

/** 旧版单一浏览器资料迁移到默认账号名下（v0.3 只能登一个号，登的就是默认账号） */
export function migrateLegacyProfile() {
  if (!fs.existsSync(LEGACY_PROFILE)) return null;
  const { defaultAccountId, accounts } = getAccounts();
  const id = defaultAccountId || (accounts[0] && accounts[0].id);
  if (!id) return null;
  const target = path.join(PROFILES_DIR, id);
  if (fs.existsSync(target)) return null;
  ensureDir(PROFILES_DIR);
  fs.renameSync(LEGACY_PROFILE, target);
  return id;
}

// 系统真实浏览器探测：Windows 上 Edge 预装在所有 Win10/11
const REAL_BROWSER_PATHS = [
  ['msedge', [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ]],
  ['chrome', [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]],
];

/** 探测系统里安装的真实浏览器，返回 'msedge' | 'chrome' | null（都没有 → 用内置 Chromium） */
export function detectRealBrowser() {
  for (const [name, paths] of REAL_BROWSER_PATHS) {
    if (paths.some((p) => fs.existsSync(p))) return name;
  }
  if (process.platform !== 'win32') {
    for (const bin of ['microsoft-edge', 'microsoft-edge-stable', 'google-chrome', 'google-chrome-stable']) {
      const r = spawnSync('which', [bin], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) return name;
    }
  }
  return null;
}

/**
 * 生成（或复用）某个账号的 MCP 配置文件，返回路径。
 * pkg：锁定版本的包名（browser-setup 时写入 adapter.playwrightMcp）
 * opts：{ headless, browser } — browser: 'msedge' | 'chrome'（系统真实浏览器）| 'chromium'（内置）
 */
export function mcpConfigFor(accountId, pkg, opts = {}) {
  if (typeof opts === 'boolean') opts = { headless: opts }; // 兼容旧调用（第三参曾是布尔）
  if (!pkg) throw new Error('浏览器控制配置不完整，请重新运行 browser-setup');
  if (!/^[\w-]+$/.test(accountId || '')) accountId = getAccounts().defaultAccountId || 'default';
  migrateLegacyProfile();
  const file = path.join(P.config, 'mcp', `${accountId}.json`);
  const args = ['-y', pkg, '--user-data-dir', path.join(PROFILES_DIR, accountId), '--output-dir', path.join(P.run, 'browser-output', accountId)];
  if (opts.browser && opts.browser !== 'chromium') args.push('--browser', opts.browser);
  if (opts.headless) args.push('--headless');
  const want = { mcpServers: { playwright: { command: 'npx', args } } };
  if (JSON.stringify(readJson(file, null)) !== JSON.stringify(want)) writeJson(file, want);
  return file;
}

/** agent 登录检查后写的 accounts/<id>/browser.json */
export function browserStatus(accountId) {
  return readJson(path.join(P.accountsDir, accountId, 'browser.json'), null);
}

/**
 * 给 Claude Code 适配器加上 / 去掉浏览器控制参数，返回新的适配器（不修改原对象）。
 * engine: 'playwright' | 'chrome' | null（去掉）
 */
export function applyBrowser(adapter, engine, pkg) {
  const args = [...adapter.args];
  const drop = (flag, withValue) => {
    const i = args.indexOf(flag);
    if (i >= 0) args.splice(i, withValue ? 2 : 1);
  };
  drop('--mcp-config', true);
  drop('--chrome', false);
  let i = args.indexOf('--allowedTools');
  if (i < 0) {
    args.push('--allowedTools', 'WebSearch,WebFetch');
    i = args.indexOf('--allowedTools');
  }
  const tools = args[i + 1].split(',').filter((t) => t && !t.startsWith('mcp__playwright') && !t.startsWith('mcp__claude-in-chrome'));
  const next = { ...adapter };
  delete next.playwrightMcp;
  if (engine === 'playwright') {
    args.push('--mcp-config', '{mcpConfig}');
    tools.push('mcp__playwright');
    next.playwrightMcp = pkg;
  } else if (engine === 'chrome') {
    args.push('--chrome');
    tools.push('mcp__claude-in-chrome');
  }
  args[args.indexOf('--allowedTools') + 1] = tools.join(',');
  next.args = args;
  return next;
}
