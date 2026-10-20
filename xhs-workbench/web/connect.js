// 首次连接：不用回到 agent，在网页里直接选本机已有的 agent。
// 命令行类（CLI 模式）由工作台直接调用；桌面类（收件箱模式）需要该 agent 的窗口保持打开并值守。
import { S, api, toast, showOverlay, withBusy } from './core.js';
import { esc } from './md.js';

const DUTY_PHRASE = '进入小红书工作台值守模式';
let hooks = { onChanged: async () => {}, send: () => {} };
let pending = '';

export function initConnect(h) {
  hooks = { ...hooks, ...h };
}

export function isConnected() {
  return !!(S.bridge && S.bridge.configured);
}

export async function detect() {
  if (S.detected && S.detectedDesktop) return;
  try {
    const r = await api('GET', '/api/bridge/detect');
    S.detected = r.adapters || [];
    S.detectedDesktop = r.desktop || [];
  } catch {
    S.detected = [];
    S.detectedDesktop = [];
  }
}

/** 选择 agent 的列表。inline=true 用于页面内卡片，false 用于弹窗 */
export function connectOptionsHtml() {
  const cli = S.detected || [];
  const desktop = S.detectedDesktop || [];
  if (!S.detected) return '<p class="muted">正在检测本机的 agent…</p>';
  const row = (name, note, attr, label) => `<div class="row" style="padding:10px 0;border-top:1px solid var(--line)">
      <div><strong>${esc(name)}</strong><div class="muted" style="font-size:13px">${esc(note)}</div></div>
      <div class="spacer"></div><button class="btn primary small" ${attr}>${esc(label)}</button></div>`;
  const rows = [
    ...cli.map((a) => row(a.name, '工作台直接调用它，不需要一直开着它的窗口', `data-quick-connect="cli:${esc(a.id)}"`, '使用它')),
    ...desktop.map((a) => row(a.name, '需要保持它的窗口打开，并让它在会话里值守接收任务', `data-quick-connect="host:${esc(a.id)}"`, '使用它')),
  ];
  const other = `<div class="row" style="padding:10px 0;border-top:1px solid var(--line)">
      <div><strong>其他 agent</strong><div class="muted" style="font-size:13px">你正在用的 agent 不在上面？选这个，再回到它的窗口让它值守</div></div>
      <div class="spacer"></div><button class="btn small" data-quick-connect="inbox:">选择</button></div>`;
  const none = rows.length ? '' : '<p class="muted">本机没有检测到常见的 agent。</p>';
  return `${none}${rows.join('')}${other}`;
}

export async function openConnectDialog(pendingText = '') {
  pending = pendingText;
  showOverlay('<h3>连接你的 agent</h3><p class="muted">正在检测本机的 agent…</p>');
  await detect();
  renderDialog();
}

function renderDialog() {
  showOverlay(`
    <div class="row"><h3 style="margin:0">连接你的 agent</h3><div class="spacer"></div><button class="btn small ghost" data-close-overlay>稍后再说</button></div>
    <p class="muted" style="font-size:13px">工作台里的对话和「让 agent …」类操作都由 agent 完成。下面是本机检测到的，选哪一个由你决定。${pending ? '<br>连接成功后会继续刚才的操作。' : ''}</p>
    ${connectOptionsHtml()}`);
}

function renderDone(name, inbox) {
  showOverlay(`
    <h3 style="margin-top:0">${name ? `已选择 ${esc(name)}` : '已设为收件箱模式'}</h3>
    ${inbox
      ? `<p>最后一步：回到${name ? ` <strong>${esc(name)}</strong> ` : '你正在用的 agent '}的窗口，发送下面这句话，让它开始值守：</p>
         <div class="row"><code style="padding:6px 10px;background:var(--brand-soft);border-radius:6px">${esc(DUTY_PHRASE)}</code><button class="btn small" data-copy-text="${esc(DUTY_PHRASE)}">复制</button></div>
         <p class="muted" style="font-size:13px">它值守期间窗口要一直开着；关掉后网页里的消息会排队，下次值守时继续处理。顶栏的状态会在它开始值守后变成绿色。</p>`
      : `<p>连接测试通过，现在可以直接在右侧和它对话了。</p>`}
    <div class="row" style="margin-top:12px"><button class="btn primary" data-connect-continue>${pending ? '继续刚才的操作' : '好的'}</button></div>`);
}

/** 处理本模块的点击；返回 true 表示已处理 */
export async function handleConnectClick(t) {
  if (t.dataset.openConnect !== undefined) {
    await openConnectDialog();
    return true;
  }
  if (t.dataset.copyText !== undefined) {
    try {
      await navigator.clipboard.writeText(t.dataset.copyText);
      toast('已复制');
    } catch {
      toast('复制失败，请手动选中文字复制');
    }
    return true;
  }
  if (t.dataset.connectContinue !== undefined) {
    $overlayClose();
    const text = pending;
    pending = '';
    if (text) hooks.send(text);
    return true;
  }
  if (t.dataset.quickConnect !== undefined) {
    const [kind, id] = t.dataset.quickConnect.split(':');
    if (kind === 'cli') {
      await withBusy(t, '测试连接中…（最长约 3 分钟）', async () => {
        const r = await api('PUT', '/api/bridge', { adapterId: id }).catch((err) => ({ ok: false, error: err.message }));
        if (!r.ok) return toast(`连接测试没通过：${r.error || '未知原因'}`);
        await hooks.onChanged();
        renderDone((S.detected.find((a) => a.id === id) || {}).name || id, false);
      });
    } else {
      const host = (S.detectedDesktop || []).find((a) => a.id === id);
      const body = id ? { mode: 'inbox', hostAgentId: id } : { mode: 'inbox' };
      await withBusy(t, '设置中…', async () => {
        await api('PUT', '/api/bridge', body).catch((err) => toast(err.message));
        await hooks.onChanged();
        renderDone(host ? host.name : '', true);
      });
    }
    return true;
  }
  return false;
}

function $overlayClose() {
  const el = document.querySelector('#overlay');
  if (el) el.hidden = true;
}
