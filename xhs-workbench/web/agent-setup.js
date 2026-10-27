// 「连接与设置」最上面的「执行 Agent 与浏览器」卡片：在网页里完成 CodeBuddy 登录检查、浏览器方式和权限档的设置，
// 不再需要在终端里运行 bridge-test / browser-setup / browser-mode。
import { api, toast, confirmDialog } from './core.js';
import { esc } from './md.js';
import { icon } from './icons.js';

const ENGINES = [
  { id: 'workbuddy', name: '我自己的 Edge（WorkBuddy 插件，推荐）', note: '小红书采集只走这一种：在你日常用的 Edge 里读页面，沿用里面的登录；需要 WorkBuddy 的「浏览器操控」和 Edge 扩展，先在 Edge 里登录小红书。所有工作台账号共用这一个浏览器。' },
  { id: 'playwright', name: '工作台独立浏览器（不能用于小红书采集）', note: '工作台自己开一个 Edge / Chrome 给 agent 用。它带自动化特征，所以小红书的采集和登录核对不会用它，只适合不访问小红书的网页任务。' },
  { id: 'none', name: '不用浏览器', note: '只做选题、文案、复盘等不需要打开网页的工作。' },
];

let state = { data: null, busy: '', message: '' };

export async function mountAgentSetup(root) {
  if (!root) return;
  const current = () => root.isConnected;
  const load = async () => {
    try { state.data = await api('GET', '/api/agent-setup'); } catch (e) { state.message = e.message; }
    if (current()) draw();
  };

  // 登录完还是显示没登录：CodeBuddy 的登录凭据和 WorkBuddy 桌面共用一份存储，出过「读不出 / 写不进」的情况（日志里是 missing-key、safe-delete）
  const loginHelp = () => `<details style="margin-top:6px"><summary class="muted" style="cursor:pointer">登录完还是显示没登录？</summary>
    <ol class="muted" style="margin:6px 0 0 18px;padding:0;font-size:13px;line-height:1.7">
      <li>关掉 WorkBuddy 桌面和所有 codebuddy 窗口。</li>
      <li>按 <b>Win+R</b>，输入 <code>cmd</code> 回车——用自己打开的窗口，不要从 WorkBuddy 或工作台里开。</li>
      <li>输入 <code>codebuddy</code> 回车，再输入 <code>/login</code>，在浏览器里完成授权，然后输入 <code>/exit</code>。</li>
      <li>还不行：把文件夹 <code>%LOCALAPPDATA%\\CodeBuddyExtension\\Data\\Public\\auth</code> 改名（后面加 <code>.bak</code>，不要删），再做第 2、3 步。<b>它和 WorkBuddy 桌面共用，改名后 WorkBuddy 也要重新登录一次。</b></li>
      <li>回到这里点「重新检查」。</li>
    </ol></details>`;

  function codebuddyRow(c) {
    if (!c) return '';
    if (!c.installed) return `${icon('warning', 'icon-warn')} 本机没有检测到 CodeBuddy CLI。请重新运行中枢的接入命令（询问时选择安装），装好后点「重新检查」。`;
    if (c.checking || state.busy === 'check') return '正在检查 CodeBuddy 能不能用…（最长约 2 分钟）';
    if (c.ok) return `${icon('check', 'icon-ok')} 已登录，可以使用<span class="muted">（${esc(c.command)}）</span>`;
    if (c.needsLogin) return `${icon('warning', 'icon-warn')} <b>还没登录</b>：点「去登录」，在弹出的窗口里输入 <code>/login</code> 登录你的 CodeBuddy 账号${loginHelp()}`;
    if (c.ok === false) return `${icon('warning', 'icon-warn')} 连接测试没通过：<span class="muted">${esc(c.error)}</span>${loginHelp()}`;
    return '还没检查过';
  }

  function draw() {
    const d = state.data;
    const c = d?.codebuddy;
    const b = d?.browser;
    const busy = !!state.busy;
    root.innerHTML = `
      <h3 style="margin-top:0">${icon('plug')} 执行 Agent 与浏览器</h3>
      <p class="muted" style="margin-top:-4px">网页里的对话和任务都由 CodeBuddy CLI 执行；WorkBuddy 等桌面 agent 可以继续用，但不负责执行工作台的任务。</p>
      <dl class="kv">
        <dt>CodeBuddy</dt><dd>${d ? codebuddyRow(c) : '加载中…'}</dd>
      </dl>
      <div class="row" style="margin:8px 0 14px">
        ${c?.installed && (c.needsLogin || c.ok === false) ? `<button class="btn primary small" data-setup="login" ${busy ? 'disabled' : ''}>去登录</button>` : ''}
        ${c?.installed ? `<button class="btn small" data-setup="check" ${busy ? 'disabled' : ''}>重新检查</button>` : ''}
      </div>
      <div class="muted" style="margin-bottom:6px">浏览器方式（对标核实、看主页等需要打开网页的工作）</div>
      ${b && b.current === null ? '<p class="muted">先连接 CodeBuddy（命令行模式）后才能选择。</p>' : ''}
      ${b && b.current !== null ? ENGINES.map((e) => {
        const on = b.current === e.id || (e.id === 'none' && !b.current);
        const unavailable = e.id === 'workbuddy' && !b.workbuddyPlugin;
        return `<div class="row" style="padding:8px 0;border-top:1px solid var(--line);align-items:flex-start">
          <div style="flex:1"><strong>${esc(e.name)}</strong>${on ? ' <span class="badge brand">当前</span>' : ''}
            <div class="muted" style="font-size:13px">${esc(e.note)}${unavailable ? '<br>没有找到 WorkBuddy 浏览器插件：在 WorkBuddy「设置 > 智能体 > 浏览器操控」打开「让 WorkBuddy 控制浏览器」并安装 Edge 扩展。' : ''}</div></div>
          ${on ? '' : `<button class="btn small" data-engine="${e.id}" ${busy || unavailable ? 'disabled' : ''}>${state.busy === 'engine:' + e.id ? '切换中…' : '用这个'}</button>`}
        </div>`;
      }).join('') : ''}
      ${b && ['playwright', 'workbuddy'].includes(b.current) ? `
        <div class="row" style="padding:10px 0 0;border-top:1px solid var(--line)">
          <div style="flex:1"><strong>权限档：${b.browserMode === 'test' ? '测试档' : '只读档'}</strong>
            <div class="muted" style="font-size:13px">${b.browserMode === 'test'
              ? '测试档能点击、输入，用来验证采集能力；仍不能执行脚本、不会关你的标签页。测完请切回只读档。'
              : '只读档只能看：打开网页、滚动、截图、读页面；不能点击、输入，所以不会点赞、评论、关注、私信或发布。'}</div></div>
          <button class="btn small" data-mode="${b.browserMode === 'test' ? 'readonly' : 'test'}" ${busy ? 'disabled' : ''}>${b.browserMode === 'test' ? '切回只读档' : '切到测试档'}</button>
        </div>` : ''}
      ${state.message ? `<p class="muted" role="status" style="margin-top:10px">${esc(state.message)}</p>` : ''}`;
  }

  root.onclick = async (ev) => {
    const t = ev.target.closest('button');
    if (!t || state.busy) return;
    try {
      if (t.dataset.setup === 'check') {
        state.busy = 'check'; state.message = ''; draw();
        state.data.codebuddy = await api('POST', '/api/codebuddy/check');
      } else if (t.dataset.setup === 'login') {
        const r = await api('POST', '/api/codebuddy/login');
        state.message = r.hint;
      } else if (t.dataset.engine) {
        const e = t.dataset.engine;
        state.busy = 'engine:' + e; state.message = '正在用新的浏览器方式测试连接（最长约 3 分钟），通过后才会切换…'; draw();
        await api('POST', '/api/bridge/browser', { engine: e });
        state.message = e === 'workbuddy' ? '已切换到你自己的 Edge。用之前请先在 Edge 里登录要运营的小红书账号。' : '已切换。';
        toast('浏览器方式已切换');
      } else if (t.dataset.mode) {
        const mode = t.dataset.mode;
        let confirmed = false;
        if (mode === 'test') {
          confirmed = await confirmDialog({ title: '切到测试档？', message: '测试档下 agent 能在浏览器里点击和输入（仍不能执行脚本、不能关你的标签页）。只在需要验证采集能力时用，测完请切回只读档。工作台不会自动发布，但测试档的这条保证主要靠规则和你在场。', confirmLabel: '切到测试档', danger: true });
          if (!confirmed) return;
        }
        state.busy = 'mode'; draw();
        await api('POST', '/api/bridge/browser-mode', { mode, confirmed });
        state.message = mode === 'test' ? '已切到测试档。测完记得切回只读档。' : '已切回只读档。';
      }
    } catch (err) {
      state.message = err.message;
      toast(err.message);
    } finally {
      state.busy = '';
      await load();
    }
  };

  draw();
  await load();
}
