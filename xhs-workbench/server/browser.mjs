// 单账号浏览器资料：一份 Playwright 配置，与用户日常浏览器登录态隔离。
// 优先用系统安装的 Edge / Chrome；浏览器二进制并不能保证规避平台风控。
// 都没装时才用 Playwright 内置 Chromium。
import { mergeHubServers } from './hub-mcp.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { P, WORKSPACE } from './paths.mjs';
import { readJson, writeJson, ensureDir, getAccounts } from './store.mjs';

export const PROFILES_DIR = path.join(WORKSPACE, 'browser-profiles');
const LEGACY_PROFILE = path.join(WORKSPACE, 'browser-profile'); // v0.3 只有一份资料

/** Chromium 的 SingletonLock 可能是指向不存在目标的符号链接，existsSync 会误判为无锁。 */
export function profileHasLock(profile) {
  try {
    const lock=path.join(profile,'SingletonLock');
    const stat=fs.lstatSync(lock);
    // Never remove a lock. Only let Chromium handle a proven-dead local owner.
    if(stat.isSymbolicLink()){
      const target=fs.readlinkSync(lock),prefix=os.hostname()+'-';
      const pidText=target.startsWith(prefix)?target.slice(prefix.length):'';
      if(/^[1-9][0-9]*$/.test(pidText)&&Number.isSafeInteger(Number(pidText))){
        try{process.kill(Number(pidText),0);}catch(e){if(e.code==='ESRCH')return false;}
      }
    }
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

/** 旧版单一浏览器资料迁移到默认账号名下（v0.3 只能登一个号，登的就是默认账号） */
export function migrateLegacyProfile() {
  if (!fs.existsSync(LEGACY_PROFILE)) return null;
  if (profileHasLock(LEGACY_PROFILE)) throw new Error('旧版浏览器资料正在被使用；请先关闭使用该资料的浏览器再迁移');
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
      if (r.status === 0 && r.stdout.trim()) return bin.startsWith('microsoft-edge') ? 'msedge' : 'chrome';
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
  if (opts.blockedOrigins?.length) args.push('--blocked-origins', opts.blockedOrigins.join(';')); // 浏览器不得请求这些源（测试档：创作者中心，发布入口所在）
  const want = { mcpServers: { playwright: { command: 'npx', args } } };
  mergeHubServers(want); // 由中枢启动时并入 enterprise-hub 等服务（没有环境变量则无变化）
  if (JSON.stringify(readJson(file, null)) !== JSON.stringify(want)) writeJson(file, want);
  return file;
}

// ---------- WorkBuddy 浏览器插件（用员工自己的 Edge / Chrome） ----------
// WorkBuddy 的 browser-use 插件自带一个标准 stdio MCP 服务 browser-mcp，通过浏览器里的 WorkBuddy 扩展操作员工自己正在用的浏览器
// （沿用已有登录、真人的浏览器环境）。它本身就是 CodeBuddy 插件格式，CodeBuddy CLI 直接把它当 MCP 服务用即可，不需要 WorkBuddy 开着对话。
export function detectWorkbuddyBrowserMcp(home = os.homedir(), exists = fs.existsSync, list = (d) => { try { return fs.readdirSync(d); } catch { return []; } }) {
  const exe = process.platform === 'win32' ? 'browser-mcp.exe' : 'browser-mcp';
  const cache = path.join(home, '.workbuddy', 'plugins', 'cache', 'workbuddy-browser-use', 'browser-use');
  const versions = list(cache).filter((v) => /^\d+(\.\d+)*$/.test(v)).sort((a, b) => b.split('.').map(Number).reduce((r, n, i) => r || n - (a.split('.').map(Number)[i] || 0), 0));
  for (const v of versions) {
    const p = path.join(cache, v, 'bin', exe);
    if (exists(p)) return p;
  }
  const runtime = path.join(home, '.workbuddy', 'native-runtimes', 'browser-use', 'browser-use', 'bin', exe);
  return exists(runtime) ? runtime : null;
}

export function workbuddyMcpConfigFor(accountId, exe) {
  if (!exe) throw new Error('WorkBuddy 浏览器插件配置不完整，请重新运行 browser-setup --engine workbuddy');
  if (!/^[\w-]+$/.test(accountId || '')) accountId = getAccounts().defaultAccountId || 'default';
  const file = path.join(P.config, 'mcp', `${accountId}.workbuddy.json`);
  const want = { mcpServers: { browser: { command: exe, args: [], env: { BROWSER_MCP_SESSION_ID: `xhs-workbench-${accountId}` } } } };
  mergeHubServers(want);
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
  if(adapter.id==='codex'){
    if(engine && engine!=='playwright')throw new Error('Codex 仅支持 Playwright 浏览器连接');
    const next={...adapter,args:[...adapter.args]};delete next.playwrightMcp;delete next.browserTransport;
    if(engine==='playwright'){if(!pkg)throw new Error('浏览器控制配置不完整');next.playwrightMcp=pkg;next.browserTransport='codex';}
    return next;
  }
  if (adapter.id === 'codebuddy') {
    if (engine && engine !== 'playwright' && engine !== 'workbuddy') throw new Error('CodeBuddy 支持 Playwright 或 WorkBuddy 浏览器插件');
    // CodeBuddy 的 --allowedTools / --disallowedTools 是多值参数：每个工具要单独一项（实测把工具名用逗号拼成一项，放行不生效）。
    const args = [...adapter.args];
    const stripMulti = (flag) => {
      const i = args.indexOf(flag);
      if (i < 0) return;
      let j = i + 1;
      while (j < args.length && !String(args[j]).startsWith('-')) j++;
      args.splice(i, j - i);
    };
    stripMulti('--allowedTools');
    stripMulti('--disallowedTools');
    const m = args.indexOf('--mcp-config');
    if (m >= 0) args.splice(m, 2);
    args.push('--allowedTools', ...CODEBUDDY_BASE_TOOLS, ...(engine === 'playwright' ? ['mcp__playwright'] : engine === 'workbuddy' ? ['mcp__browser'] : []));
    const next = { ...adapter };
    delete next.playwrightMcp;
    if (engine !== 'workbuddy') delete next.workbuddyMcp;
    // 两档权限（adapter.browserMode）：
    //  readonly（默认）：点击 / 输入 / 填表 / 上传 / 按键 / 拖放 / 选择 / 执行脚本 / 弹窗处理一律禁用（被禁的工具对 agent 不可见），
    //    只留打开网址、快照、截图、等待、查找、标签页等读取类工具——用于分析数据和学习博主帖子，不允许自动发布。
    //  test（测试档）：点击、输入等交互工具放开，用来验证采集能力；仍禁用上传文件和执行脚本，并屏蔽创作者中心域名（发布入口），
    //    所以发布做不了；点赞 / 评论 / 关注这类站内操作靠提示词约束，测完用 browser-mode readonly 收回。
    const mode = adapter.browserMode === 'test' ? 'test' : 'readonly';
    delete next.blockedOrigins;
    if (engine === 'workbuddy') {
      // 同样两档：只读档只留看、滚动、截图；测试档放开点击和输入，仍禁执行脚本和关掉员工自己的标签页。
      // 这种方式操作的是员工自己的浏览器，没法像 Playwright 那样屏蔽创作者中心域名，「不自动发布」在测试档只能靠提示词和员工在场。
      args.push('--mcp-config', '{mcpConfig}', '--disallowedTools', ...(mode === 'test' ? WORKBUDDY_TEST_DENY : WORKBUDDY_BROWSER_DENY));
      next.workbuddyMcp = pkg;
      next.browserMode = mode;
    } else if (engine === 'playwright') {
      args.push('--mcp-config', '{mcpConfig}', '--disallowedTools', ...(mode === 'test' ? CODEBUDDY_TEST_DENY : CODEBUDDY_BROWSER_DENY));
      next.playwrightMcp = pkg;
      next.browserMode = mode;
      if (mode === 'test') next.blockedOrigins = CODEBUDDY_TEST_BLOCKED_ORIGINS;
    } else {
      delete next.browserMode;
    }
    next.args = args;
    return next;
  }
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

const WB = (t) => `mcp__browser__${t}`;
export const WORKBUDDY_BROWSER_DENY = ['cua_click', 'cua_double_click', 'cua_drag', 'cua_keypress', 'cua_type', 'cua_execute',
  'dom_cua_click', 'dom_cua_double_click', 'dom_cua_keypress', 'dom_cua_type', 'tabs_close'].map(WB);
export const WORKBUDDY_TEST_DENY = ['cua_execute', 'tabs_close'].map(WB);
export const CODEBUDDY_TEST_DENY = ['file_upload', 'evaluate', 'run_code_unsafe'].map((t) => `mcp__playwright__browser_${t}`);
export const CODEBUDDY_TEST_BLOCKED_ORIGINS = ['https://creator.xiaohongshu.com'];
export const CODEBUDDY_BASE_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
// 只读档只禁「能改变页面状态、提交内容或绕过限制」的工具；悬停、改窗口大小、处理弹窗、模拟媒体特性只影响显示，放开（读帖子、滚动加载需要）
export const CODEBUDDY_BROWSER_DENY = ['click', 'type', 'fill_form', 'file_upload', 'press_key', 'drag', 'drop', 'select_option',
  'evaluate', 'run_code_unsafe'].map((t) => `mcp__playwright__browser_${t}`);

/** Per-process Codex overrides; never modify global config or login data. */
export function codexBrowserArgs(adapter,accountId){
 const file=mcpConfigFor(accountId,adapter.playwrightMcp,{headless:!!adapter.headless,browser:adapter.browserChannel,blockedOrigins:adapter.blockedOrigins});
 const config=readJson(file,null).mcpServers.playwright;
 return ['-c',`mcp_servers.playwright.command=${JSON.stringify(config.command)}`,'-c',`mcp_servers.playwright.args=${JSON.stringify(config.args)}`,'-c', 'mcp_servers.playwright.enabled=true',
 '-c','mcp_servers.playwright.enabled_tools=["browser_navigate","browser_snapshot","browser_take_screenshot","browser_wait_for"]',
 ...['browser_navigate','browser_snapshot','browser_take_screenshot','browser_wait_for'].flatMap(tool=>['-c',`mcp_servers.playwright.tools.${tool}.approval_mode="approve"`])];
}
