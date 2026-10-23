// 可选浏览器依赖：只在用户启用后台有头采集时安装到本地数据目录。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { WORKSPACE } from './paths.mjs';
import { ensureDir } from './store.mjs';

export const PLAYWRIGHT_VERSION = '1.64.1';
export const BROWSER_RUNTIME_DIR = path.join(WORKSPACE, 'browser-runtime');
const PACKAGE_DIR = path.join(BROWSER_RUNTIME_DIR, 'node_modules', 'playwright-core');

export function browserRuntimeStatus() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8'));
    if (pkg.name === 'playwright-core' && pkg.version === PLAYWRIGHT_VERSION && fs.existsSync(path.join(PACKAGE_DIR, 'index.mjs'))) {
      return { available: true, version: pkg.version, dir: BROWSER_RUNTIME_DIR };
    }
  } catch {
    /* 尚未安装 */
  }
  return { available: false, version: PLAYWRIGHT_VERSION, dir: BROWSER_RUNTIME_DIR };
}

export async function loadPlaywright() {
  if (!browserRuntimeStatus().available) throw new Error('后台浏览器依赖尚未安装，请运行 browser-worker-setup');
  return import(pathToFileURL(path.join(PACKAGE_DIR, 'index.mjs')).href);
}

function npmCommand() {
  // 优先用和当前 node 同一套的 npm（中枢装的便携 Node、官方安装包都把 npm 放在 node 旁边），不依赖 PATH
  const near = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
  return fs.existsSync(near) ? near : 'npm';
}
const NPM_ARGS = () => ['install', '--prefix', BROWSER_RUNTIME_DIR, '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', `playwright-core@${PLAYWRIGHT_VERSION}`];

let installing = null;
/** 后台安装（不阻塞工作台服务）。同时只装一次；已装好直接返回。只装 playwright-core 这个库，浏览器用电脑上的 Edge / Chrome。 */
export function installBrowserRuntimeAsync() {
  if (browserRuntimeStatus().available) return Promise.resolve(browserRuntimeStatus());
  if (installing) return installing;
  ensureDir(BROWSER_RUNTIME_DIR);
  installing = new Promise((resolve, reject) => {
    const cmd = npmCommand();
    const child = spawn(process.platform === 'win32' ? `"${cmd}"` : cmd, NPM_ARGS(), { shell: process.platform === 'win32', windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    const timer = setTimeout(() => child.kill(), 300_000);
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`安装浏览器组件失败：${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && browserRuntimeStatus().available) resolve(browserRuntimeStatus());
      else reject(new Error(`安装浏览器组件失败：${err.trim().slice(-600) || `npm 退出码 ${code}，请检查网络`}`));
    });
  }).finally(() => { installing = null; });
  return installing;
}

export function installBrowserRuntime() {
  ensureDir(BROWSER_RUNTIME_DIR);
  const result = spawnSync(npmCommand(), NPM_ARGS(), {
    encoding: 'utf8', shell: process.platform === 'win32', timeout: 180_000, windowsHide: true,
  });
  if (result.error || result.status !== 0 || !browserRuntimeStatus().available) {
    throw new Error(`安装后台浏览器依赖失败：${(result.stderr || result.error?.message || '请检查 npm 网络连接').trim().slice(-600)}`);
  }
  return browserRuntimeStatus();
}
