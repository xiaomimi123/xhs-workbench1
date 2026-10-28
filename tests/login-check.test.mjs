// 「在浏览器登录」提示曾让用户去竞品对标页点「先核对登录账号」，但没有对标账号时那个按钮根本不显示（新用户必然卡住）。
// 现在：账号管理页直接发起核对；竞品对标的空状态里也有这个按钮。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../xhs-workbench/web/app.js', import.meta.url), 'utf8');

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
  const fn = loadCheck({ S: { accountId: 'acc_1', bridge: { mode: 'cli', browser: 'workbuddy' } }, accDirRel: () => 'accounts/acc_1', ask: (text, flag) => { asked.push([text, flag]); }, toast: () => assert.fail('不应弹提示') });
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

test('核对提示词：结果写进 browser.json，已登录时再只读自己的主页写 profile-suggestion.json，且只许写这两个文件', async () => {
  const asked = [];
  const fn = loadCheck({ S: { accountId: 'acc_1', bridge: { mode: 'cli', browser: 'workbuddy' } }, accDirRel: () => 'accounts/acc_1', ask: (t) => asked.push(t), toast: () => {} });
  await fn();
  assert.match(asked[0], /accounts\/acc_1\/browser\.json/);
  assert.match(asked[0], /playbooks\/browser\.md/);
  for (const k of ['loggedIn', 'nickname', 'xhsId', 'checkedAt']) assert.ok(asked[0].includes(k), k);
  assert.match(asked[0], /除这两个文件外不要写别的文件/);
  // 第二步：已登录时只读自己的主页，写 profile-suggestion.json（定位 / 人群 / 风格）
  assert.match(asked[0], /accounts\/acc_1\/profile-suggestion\.json/);
  assert.match(asked[0], /登录后分析自己的账号/);
  for (const k of ['positioning', 'audience', 'style']) assert.ok(asked[0].includes(k), k);
  assert.match(asked[0], /不点开任何笔记详情、不翻页/);
  assert.match(asked[0], /不要编造/);
  assert.match(asked[0], /没登录就跳过这一步/);
});

function loadFill(accounts, apiImpl) {
  const start = app.indexOf('async function fillXhsId(id)');
  const end = app.indexOf('async function saveAccountForm(form)');
  const calls = { api: [], toast: [], refreshed: 0, viewed: 0 };
  const ctx = vm.createContext({ S: { accounts: { accounts } }, api: async (...a) => { calls.api.push(a); return apiImpl?.(...a); }, toast: (m) => calls.toast.push(m),
    refreshAccounts: async () => { calls.refreshed++; }, viewAccounts: () => { calls.viewed++; } });
  const fn = vm.runInContext(app.slice(start, end) + '\nfillXhsId', ctx);
  return { fn, calls };
}

test('一键填入：账号没填号且上次核对已登录 → 只提交 id 和读到的小红书号', async () => {
  const { fn, calls } = loadFill([{ id: 'a1', xhsId: '', browser: { loggedIn: true, xhsId: 'become5858' } }]);
  await fn('a1');
  assert.equal(JSON.stringify(calls.api), JSON.stringify([['POST', '/api/accounts', { id: 'a1', xhsId: 'become5858' }]]));
  assert.equal(calls.refreshed, 1);
});

test('一键填入：已经填了号、或上次未登录、或没读到号，都不提交（不覆盖用户填的号）', async () => {
  for (const acc of [{ id: 'a1', xhsId: 'mine', browser: { loggedIn: true, xhsId: 'other' } }, { id: 'a1', xhsId: '', browser: { loggedIn: false, xhsId: 'x' } }, { id: 'a1', xhsId: '', browser: { loggedIn: true, xhsId: '' } }, { id: 'a1', xhsId: '' }]) {
    const { fn, calls } = loadFill([acc]);
    await fn('a1');
    assert.equal(calls.api.length, 0, JSON.stringify(acc));
  }
});

test('账号页只在「已登录、读到号、账号没填号」时显示一键填入按钮', () => {
  const line = app.slice(app.indexOf('function browserLine(a)'), app.indexOf('async function loginAccount'));
  assert.match(line, /b\.loggedIn && b\.xhsId && !a\.xhsId/);
  assert.match(line, /data-fill-xhsid=/);
  assert.match(app, /if \(t\.dataset\.fillXhsid\) return fillXhsId/);
});
