// 可选浏览器依赖：只在用户启用后台有头采集时安装到本地数据目录。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
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

export function installBrowserRuntime() {
  ensureDir(BROWSER_RUNTIME_DIR);
  const result = spawnSync('npm', ['install', '--prefix', BROWSER_RUNTIME_DIR, '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', `playwright-core@${PLAYWRIGHT_VERSION}`], {
    encoding: 'utf8', shell: process.platform === 'win32', timeout: 180_000, windowsHide: true,
  });
  if (result.error || result.status !== 0 || !browserRuntimeStatus().available) {
    throw new Error(`安装后台浏览器依赖失败：${(result.stderr || result.error?.message || '请检查 npm 网络连接').trim().slice(-600)}`);
  }
  return browserRuntimeStatus();
}
