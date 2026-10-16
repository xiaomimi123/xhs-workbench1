// 按账号隔离的浏览器：每个账号一份 Playwright 浏览器资料（登录状态互不影响）
import fs from 'node:fs';
import path from 'node:path';
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

/**
 * 生成（或复用）某个账号的 MCP 配置文件，返回路径。
 * pkg：锁定版本的包名（browser-setup 时写入 adapter.playwrightMcp）
 */
export function mcpConfigFor(accountId, pkg, headless = false) {
  if (!pkg) throw new Error('浏览器控制配置不完整，请重新运行 browser-setup');
  if (!/^[\w-]+$/.test(accountId || '')) accountId = getAccounts().defaultAccountId || 'default';
  migrateLegacyProfile();
  const file = path.join(P.config, 'mcp', `${accountId}.json`);
  const args = ['-y', pkg, '--user-data-dir', path.join(PROFILES_DIR, accountId), '--output-dir', path.join(P.run, 'browser-output', accountId)];
  if (headless) args.push('--headless');
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
