// 前端公共核心：全局状态、接口调用、通用小工具。各功能模块都从这里取。
import { esc } from './md.js';

export const S = {
  token: '',
  info: null,
  accounts: { accounts: [], defaultAccountId: null },
  accountId: null,
  bridge: null,
  view: 'overview',
  sessions: [],
  session: null,
  kb: { docs: [], folders: [], current: null, editing: false, dirty: false, query: '', results: null },
  detected: null,
  alerts: [],
};

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': S.token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    showOverlay('<h3>需要重新打开工作台</h3><p class="muted">访问令牌无效。请回到你的 agent，说「打开小红书工作台」，用它给出的链接重新打开。</p>');
    throw new Error(data.error);
  }
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

// 当前账号的接口查询串
export function acc(extra = '') {
  return `account=${encodeURIComponent(S.accountId)}${extra ? `&${extra}` : ''}`;
}

// 账号目录下文件的图片地址（<img> 无法带请求头，令牌放查询串）
export function fileUrl(rel, bust = '') {
  return `/api/files?${acc(`path=${encodeURIComponent(rel)}`)}&t=${encodeURIComponent(S.token)}${bust ? `&v=${encodeURIComponent(bust)}` : ''}`;
}

export function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 2600);
}

export function showOverlay(html) {
  const el = $('#overlay');
  el.innerHTML = `<div class="card">${html}</div>`;
  el.hidden = false;
}

/**
 * 站内确认框，替代浏览器自带的 confirm()：文案统一、不会被浏览器静默拦截、可用键盘操作。
 * 返回 Promise<boolean>。danger=true 时默认焦点落在“取消”，避免回车误删。
 * 不依赖 #overlay，所以不会盖掉已经打开的弹窗。
 */
export function confirmDialog({ title = '确认一下', message = '', confirmLabel = '确定', cancelLabel = '取消', danger = false } = {}) {
  if (typeof document === 'undefined') return Promise.resolve(false);
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const wrap = document.createElement('div');
    wrap.className = 'overlay confirm-overlay';
    wrap.style.zIndex = '60';
    const id = `confirm-${Date.now()}`;
    wrap.innerHTML = `<div class="card confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="${id}-t" aria-describedby="${id}-m">
      <h3 id="${id}-t" style="margin-top:0">${esc(title)}</h3>
      <p id="${id}-m" style="white-space:pre-line">${esc(message)}</p>
      <div class="row" style="justify-content:flex-end;gap:8px;margin-top:12px">
        <button class="btn" data-confirm="no">${esc(cancelLabel)}</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-confirm="yes">${esc(confirmLabel)}</button></div></div>`;
    const finish = (value) => {
      document.removeEventListener('keydown', onKey, true);
      wrap.remove();
      try { previous?.focus?.(); } catch { /* 元素已不在页面上 */ }
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); return; }
      if (e.key === 'Tab') { // 焦点留在对话框内
        const items = [...wrap.querySelectorAll('button')];
        const i = items.indexOf(document.activeElement);
        e.preventDefault();
        items[(i + (e.shiftKey ? items.length - 1 : 1)) % items.length].focus();
      }
    };
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('[data-confirm]');
      if (b) finish(b.dataset.confirm === 'yes');
      else if (e.target === wrap) finish(false);
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(wrap);
    wrap.querySelector(danger ? '[data-confirm="no"]' : '[data-confirm="yes"]').focus();
  });
}

/** 有未保存修改时离开当前内容的统一确认 */
export function confirmLeave(what) {
  return confirmDialog({ title: '有未保存的修改', message: `${what}还没有保存，离开后这些修改会丢失。`, confirmLabel: '不保存，离开', cancelLabel: '继续编辑', danger: true });
}

export function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function currentAccount() {
  return S.accounts.accounts.find((a) => a.id === S.accountId) || S.accounts.accounts[0];
}

export async function withBusy(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    await fn();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

export function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function opt(value, label, selected) {
  return `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`;
}

// ---------- 和 agent 对话的入口（由 app.js 注入实现） ----------

const hooks = { send: null, fill: null, go: null };
export function setHooks(h) {
  Object.assign(hooks, h);
}

/** 让 agent 做事：send=true 直接发送，否则填进输入框让用户补充 */
export function ask(text, send = false, options = {}) {
  return send ? hooks.send(text, options) : hooks.fill(text);
}

export function go(view, params) {
  return hooks.go(view, params);
}

// 当前账号数据目录（相对数据目录），用于写进给 agent 的提示词
export function accDirRel() {
  return `accounts/${S.accountId}`;
}
