// 「在浏览器登录」提示曾让用户去竞品对标页点「先核对登录账号」，但没有对标账号时那个按钮根本不显示（新用户必然卡住）。
// 现在：账号管理页直接发起核对；竞品对标的空状态里也有这个按钮。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (p) => fs.readFileSync(new URL('../xhs-workbench/web/' + p, import.meta.url), 'utf8');
const bench = read('modules/benchmark.js');

function loadCheck(ctxExtra) {
  const start = bench.indexOf('export async function checkLoginAccount()');
  const end = bench.indexOf('function radarFormHtml()');
  assert.ok(start > 0 && end > start, '找不到 checkLoginAccount');
  const code = bench.slice(start, end).replace('export async function', 'async function') + '\ncheckLoginAccount';
  const ctx = vm.createContext({ ...ctxExtra });
  return vm.runInContext(code, ctx);
}

test('WorkBuddy 插件模式：直接让 agent 只读核对登录账号，不打开对标主页、不发布', async () => {
  const asked = [];
  const fn = loadCheck({ S: { bridge: { mode: 'cli', browser: 'workbuddy' } }, ask: (text, flag) => { asked.push([text, flag]); }, toast: () => assert.fail('不应弹提示') });
  await fn();
  assert.equal(asked.length, 1);
  assert.match(asked[0][0], /核对当前登录的小红书号/);
  assert.match(asked[0][0], /不要打开任何对标主页.*不要发布/);
  assert.equal(asked[0][1], true);
});

test('浏览器方式不是 WorkBuddy 插件：不发起任务，提示去选浏览器方式', async () => {
  const toasts = [];
  const fn = loadCheck({ S: { bridge: { mode: 'cli', browser: 'none' } }, ask: () => assert.fail('不应发起任务'), toast: (m) => toasts.push(m) });
  await fn();
  assert.match(toasts[0], /连接与设置.*WorkBuddy 浏览器插件/);
});

test('账号管理页的「在浏览器登录」直接调用核对，不再让用户去别的页面找按钮', () => {
  const app = read('app.js');
  const body = app.slice(app.indexOf('async function loginAccount'), app.indexOf('async function saveAccountForm'));
  assert.match(body, /benchmark\.checkLoginAccount\(\)/);
  assert.doesNotMatch(body, /再到「竞品对标」页点/);
});

test('竞品对标没有对标账号时，空状态里也有「先核对登录账号」按钮', () => {
  const i = bench.indexOf('<p>还没有对标账号。</p>');
  assert.ok(i > 0);
  const emptyCard = bench.slice(i, bench.indexOf('</div>`}`', i));
  assert.match(emptyCard, /data-act="prepare-browser"[^>]*>先核对登录账号</);
});
