// ① 数据复盘「让 agent 抓取数据」：WorkBuddy 插件方式下提示词要明确让 agent 在聊天里直接用 mcp__browser__*、自己实时核对登录（虚拟机里它读成了「聊天里不能开浏览器」，什么都没采）
// ② 「连接与设置」里已停用的后台 Playwright 采集卡片不再显示
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (p) => fs.readFileSync(new URL('../xhs-workbench/' + p, import.meta.url), 'utf8');
const analytics = read('web/modules/analytics.js');
const app = read('web/app.js');

function loadHint(S) {
  const start = analytics.indexOf('export function browserFetchHint()');
  const end = analytics.indexOf('const METRICS = [');
  assert.ok(start > 0 && end > start);
  return vm.runInContext(analytics.slice(start, end).replace('export function', 'function') + '\nbrowserFetchHint', vm.createContext({ S }));
}

test('WorkBuddy 插件方式：提示词让 agent 直接用 mcp__browser__*、实时核对登录、不因 browser.json 过期停下、没有笔记也更新账号概览', () => {
  const t = loadHint({ bridge: { mode: 'cli', browser: 'workbuddy' } })();
  assert.match(t, /mcp__browser__\*/);
  assert.match(t, /不属于「自己开 Bash」/);
  assert.match(t, /实时核对登录账号.*超过 30 分钟也由你自己重新核对，不要因此停下/);
  assert.match(t, /tab_goto/);
  assert.match(t, /creator\.xiaohongshu\.com\/new\/home/);
  assert.match(t, /还没有已发布的笔记时，也要更新账号概览/);
  assert.match(t, /不要估算/);
  assert.match(t, /动作之间停 3–8 秒/);
});

test('其他浏览器方式（没有 / ego / Playwright）：不加插件提示，保持原来的提示词', () => {
  for (const S of [{ bridge: null }, { bridge: { mode: 'cli', browser: 'none' } }, { bridge: { mode: 'cli', browser: 'ego' } }, { bridge: { mode: 'cli', browser: 'playwright' } }, { bridge: { mode: 'inbox' } }]) {
    assert.equal(loadHint(S)(), '', JSON.stringify(S));
  }
});

test('「抓取数据」和「首次导入历史笔记」两个按钮都带上这段提示', () => {
  assert.match(analytics, /更新 \$\{dir\}notes\.json 和 account\.json。\$\{browserFetchHint\(\)\}/);
  assert.match(analytics, /imported: true。\$\{browserFetchHint\(\)\}/);
});

test('手册：browser.md 说明别读反那条规则；analytics.md 写了 WorkBuddy 方式的抓取入口和「没有已发布笔记也更新账号概览」', () => {
  const b = read('playbooks/browser.md');
  assert.match(b, /注意不要读反/);
  assert.match(b, /不要因为 `browser\.json` 过期（超过 30 分钟）就停下/);
  const a = read('playbooks/analytics.md');
  assert.match(a, /creator\.xiaohongshu\.com\/new\/note-manager/);
  assert.match(a, /账号还没有已发布的笔记也要更新 `account\.json`/);
});

test('「连接与设置」不再显示「后台 Playwright 采集：已停用」卡片；开发放开时才有开关', () => {
  const start = app.indexOf('function workerSettingsHtml(w = {})');
  const end = app.indexOf('function workerSettingsLegacyHtml');
  const fn = vm.runInContext(app.slice(start, end) + '\nworkerSettingsHtml', vm.createContext({ workerSettingsLegacyHtml: () => '<LEGACY>' }));
  assert.equal(fn({ disabled: true }), '');
  assert.equal(fn({}), '');
  assert.equal(fn({ disabled: false }), '<LEGACY>');
  assert.ok(!app.includes('后台 Playwright 采集：已停用'));
});
