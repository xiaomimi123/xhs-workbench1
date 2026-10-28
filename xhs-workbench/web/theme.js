// 页面配色：跟随系统（默认）/ 浅色 / 深色。选择存 localStorage（xhs-theme，只有 light / dark 两个值，没有值=跟随系统），
// 通过 <html data-theme> 生效；index.html 头部有一小段同样的读取，避免刷新时闪屏。
import { icon } from './icons.js';

const MODES = [
  { id: 'auto', name: '跟随系统', icon: 'monitor' },
  { id: 'light', name: '浅色', icon: 'sun' },
  { id: 'dark', name: '深色', icon: 'moon' },
];

export function getTheme() {
  try {
    const t = localStorage.getItem('xhs-theme');
    return t === 'light' || t === 'dark' ? t : 'auto';
  } catch { return 'auto'; }
}

export function setTheme(mode) {
  if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode;
  else delete document.documentElement.dataset.theme;
  try {
    if (mode === 'light' || mode === 'dark') localStorage.setItem('xhs-theme', mode);
    else localStorage.removeItem('xhs-theme');
  } catch { /* 无痕模式：本次有效，刷新后回到跟随系统 */ }
  renderThemeSwitch();
  document.querySelectorAll('[data-theme-seg]').forEach(renderSeg);
}

function current() { return MODES.find((m) => m.id === getTheme()); }

// 顶栏：图标按钮 + 下拉
function renderThemeSwitch(open = false) {
  const host = document.getElementById('theme-switch');
  if (!host) return;
  const cur = current();
  host.innerHTML = `
    <button class="icon-btn" id="theme-btn" title="页面配色：${cur.name}" aria-label="页面配色" aria-haspopup="menu" aria-expanded="${open}">${icon(cur.id === 'auto' ? 'monitor' : cur.icon)}</button>
    ${open ? `<div class="theme-menu" role="menu">${MODES.map((m) => `
      <button class="theme-opt${m.id === cur.id ? ' active' : ''}" role="menuitemradio" aria-checked="${m.id === cur.id}" data-theme-mode="${m.id}">${icon(m.icon)}<span>${m.name}</span>${m.id === cur.id ? `<span class="tick">${icon('check')}</span>` : ''}</button>`).join('')}</div>` : ''}`;
}

// 设置页「外观」卡片里的分段选择
function renderSeg(el) {
  const cur = getTheme();
  el.innerHTML = MODES.map((m) => `<button type="button" class="${m.id === cur ? 'active' : ''}" data-theme-mode="${m.id}" aria-pressed="${m.id === cur}">${icon(m.icon)}${m.name}</button>`).join('');
}

export function appearanceCardHtml() {
  return `<div class="card" style="max-width:760px;margin-bottom:16px">
    <h3 style="margin-top:0">外观</h3>
    <div class="row">
      <span class="muted">页面配色</span>
      <div class="theme-seg" data-theme-seg></div>
    </div>
    <p class="muted" style="margin:8px 0 0;font-size:13px">「跟随系统」会随电脑的深色 / 浅色模式自动切换；这个选择只保存在当前浏览器里。</p>
  </div>`;
}

export function mountAppearance(root) {
  root.querySelectorAll('[data-theme-seg]').forEach(renderSeg);
}

export function initTheme() {
  renderThemeSwitch();
  document.addEventListener('click', (e) => {
    const opt = e.target.closest('[data-theme-mode]');
    if (opt) { setTheme(opt.dataset.themeMode); return; }
    if (e.target.closest('#theme-btn')) {
      const open = !document.querySelector('#theme-switch .theme-menu');
      renderThemeSwitch(open);
      return;
    }
    if (document.querySelector('#theme-switch .theme-menu')) renderThemeSwitch(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.querySelector('#theme-switch .theme-menu')) {
      renderThemeSwitch(false);
      document.getElementById('theme-btn')?.focus();
    }
  });
}
