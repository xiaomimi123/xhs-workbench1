// 在网页里完成 agent 设置（不再要员工或 agent 去终端里跑 bridge-test / browser-setup / browser-mode）：
// - 默认连接 CodeBuddy CLI（网页工作台的唯一执行者；WorkBuddy 等桌面 agent 只作后备的收件箱值守）
// - 检查 CodeBuddy 有没有登录；没登录时在员工桌面上弹一个终端运行 codebuddy，员工自己输入 /login
// - 选择浏览器方式（工作台独立浏览器 / 员工自己的 Edge·WorkBuddy 插件 / 不用浏览器）和权限档（只读 / 测试）
import os from 'node:os';
import { spawn } from 'node:child_process';
import { ADAPTERS, findAdapter } from './adapters.mjs';
import { detectAdapters, pingAdapter } from './bridge.mjs';
import { applyBrowser, detectRealBrowser, detectWorkbuddyBrowserMcp, detectEgoBrowser } from './browser.mjs';
import { sanitizeAgentEnv } from './agent-env.mjs';
import { getBridgeConfig, saveBridgeConfig, httpError } from './store.mjs';
import { reportHealth } from './health-outbox.mjs';

/** 没有连接配置、但本机装了 CodeBuddy CLI 时，直接连它（不问用哪个 agent，也不把 WorkBuddy 设成值守）。返回是否新建了配置。 */
export function ensureDefaultConnection(detect = () => detectAdapters(ADAPTERS)) {
  if (getBridgeConfig()) return false;
  const cb = detect().find((a) => a.id === 'codebuddy');
  if (!cb) return false;
  saveBridgeConfig({ mode: 'cli', adapter: { ...findAdapter('codebuddy'), command: cb.command }, browser: 'none', testedAt: null, autoConfigured: true });
  return true;
}

// ---------- CodeBuddy 登录状态 ----------
let status = { checkedAt: null, ok: null, needsLogin: false, error: '' };
let checking = null;

export function codebuddyStatus(detect = () => detectAdapters(ADAPTERS)) {
  const cb = detect().find((a) => a.id === 'codebuddy');
  return { installed: !!cb, command: cb?.command || '', checking: !!checking, ...status };
}

/** 用最简单的连接测试（不带浏览器）判断 CodeBuddy 能不能用：没登录时它会说 Authentication required。 */
export function checkCodebuddy(ping = pingAdapter, detect = () => detectAdapters(ADAPTERS)) {
  if (checking) return checking;
  const cb = detect().find((a) => a.id === 'codebuddy');
  if (!cb) return Promise.resolve(codebuddyStatus(detect));
  checking = (async () => {
    const r = await ping({ ...findAdapter('codebuddy'), command: cb.command }, 120_000, 1).catch((e) => ({ ok: false, error: e.message }));
    status = { checkedAt: new Date().toISOString(), ok: r.ok, needsLogin: !r.ok && /Authentication required|\/login|未登录|not logged in/i.test(r.error || ''), error: r.ok ? '' : String(r.error || '').slice(0, 400) };
    reportHealth({ stage: 'doctor', ok: r.ok, code: status.needsLogin ? 'CLI_NOT_LOGGED_IN' : '', message: r.error || '', agent: 'CodeBuddy Code' });
    return codebuddyStatus(detect);
  })().finally(() => { checking = null; });
  return checking;
}

/** 在员工桌面上弹一个终端运行 codebuddy，员工在里面输入 /login。工作台由员工自己启动（桌面图标 / 开机自启）时才弹得出来。 */
export function openCodebuddyLogin(detect = () => detectAdapters(ADAPTERS), run = spawn) {
  const cb = detect().find((a) => a.id === 'codebuddy');
  if (!cb) throw httpError(404, '本机没有检测到 CodeBuddy CLI，请先重新运行中枢的接入命令（询问时选择安装）');
  const env = sanitizeAgentEnv(process.env); // 不带 agent 沙箱的变量，否则登录会写到别处
  const home = os.homedir();
  let child;
  if (process.platform === 'win32') {
    // start 新开一个可见的控制台窗口；cmd /k 让窗口在 codebuddy 退出后留着，员工能看到结果
    child = run('cmd.exe', ['/d', '/c', 'start', '"CodeBuddy 登录"', 'cmd.exe', '/k', `"${cb.command}"`], { cwd: home, env, detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
  } else if (process.platform === 'darwin') {
    const quoted = cb.command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    child = run('osascript', ['-e', `tell application "Terminal" to do script "cd ~; \\"${quoted}\\""`, '-e', 'tell application "Terminal" to activate'], { env, detached: true, stdio: 'ignore' });
  } else {
    throw httpError(400, '请在终端里运行 codebuddy，然后输入 /login');
  }
  child.unref?.();
  return { ok: true, hint: '已在桌面上打开一个终端窗口：在里面输入 /login 回车，按提示在浏览器里登录你的 CodeBuddy 账号，完成后输入 /exit，再回到这里点「重新检查」。' };
}

// ---------- 浏览器方式与权限档 ----------
export const BROWSER_ENGINES = ['none', 'playwright', 'workbuddy', 'ego'];

async function latestPlaywrightMcp() {
  // 只在第一次选「工作台独立浏览器」时查一次版本（之后沿用配置里锁定的版本）
  return new Promise((resolve) => {
    const child = spawn('npm', ['view', '@playwright/mcp', 'version'], { shell: process.platform === 'win32', windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(/^\d+\.\d+\.\d+/.test(out.trim()) ? `@playwright/mcp@${out.trim()}` : ''));
  });
}

/**
 * 网页里切换浏览器方式。会先用新配置跑一次连接测试，通过才保存（不通过时原配置不变）。
 * 选员工自己的 Edge（WorkBuddy 插件）时，工作台的后台读取组件用不上，交给调用方关掉。
 */
export async function setBrowserEngine(engine, { ping = pingAdapter, detectWb = detectWorkbuddyBrowserMcp, detectEgo = detectEgoBrowser, playwrightPkg = latestPlaywrightMcp } = {}) {
  if (!BROWSER_ENGINES.includes(engine)) throw httpError(400, '浏览器方式不支持');
  const cfg = getBridgeConfig();
  if (cfg?.mode !== 'cli' || !cfg.adapter) throw httpError(409, '请先连接 CodeBuddy（命令行模式），再设置浏览器');
  if (engine === 'workbuddy' && cfg.adapter.id !== 'codebuddy') throw httpError(409, '「我的 Edge（WorkBuddy 插件）」目前只能配合 CodeBuddy 使用');
  if (engine === 'ego' && cfg.adapter.id !== 'codebuddy') throw httpError(409, '「ego lite 浏览器」目前只能配合 CodeBuddy 使用');
  let pkg = null;
  if (engine === 'ego') {
    pkg = detectEgo();
    if (!pkg) throw httpError(409, '没有找到 ego lite：请先安装 ego lite（https://lite.ego.app/）并完成首次设置，装好后新开一个终端能运行 ego-browser skill，再回到这里。');
  } else if (engine === 'workbuddy') {
    pkg = detectWb();
    if (!pkg) throw httpError(409, '没有找到 WorkBuddy 浏览器插件：请在 WorkBuddy「设置 > 智能体 > 浏览器操控」打开「让 WorkBuddy 控制浏览器」，并安装 Edge 或 Chrome 扩展');
  } else if (engine === 'playwright') {
    pkg = cfg.adapter.playwrightMcp || await playwrightPkg();
    if (!pkg) throw httpError(502, '查不到 Playwright MCP 的版本，请检查网络（需要能访问 npm）');
  }
  let adapter = applyBrowser({ ...cfg.adapter }, engine === 'none' ? null : engine, pkg);
  if (engine === 'playwright') {
    adapter.browserChannel = cfg.adapter.browserChannel || detectRealBrowser() || 'chromium';
    adapter.headless = false;
  }
  const r = await ping(adapter, 300_000);
  reportHealth({ stage: 'doctor', ok: r.ok, message: r.ok ? '' : `浏览器方式（${engine}）连接测试失败：${r.error}`, agent: adapter.name });
  if (!r.ok) throw httpError(502, `连接测试没通过，原设置保持不变：${r.error}`);
  saveBridgeConfig({ ...cfg, adapter, browser: engine, testedAt: new Date().toISOString() });
  return { ok: true, browser: engine, browserMode: adapter.browserMode || null };
}

/** 切换权限档：只读档（默认）/ 测试档（能点击、输入，要员工明确确认，测完切回）。 */
export function setBrowserMode(mode, confirmed) {
  if (!['readonly', 'test'].includes(mode)) throw httpError(400, '权限档只能是 readonly 或 test');
  if (mode === 'test' && confirmed !== true) throw httpError(400, '切到测试档需要确认：测试档下 agent 能点击和输入，测完请切回只读档');
  const cfg = getBridgeConfig();
  if (cfg?.browser === 'ego') throw httpError(409, 'ego lite 浏览器只有只读档：它只提供读取工具，没有点击和输入');
  if (cfg?.mode !== 'cli' || cfg.adapter?.id !== 'codebuddy' || !['playwright', 'workbuddy'].includes(cfg.browser)) throw httpError(409, '先在上面选一种浏览器方式');
  const pkg = cfg.browser === 'workbuddy' ? cfg.adapter.workbuddyMcp : cfg.adapter.playwrightMcp;
  const adapter = applyBrowser({ ...cfg.adapter, browserMode: mode }, cfg.browser, pkg);
  adapter.headless = cfg.adapter.headless; adapter.browserChannel = cfg.adapter.browserChannel;
  saveBridgeConfig({ ...cfg, adapter });
  return { ok: true, browserMode: adapter.browserMode };
}

/** 网页「浏览器方式」卡片要的信息 */
export function browserOptions() {
  const cfg = getBridgeConfig();
  const wb = detectWorkbuddyBrowserMcp();
  return {
    current: cfg?.mode === 'cli' ? cfg.browser || 'none' : null,
    browserMode: cfg?.adapter?.browserMode || 'readonly',
    workbuddyPlugin: !!wb,
    egoBrowser: !!detectEgoBrowser(),
    realBrowser: detectRealBrowser(),
  };
}
