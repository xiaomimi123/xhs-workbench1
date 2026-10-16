# 一次性补丁：browser.mjs 支持系统真实浏览器 channel（跑完即删）

p = 'server/browser.mjs'
s = open(p, encoding='utf8').read()

old = """export function mcpConfigFor(accountId, pkg, headless = false) {
  if (!pkg) throw new Error('浏览器控制配置不完整，请重新运行 browser-setup');
  if (!/^[\\w-]+$/.test(accountId || '')) accountId = getAccounts().defaultAccountId || 'default';
  migrateLegacyProfile();
  const file = path.join(P.config, 'mcp', `${accountId}.json`);
  const args = ['-y', pkg, '--user-data-dir', PROFILE_DIR, '--output-dir', path.join(P.run, 'browser-output', accountId)];
  if (headless) args.push('--headless');
  const want = { mcpServers: { playwright: { command: 'npx', args } } };
  if (JSON.stringify(readJson(file, null)) !== JSON.stringify(want)) writeJson(file, want);
  return file;
}"""
new = """// 系统真实浏览器探测：真实浏览器二进制的指纹和真人无差，比无头 / 内置 Chromium 封号风险低得多。
// Windows 上 Edge 预装在所有 Win10/11；mac / Linux 常见的是 Chrome。
const REAL_BROWSER_PATHS = [
  ['msedge', [
    'C:\\\\Program Files (x86)\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe',
    'C:\\\\Program Files\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ]],
  ['chrome', [
    'C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe',
    'C:\\\\Program Files (x86)\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe',
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
 * 生成（或复用）MCP 配置文件，返回路径。
 * opts: { headless, browser } — browser: 'msedge' | 'chrome'（真实浏览器）| 'chromium'（内置）
 */
export function mcpConfigFor(accountId, pkg, opts = {}) {
  if (typeof opts === 'boolean') opts = { headless: opts }; // 兼容旧调用
  if (!pkg) throw new Error('浏览器控制配置不完整，请重新运行 browser-setup');
  if (!/^[\\w-]+$/.test(accountId || '')) accountId = getAccounts().defaultAccountId || 'default';
  migrateLegacyProfile();
  const file = path.join(P.config, 'mcp', `${accountId}.json`);
  const args = ['-y', pkg, '--user-data-dir', PROFILE_DIR, '--output-dir', path.join(P.run, 'browser-output', accountId)];
  if (opts.browser && opts.browser !== 'chromium') args.push('--browser', opts.browser);
  if (opts.headless) args.push('--headless');
  const want = { mcpServers: { playwright: { command: 'npx', args } } };
  if (JSON.stringify(readJson(file, null)) !== JSON.stringify(want)) writeJson(file, want);
  return file;
}"""
assert old in s, 'mcpConfigFor not found'
s = s.replace(old, new)
s = s.replace("import { readJson, writeJson, ensureDir } from './store.mjs';",
              "import { readJson, writeJson, ensureDir, getAccounts } from './store.mjs';\nimport { spawnSync } from 'node:child_process';")
open(p, 'w', encoding='utf8').write(s)
print('browser.mjs ok')
