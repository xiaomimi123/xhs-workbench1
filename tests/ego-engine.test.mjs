// 浏览器方式「ego lite」：检测、MCP 配置、CodeBuddy 参数（只放行 ego-reader、不带禁用列表）、选择与权限档、网页上的选项和提示词
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempWorkspace, server, ROOT } from './helpers.mjs';

useTempWorkspace();
const store = await server('store.mjs');
store.ensureWorkspace();
const browser = await server('browser.mjs');
const setup = await server('agent-setup.mjs');
const adapters = await server('adapters.mjs');
const { P } = await server('paths.mjs');
const EXE = 'C:/Users/x/.local/share/ego/active_version_dir/ego-browser.exe';

test('检测 ego-browser：环境变量 > 默认安装位置 > PATH；都没有返回 null', () => {
  const slash = (p) => String(p).split(path.sep).join('/');   // Windows 的反斜杠统一成斜杠再比较
  const exists = (set) => (p) => set.includes(slash(p));
  assert.equal(browser.detectEgoBrowser('C:/Users/x', exists(['D:/mine/ego-browser.exe']), { EGO_BROWSER_BIN: 'D:/mine/ego-browser.exe', PATH: '' }), 'D:/mine/ego-browser.exe');
  assert.equal(slash(browser.detectEgoBrowser('C:/Users/x', exists([EXE]), { PATH: '' })), EXE);
  const which = browser.detectEgoBrowser('C:/Users/x', exists(['C:/tools/ego-browser.exe']), { PATH: ['C:/a', 'C:/tools'].join(path.delimiter) });
  assert.equal(slash(which), 'C:/tools/ego-browser.exe');
  assert.equal(browser.detectEgoBrowser('C:/Users/x', () => false, { PATH: 'C:/a' }), null);
});

test('MCP 配置：用工作台自己的 node 启动随包的 ego-reader，并把 ego-browser 路径和状态文件位置交给它', () => {
  const file = browser.egoMcpConfigFor('default', EXE);
  assert.equal(file, path.join(P.config, 'mcp', 'default.ego.json'));
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const s = cfg.mcpServers['ego-reader'];
  assert.equal(s.command, process.execPath);
  assert.equal(s.args[0], browser.egoReaderScript());
  assert.ok(fs.existsSync(s.args[0]), 'ego-reader 随包存在');
  assert.equal(s.env.EGO_BROWSER_BIN, EXE);
  assert.ok(s.env.EGO_READER_STATE.startsWith(P.run) && s.env.EGO_READER_STOP_FILE.startsWith(P.run));
  assert.throws(() => browser.egoMcpConfigFor('default', null), /ego lite 配置不完整/);
});

test('CodeBuddy 参数：放行 mcp__ego-reader、带 MCP 配置、不带禁用工具列表；换成别的方式后 egoMcp 被清掉', () => {
  const base = adapters.findAdapter('codebuddy');
  const a = browser.applyBrowser({ ...base, command: 'cb' }, 'ego', EXE);
  const i = a.args.indexOf('--allowedTools');
  assert.ok(a.args.slice(i).includes('mcp__ego-reader'));
  assert.ok(!a.args.includes('mcp__browser') && !a.args.includes('mcp__playwright'));
  assert.ok(a.args.includes('--mcp-config') && a.args.includes('{mcpConfig}'));
  assert.ok(!a.args.includes('--disallowedTools'));
  assert.equal(a.egoMcp, EXE);
  assert.equal(a.browserMode, 'readonly');
  const none = browser.applyBrowser(a, null);
  assert.equal(none.egoMcp, undefined);
  assert.ok(!none.args.includes('mcp__ego-reader') && !none.args.includes('--mcp-config'));
  assert.throws(() => browser.applyBrowser({ ...adapters.findAdapter('codex') }, 'ego', EXE), /仅支持 Playwright/);
});

test('选择 ego：没装 ego lite 给出明确提示；连接测试通过才保存；只能配合 CodeBuddy', async () => {
  store.saveBridgeConfig({ mode: 'cli', adapter: { ...adapters.findAdapter('codebuddy'), command: 'cb' }, browser: 'none', testedAt: null });
  await assert.rejects(setup.setBrowserEngine('ego', { detectEgo: () => null }), /没有找到 ego lite.*ego-browser skill/);
  assert.equal(store.getBridgeConfig().browser, 'none');
  await assert.rejects(setup.setBrowserEngine('ego', { detectEgo: () => EXE, ping: async () => ({ ok: false, error: 'boom' }) }), /连接测试没通过/);
  assert.equal(store.getBridgeConfig().browser, 'none');
  const r = await setup.setBrowserEngine('ego', { detectEgo: () => EXE, ping: async () => ({ ok: true }) });
  assert.deepEqual([r.ok, r.browser, r.browserMode], [true, 'ego', 'readonly']);
  const cfg = store.getBridgeConfig();
  assert.equal(cfg.browser, 'ego');
  assert.equal(cfg.adapter.egoMcp, EXE);
  assert.equal(setup.browserOptions().current, 'ego');
  store.saveBridgeConfig({ ...cfg, adapter: { ...cfg.adapter, id: 'codex' } });
  await assert.rejects(setup.setBrowserEngine('ego', { detectEgo: () => EXE }), /只能配合 CodeBuddy/);
  store.saveBridgeConfig(cfg);
});

test('ego 方式没有测试档：切权限档被拒绝', () => {
  assert.equal(store.getBridgeConfig().browser, 'ego');
  assert.throws(() => setup.setBrowserMode('test', true), /只有只读档/);
  assert.throws(() => setup.setBrowserMode('readonly'), /只有只读档/);
});

// ---- 网页 ----
const web = (p) => fs.readFileSync(path.join(ROOT, 'xhs-workbench', 'web', p), 'utf8');

test('网页：「连接与设置」里有 ego lite 选项，没装时不可选并说明怎么装；权限档区域不对 ego 显示', () => {
  const src = web('agent-setup.js');
  assert.match(src, /id: 'ego', name: 'ego lite 浏览器（实验）'/);
  assert.match(src, /e\.id === 'ego' && !b\.egoBrowser/);
  assert.match(src, /e\.id === 'workbuddy' && unavailable \?/);
  assert.match(src, /\['playwright', 'workbuddy'\]\.includes\(b\.current\)/);   // 权限档区域不含 ego
});

test('网页：ego 方式的核对提示词只用 xhs_read_me，未登录时按游客处理并写 loggedIn:false，已登录才分析主页', async () => {
  const vm = await import('node:vm');
  const bench = web('modules/benchmark.js');
  const start = bench.indexOf('export async function checkLoginAccount()');
  const end = bench.indexOf('function radarFormHtml()');
  const code = bench.slice(start, end).replace('export async function', 'async function') + '\ncheckLoginAccount';
  const asked = [];
  const fn = vm.runInContext(code, vm.createContext({ S: { accountId: 'a1', bridge: { mode: 'cli', browser: 'ego' } }, accDirRel: () => 'accounts/a1', ask: (t, f) => asked.push([t, f]), toast: () => {} }));
  await fn();
  const t = asked[0][0];
  assert.match(t, /mcp__ego-reader/);
  assert.match(t, /xhs_read_me（只调用这一次）/);
  assert.match(t, /loggedIn 为 false.*游客.*不能凭能看到内容就当作已登录/s);
  assert.match(t, /accounts\/a1\/browser\.json/);
  assert.match(t, /accounts\/a1\/profile-suggestion\.json/);
  assert.match(t, /仅在已登录时/);
  assert.match(t, /不要读别人的主页或笔记、不要发布/);
  assert.equal(asked[0][1], true);
});
