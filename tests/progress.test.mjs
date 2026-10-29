// 任务进度提示：用时统计（服务端）、思考摘要、页面上的「已用 / 通常多久 / 当前在做什么」文案
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { recordDuration, typicalDurations } from '../xhs-workbench/server/task-timing.mjs';
import { thinkingExcerpt } from '../xhs-workbench/server/bridge.mjs';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-pg-')), 'durations.json');

test('用时统计：样本不到 3 次不给估计；给出 25% / 中位数 / 80% 分位', () => {
  const f = tmpFile();
  assert.deepEqual(typicalDurations(f), {});
  recordDuration('chat', 40_000, f); recordDuration('chat', 60_000, f);
  assert.deepEqual(typicalDurations(f), {});
  for (const s of [80, 100, 120, 140]) recordDuration('chat', s * 1000, f);
  const t = typicalDurations(f).chat;
  assert.equal(t.n, 6);
  assert.ok(t.low <= t.mid && t.mid <= t.high);
  assert.equal(t.mid, 100);  // 40 60 80 100 120 140 → 取中间偏后一个
});

test('用时统计：太短（秒回 / 失败）和太长（卡住）的不记；只留最近 30 次；各类别互不影响', () => {
  const f = tmpFile();
  assert.equal(recordDuration('chat', 1_000, f), false);
  assert.equal(recordDuration('chat', 41 * 60_000, f), false);
  assert.equal(recordDuration('chat', NaN, f), false);
  assert.equal(recordDuration('', 10_000, f), false);
  for (let i = 0; i < 40; i++) recordDuration('copy', (10 + i) * 1000, f);
  for (let i = 0; i < 3; i++) recordDuration('cover', 20_000, f);
  const all = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(all.copy.length, 30);
  assert.equal(all.copy[0], 20);  // 最早的 10 条被挤掉
  assert.equal(typicalDurations(f).cover.n, 3);
});

test('用时统计：文件坏了不抛错', () => {
  const f = tmpFile(); fs.writeFileSync(f, '{坏的');
  assert.deepEqual(typicalDurations(f), {});
  assert.equal(recordDuration('chat', 10_000, f), true);  // 重新写入
});

test('思考摘要：取最后一段、去掉列表符号、限 120 字', () => {
  assert.equal(thinkingExcerpt('先读文件\n\n- 再检查违禁词'), '再检查违禁词');
  assert.equal(thinkingExcerpt(''), '');
  const long = thinkingExcerpt('字'.repeat(300));
  assert.equal(long.length, 121);
  assert.ok(long.endsWith('…'));
});

// ---- 页面文案 ----
const source = fs.readFileSync(new URL('../xhs-workbench/web/progress.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/export (async )?/g, '$1');
function load(timing = {}) {
  const ctx = vm.createContext({
    S: { timing }, api: async () => timing, icon: (n) => `[${n}]`,
    esc: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    Date, Number, Math, String, document: { querySelectorAll: () => [] }, setInterval: () => 1,
  });
  vm.runInContext(source + '\n;this.__x = { fmtElapsed, typicalText, humanTool, workingHtml, jobTimingHtml };', ctx);
  return ctx.__x;
}

test('用时格式：秒 / 分秒 / 小时', () => {
  const { fmtElapsed } = load();
  assert.equal(fmtElapsed(0), '0 秒');
  assert.equal(fmtElapsed(45_000), '45 秒');
  assert.equal(fmtElapsed(83_000), '1 分 23 秒');
  assert.equal(fmtElapsed(5 * 60_000 + 5_000), '5 分 05 秒');
  assert.equal(fmtElapsed(3_725_000), '1 小时 2 分');
});

test('「通常约」：有样本才显示，区间按分位，样本数写出来', () => {
  assert.equal(load({}).typicalText('chat'), '');
  const t = load({ chat: { n: 12, low: 60, mid: 90, high: 120 } }).typicalText('chat');
  assert.equal(t, '通常约 1–2 分钟（最近 12 次）');
  assert.equal(load({ chat: { n: 5, low: 20, mid: 25, high: 30 } }).typicalText('chat'), '通常约 20–30 秒（最近 5 次）');
  assert.equal(load({ chat: { n: 5, low: 30, mid: 45, high: 100 } }).typicalText('chat'), '通常约 30 秒–1.5 分钟（最近 5 次）');
  assert.equal(load({ chat: { n: 5, low: 100, mid: 130, high: 100 } }).typicalText('chat'), '通常约 1.5 分钟（最近 5 次）');
});

test('工具名换成人话', () => {
  const { humanTool } = load();
  assert.equal(humanTool('Read'), '读取文件');
  assert.equal(humanTool('WebSearch'), '搜索网页');
  assert.equal(humanTool('mcp__enterprise-hub__search_knowledge'), '调用公司中枢');
  assert.equal(humanTool('mcp__browser__tab_goto'), '操作浏览器');
  assert.equal(humanTool('进度'), '进度');
});

test('对话进度：排队中显示已等待；处理中显示已用、通常多久、当前动作；有历史才有「比平时久」', () => {
  const x = load({ chat: { n: 8, low: 30, mid: 45, high: 60 } });
  const now = Date.now();
  const queued = x.workingHtml({ status: 'pending', createdAt: new Date(now - 12_000).toISOString() });
  assert.match(queued, /排队中/); assert.match(queued, /已等待/); assert.doesNotMatch(queued, /通常约/);

  const running = x.workingHtml({ status: 'running', createdAt: new Date(now - 90_000).toISOString(), startedAt: new Date(now - 75_000).toISOString(),
    phase: { kind: 'tool', name: 'WebSearch', detail: '小红书 食品 爆款', at: new Date(now - 4_000).toISOString() } });
  assert.match(running, /agent 正在处理/); assert.match(running, /已用 <b data-elapsed-from="[^"]+">1 分 1\d 秒/);
  assert.match(running, /通常约 30 秒–1 分钟（最近 8 次）/);
  assert.match(running, /搜索网页：小红书 食品 爆款/);
  assert.match(running, /data-slow-after="90"/);   // 60 × 1.5

  const thinking = x.workingHtml({ status: 'running', startedAt: new Date(now - 5_000).toISOString(), phase: { kind: 'thinking', detail: '先检查违禁词', at: new Date(now).toISOString() } });
  assert.match(thinking, /正在想：先检查违禁词/);

  const noHistory = load({}).workingHtml({ status: 'running', startedAt: new Date(now - 5_000).toISOString() });
  assert.doesNotMatch(noHistory, /通常约/); assert.doesNotMatch(noHistory, /data-slow-after/);
});

test('对话进度：思考内容里的 HTML 被转义', () => {
  const h = load({}).workingHtml({ status: 'running', startedAt: new Date().toISOString(), phase: { kind: 'thinking', detail: '<img onerror=x>', at: new Date().toISOString() } });
  assert.doesNotMatch(h, /<img/);
});

test('任务卡片：处理中显示已用和通常多久，完成显示用时，失败不显示', () => {
  const x = load({ copy: { n: 6, low: 40, mid: 60, high: 90 } });
  const now = Date.now();
  assert.match(x.jobTimingHtml({ status: 'running', createdAt: new Date(now - 30_000).toISOString() }, 'copy'), /已用 <b data-elapsed-from="[^"]+">(29|30|31) 秒.*通常约 40 秒–1\.5 分钟/);
  assert.match(x.jobTimingHtml({ status: 'queued', createdAt: new Date(now - 30_000).toISOString() }, 'copy'), /已等待/);
  assert.equal(x.jobTimingHtml({ status: 'done', createdAt: '2026-10-29T08:00:00.000Z', finishedAt: '2026-10-29T08:01:05.000Z' }, 'copy'), ' · 用时 1 分 05 秒');
  assert.equal(x.jobTimingHtml({ status: 'error', createdAt: '2026-10-29T08:00:00.000Z' }, 'copy'), '');
  assert.equal(x.jobTimingHtml(null, 'copy'), '');
});
