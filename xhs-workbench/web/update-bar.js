// 新版本提示条：中枢上有更高版本时，顶栏下面显示「重启升级」。
// 为什么需要：员工电脑上已经在运行的工作台不会自己换版本，刷新网页看到的还是旧进程里的旧界面（接入器为了不打断任务只下载、不重启）。
// 没有任务在跑才能点；点了之后服务端停掉自己，由本机接入器下载并启动新版本，这里等新进程起来后刷新页面。
import { S, api, toast, showOverlay, confirmDialog, $ } from './core.js';
import { esc } from './md.js';

const RECHECK_MS = 10 * 60 * 1000;
let state = null;
let upgrading = false;

function dismissedKey(latest) { return `xhs-update-dismissed-${latest}`; }
function isDismissed(latest) { try { return sessionStorage.getItem(dismissedKey(latest)) === '1'; } catch { return false; } }

export function renderUpdateBar() {
  const bar = $('#update-bar');
  if (!bar) return;
  if (!state || !state.available || isDismissed(state.latest)) { bar.hidden = true; bar.innerHTML = ''; return; }
  const blocked = state.busy && !state.busy.ok;
  const hint = !state.canRestart
    ? '关闭工作台后，双击桌面上的「小红书运营工作台」打开即可升级。'
    : blocked ? state.busy.reason : '升级只需几秒钟，数据不会丢，升级前会自动备份。';
  bar.hidden = false;
  bar.innerHTML = `
    <span class="update-text"><strong>有新版本 v${esc(state.latest)}</strong>（当前 v${esc(state.current)}）<span class="muted"> ${esc(hint)}</span></span>
    <span class="update-actions">
      ${state.canRestart ? `<button class="btn primary small" data-update="restart"${blocked ? ' disabled' : ''}>重启升级</button>` : ''}
      <button class="btn ghost small" data-update="later">稍后</button>
    </span>`;
}

export async function checkUpdate(refresh = false) {
  if (upgrading) return;
  try { state = await api('GET', `/api/update${refresh ? '?refresh=1' : ''}`); } catch { return; }  // 查不到不打扰员工
  renderUpdateBar();
}

async function waitForNewVersion(from) {
  const started = Date.now();
  await new Promise((r) => setTimeout(r, 3000));  // 旧进程先退出，别把它当成「新版本起来了」
  while (Date.now() - started < 90_000) {
    try {
      const r = await fetch('/api/state', { headers: { 'X-Workbench-Token': S.token } });
      if (r.ok) {
        const s = await r.json();
        if (s.version && s.version !== from) return s.version;
      }
    } catch { /* 新进程还没起来 */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

async function restart() {
  if (!await confirmDialog({ title: `升级到 v${state.latest}？`, message: '工作台会重启几秒钟，正在编辑但没保存的内容会丢失，页面会自动刷新。', confirmLabel: '重启升级' })) return;
  const from = state.current;
  try { await api('POST', '/api/update/restart'); } catch (err) { toast(err.message); checkUpdate(true); return; }
  upgrading = true;
  showOverlay('<h3>正在升级工作台…</h3><p class="muted">下载并启动新版本，通常几秒到一分钟，完成后页面会自动刷新，请不要关闭这个页面。</p>');
  const to = await waitForNewVersion(from);
  if (to) { location.reload(); return; }
  showOverlay(`<h3>升级没有自动完成</h3><p>请关闭这个页面，双击桌面上的「小红书运营工作台」重新打开；仍然不行，把工作台数据目录下 logs/server.log 最后几行发给管理员。</p>`);
}

export function initUpdateBar() {
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-update]');
    if (!b) return;
    if (b.dataset.update === 'later') {
      try { sessionStorage.setItem(dismissedKey(state.latest), '1'); } catch { /* 无痕模式：本次页面内不再显示 */ state.available = false; }
      renderUpdateBar();
    } else if (b.dataset.update === 'restart') restart();
  });
  checkUpdate();
  setInterval(checkUpdate, RECHECK_MS);
  window.addEventListener('focus', () => checkUpdate());
}
