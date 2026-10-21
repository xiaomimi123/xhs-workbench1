// CodeBuddy 适配与两档浏览器权限（readonly 只读 / test 测试档）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { useTempWorkspace, server } from './helpers.mjs';

useTempWorkspace(); // 必须先于加载 server 模块：隔离数据目录，不碰真实的 ~/XHS-Workbench
const { applyBrowser, mcpConfigFor, CODEBUDDY_BROWSER_DENY, CODEBUDDY_TEST_DENY, CODEBUDDY_TEST_BLOCKED_ORIGINS } = await server('browser.mjs');
const { ADAPTERS } = await server('adapters.mjs');

const base = ADAPTERS.find((a) => a.id === 'codebuddy');
const PKG = '@playwright/mcp@0.0.83';

// 多值参数（--allowedTools / --disallowedTools）取该参数后面、下一个 - 开头参数之前的全部值
const multi = (args, flag) => {
  const i = args.indexOf(flag);
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < args.length && !String(args[j]).startsWith('-'); j++) out.push(args[j]);
  return out;
};

test('CodeBuddy 适配器：提示词走标准输入，工具名逐项传（逗号拼成一项放行不生效）', () => {
  assert.equal(base.promptVia, 'stdin');
  assert.ok(!base.args.includes('{prompt}'));
  const allowed = multi(base.args, '--allowedTools');
  assert.deepEqual(allowed, ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']);
  assert.ok(allowed.every((t) => !t.includes(',')));
});

test('只读档（默认）：浏览器写类工具全部禁用，不屏蔽任何域名', () => {
  const a = applyBrowser(base, 'playwright', PKG);
  assert.equal(a.browserMode, 'readonly');
  assert.deepEqual(multi(a.args, '--disallowedTools'), CODEBUDDY_BROWSER_DENY);
  for (const t of ['click', 'type', 'fill_form', 'file_upload', 'press_key', 'evaluate', 'run_code_unsafe']) {
    assert.ok(CODEBUDDY_BROWSER_DENY.includes(`mcp__playwright__browser_${t}`), t);
  }
  assert.ok(multi(a.args, '--allowedTools').includes('mcp__playwright'));
  assert.ok(a.args.includes('{mcpConfig}'));
  assert.equal(a.blockedOrigins, undefined);
});

test('测试档：放开点击 / 输入，仍禁用上传文件和执行脚本，并屏蔽创作者中心（发布入口）', () => {
  const a = applyBrowser({ ...base, browserMode: 'test' }, 'playwright', PKG);
  assert.equal(a.browserMode, 'test');
  const deny = multi(a.args, '--disallowedTools');
  assert.deepEqual(deny, CODEBUDDY_TEST_DENY);
  for (const t of ['file_upload', 'evaluate', 'run_code_unsafe']) assert.ok(deny.includes(`mcp__playwright__browser_${t}`), t);
  for (const t of ['click', 'type', 'press_key']) assert.ok(!deny.includes(`mcp__playwright__browser_${t}`), t);
  assert.deepEqual(a.blockedOrigins, CODEBUDDY_TEST_BLOCKED_ORIGINS);
  assert.ok(a.blockedOrigins.includes('https://creator.xiaohongshu.com'));
});

test('applyBrowser 幂等；关闭浏览器控制后回到基础参数，不留模式和屏蔽域名', () => {
  for (const mode of ['readonly', 'test']) {
    const a = applyBrowser({ ...base, browserMode: mode }, 'playwright', PKG);
    assert.deepEqual(applyBrowser(a, 'playwright', PKG).args, a.args, mode);
  }
  const on = applyBrowser({ ...base, browserMode: 'test' }, 'playwright', PKG);
  const off = applyBrowser(on, null);
  assert.deepEqual(off.args, base.args);
  assert.equal(off.browserMode, undefined);
  assert.equal(off.blockedOrigins, undefined);
  assert.equal(off.playwrightMcp, undefined);
});

test('CodeBuddy 只支持 Playwright 方式的浏览器控制', () => {
  assert.throws(() => applyBrowser(base, 'chrome', PKG), /仅支持 Playwright/);
});

test('mcpConfigFor：blockedOrigins 写成分号分隔的 --blocked-origins；没有时不加', () => {
  const cfg = (o) => JSON.parse(fs.readFileSync(mcpConfigFor('codebuddy-test', PKG, o), 'utf8')).mcpServers.playwright.args;
  const plain = cfg({ headless: false });
  assert.ok(!plain.includes('--blocked-origins'));
  const blocked = cfg({ headless: false, blockedOrigins: ['https://creator.xiaohongshu.com', 'https://example.org'] });
  assert.equal(blocked[blocked.indexOf('--blocked-origins') + 1], 'https://creator.xiaohongshu.com;https://example.org');
});
