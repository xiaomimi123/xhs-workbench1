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
