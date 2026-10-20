// 站内确认框：可访问性属性、键盘行为、危险操作默认焦点；备份文件名的用户语言
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const load = (rel) => fs.readFileSync(new URL(`../xhs-workbench/web/${rel}`, import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/export /g, '');

function fakeDom() {
  const listeners = { document: {}, wrap: {} };
  const buttons = { yes: { focused: 0, dataset: { confirm: 'yes' }, focus() { dom.document.activeElement = this; } }, no: { dataset: { confirm: 'no' }, focus() { dom.document.activeElement = this; } } };
  const wrap = {
    className: '', style: {}, innerHTML: '', removed: false,
    addEventListener: (t, f) => { listeners.wrap[t] = f; },
    remove() { this.removed = true; },
    closest: () => null,
    querySelector: (sel) => (sel.includes('"yes"') ? buttons.yes : buttons.no),
    querySelectorAll: () => [buttons.no, buttons.yes],
  };
  const trigger = { focus() { dom.document.activeElement = this; } };
  const dom = {
    listeners, buttons, wrap, trigger,
    document: {
      activeElement: trigger,
      createElement: () => wrap,
      body: { appendChild: () => {} },
      addEventListener: (t, f) => { listeners.document[t] = f; },
      removeEventListener: (t) => { delete listeners.document[t]; },
    },
  };
  return dom;
}
function setup() {
  const dom = fakeDom();
  const ctx = vm.createContext({ document: dom.document, esc: (x) => String(x ?? '').replace(/</g, '&lt;') });
  vm.runInContext(load('core.js').replace(/export /g, ''), ctx);
  return { dom, confirmDialog: (o) => vm.runInContext('confirmDialog', ctx)(o), confirmLeave: (w) => vm.runInContext('confirmLeave', ctx)(w) };
}
const key = (dom, k, extra = {}) => dom.listeners.document.keydown({ key: k, preventDefault() {}, stopPropagation() {}, ...extra });
const click = (dom, target) => dom.listeners.wrap.click({ target: { closest: () => (target.dataset ? target : null), ...(target === dom.wrap ? {} : {}) } });

test('对话框声明 alertdialog/aria-modal 并关联标题与说明；文案被转义', async () => {
  const { dom, confirmDialog } = setup();
  const p = confirmDialog({ title: '删除<b>?', message: '会移到回收站', confirmLabel: '删除' });
  assert.match(dom.wrap.innerHTML, /role="alertdialog"/);
  assert.match(dom.wrap.innerHTML, /aria-modal="true"/);
  assert.match(dom.wrap.innerHTML, /aria-labelledby="(confirm-\d+)-t"[\s\S]*id="\1-t"/);
  assert.match(dom.wrap.innerHTML, /删除&lt;b>\?/); // 标题里的 HTML 被转义
  click(dom, dom.buttons.no);
  assert.equal(await p, false);
});

test('普通确认默认聚焦“确定”；危险操作默认聚焦“取消”，避免回车误删', async () => {
  const a = setup();
  const p1 = a.confirmDialog({ title: 't' });
  assert.equal(a.dom.document.activeElement, a.dom.buttons.yes);
  click(a.dom, a.dom.buttons.yes);
  assert.equal(await p1, true);
  const b = setup();
  const p2 = b.confirmDialog({ title: 't', danger: true });
  assert.equal(b.dom.document.activeElement, b.dom.buttons.no);
  assert.match(b.dom.wrap.innerHTML, /class="btn danger" data-confirm="yes"/);
  click(b.dom, b.dom.buttons.no);
  assert.equal(await p2, false);
});

test('Esc 取消；点遮罩取消；关闭后移除节点、撤销键盘监听并把焦点还给原元素', async () => {
  const { dom, confirmDialog } = setup();
  let p = confirmDialog({ title: 't' });
  assert.ok(dom.listeners.document.keydown);
  key(dom, 'Escape');
  assert.equal(await p, false);
  assert.equal(dom.wrap.removed, true);
  assert.equal(dom.listeners.document.keydown, undefined);
  assert.equal(dom.document.activeElement, dom.trigger);
  dom.wrap.removed = false;
  p = confirmDialog({ title: 't' });
  dom.listeners.wrap.click({ target: { closest: () => null } }); // 点在对话框内的空白处：不关闭
  assert.equal(dom.wrap.removed, false);
  dom.listeners.wrap.click({ target: dom.wrap }); // 点遮罩本身：取消
  assert.equal(await p, false);
  assert.equal(dom.wrap.removed, true);
});

test('Tab 在对话框内循环，不会跳到背后的页面', async () => {
  const { dom, confirmDialog } = setup();
  const p = confirmDialog({ title: 't' });
  assert.equal(dom.document.activeElement, dom.buttons.yes);
  key(dom, 'Tab');
  assert.equal(dom.document.activeElement, dom.buttons.no);
  key(dom, 'Tab');
  assert.equal(dom.document.activeElement, dom.buttons.yes);
  key(dom, 'Tab', { shiftKey: true });
  assert.equal(dom.document.activeElement, dom.buttons.no);
  key(dom, 'Escape');
  await p;
});

test('离开确认：统一标题与按钮，默认焦点在“继续编辑”', async () => {
  const { dom, confirmLeave } = setup();
  const p = confirmLeave('这篇笔记');
  assert.match(dom.wrap.innerHTML, /有未保存的修改/);
  assert.match(dom.wrap.innerHTML, /这篇笔记还没有保存，离开后这些修改会丢失/);
  assert.match(dom.wrap.innerHTML, /继续编辑/);
  assert.match(dom.wrap.innerHTML, /不保存，离开/);
  assert.equal(dom.document.activeElement, dom.buttons.no);
  click(dom, dom.buttons.yes);
  assert.equal(await p, true);
});

test('备份文件名显示成用户能看懂的名称', () => {
  const ctx = vm.createContext({ esc: String });
  vm.runInContext(load('modules/system.js').replace(/^const KEEP_AWAKE[\s\S]*?\];/m, ''), ctx);
  const label = (n) => JSON.parse(JSON.stringify(vm.runInContext('backupLabel', ctx)(n)));
  assert.deepEqual(label('auto-20261020-113008.zip'), { title: '每日自动备份', note: '' });
  assert.deepEqual(label('backup-20261020-113008.zip'), { title: '手动备份', note: '' });
  assert.deepEqual(label('upgrade-legacy-20261020-152928.zip'), { title: '升级前自动备份', note: '首次登记版本时' });
  assert.deepEqual(label('upgrade-pre-20261020-153011.zip'), { title: '升级前自动备份', note: '升级命令执行前' });
  assert.deepEqual(label('upgrade-20261020-153011.zip'), { title: '升级前自动备份', note: '' });
  assert.deepEqual(label('weird.zip'), { title: 'weird.zip', note: '' });
});
