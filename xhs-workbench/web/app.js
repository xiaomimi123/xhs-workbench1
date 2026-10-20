import * as video from './modules/video-creation.js';
import {mountVideoSettings} from './video-service-settings.js';
import {mountImageServiceSettings} from './image-service-settings.js';
import { md, esc, stripFrontmatter } from './md.js';
import { S, $, api, acc, toast, showOverlay, fmtTime, currentAccount, withBusy, setHooks } from './core.js';
import * as benchmark from './modules/benchmark.js';
import * as topics from './modules/topics.js';
import * as copywriting from './modules/copywriting.js';
import * as cover from './modules/image-creation.js';
import * as schedule from './modules/schedule.js';
import * as engage from './modules/engage.js';
import * as analytics from './modules/analytics.js';
import { renderSystem } from './modules/system.js';
import * as materials from './modules/materials.js';
import { icon } from './icons.js';
import * as onboarding from './modules/onboarding.js';

// ---------- 模块定义 ----------

const MODULES = [
  { group: '工作台' },
  { id: 'overview', icon: 'home', name: '概览' },
  { id: 'knowledge', icon: 'book', name: '知识库' },
  { group: '内容生产' },
  { id: 'benchmark', icon: 'target', name: '竞品对标', module: benchmark },
  { id: 'topics', icon: 'flame', name: '选题热点', module: topics },
  { id: 'copywriting', icon: 'pen', name: '文案', module: copywriting },
  { id: 'cover', icon: 'palette', name: '图片创作', module: cover },
  { id: 'video', icon: 'video', name: '视频创作', module: video },
  { id: 'materials', icon: 'folder', name: '素材库', module: materials },
  { group: '运营' },
  { id: 'schedule', icon: 'calendar', name: '发布排期', module: schedule },
  { id: 'engage', icon: 'chat', name: '评论私信', module: engage },
  { id: 'analytics', icon: 'chart', name: '数据复盘', module: analytics },
  { group: '设置' },
  { id: 'accounts', icon: 'user', name: '账号管理' },
  { id: 'settings', icon: 'plug', name: '连接与设置' },
];

// ---------- 网络 ----------

function initTopbarIcons() {
  document.querySelectorAll('.icon-slot[data-icon]').forEach((el) => (el.outerHTML = icon(el.dataset.icon)));
}

function initToken() {
  const url = new URL(location.href);
  const t = url.searchParams.get('t');
  if (t) {
    try { localStorage.setItem('xhs-token', t); } catch { /* 无痕模式 */ }
    url.searchParams.delete('t');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    return t;
  }
  try { return localStorage.getItem('xhs-token') || ''; } catch { return ''; }
}

// ---------- 实时事件 ----------

function connectEvents() {
  const es = new EventSource(`/api/events?t=${encodeURIComponent(S.token)}`);
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    switch (ev.type) {
      case 'hello':
        S.bridge = ev.bridge;
        renderBridge();
        break;
      case 'bridge.changed':
      case 'browser.changed':
      case 'config.changed':
        refreshBridge();
        if (ev.type === 'config.changed') refreshAccounts();
        break;
      case 'accounts.changed':
        refreshAccounts();
        break;
      case 'knowledge.changed':
        refreshKnowledge();
        break;
      case 'chats.changed':
        refreshSessions();
        break;
      case 'alert':
        onAlert(ev);
        break;
      case 'restored':
        toast('数据已恢复，正在刷新…');
        setTimeout(() => location.reload(), 800);
        break;
      case 'content.changed':
        if (['schedule', 'engage', 'benchmarks'].includes(ev.area)) refreshAlerts();
        if (ev.area === 'browser') refreshAccounts();
        if (ev.account !== S.accountId) break;
        cover.autoRender(ev);
        for (const m of MODULES) if (m.module && m.id === S.view && m.module.onContent) m.module.onContent(ev);
        break;
      case 'chat.delta':
      case 'chat.tool':
      case 'chat.status':
      case 'chat.done':
        onChatEvent(ev);
        break;
    }
  };
  es.onerror = () => {
    S.bridge = null;
    renderBridge('工作台已断开');
  };
}

// ---------- 导航 ----------

function renderNav() {
  $('#sidebar').innerHTML = MODULES.map((m) =>
    m.group
      ? `<div class="nav-group">${esc(m.group)}</div>`
      : `<button class="nav-item${S.view === m.id ? ' active' : ''}" data-nav="${m.id}"><span>${icon(m.icon)}</span><span>${esc(m.name)}</span>${m.stage ? `<span class="tag">${m.stage}</span>` : ''}</button>`,
  ).join('');
}

function go(view, params) {
  if (S.view === 'knowledge' && S.kb.dirty && !confirm('当前文档有未保存的修改，确定离开吗？')) return;
  const cur = MODULES.find((m) => m.id === S.view);
  if (cur && cur.module && cur.module.canLeave && !cur.module.canLeave()) return;
  S.kb.dirty = false;
  S.view = view;
  S.params = params || {};
  try { localStorage.setItem('xhs-view', view); } catch { /* 忽略 */ }
  document.body.classList.remove('nav-open');
  renderNav();
  renderMain();
}

function renderMain() {
  const views = { overview: viewOverview, knowledge: viewKnowledge, accounts: viewAccounts, settings: viewSettings };
  const mod = MODULES.find((m) => m.id === S.view);
  if (!mod) return go('overview');
  const main = $('#main');
  main.onclick = null; // 模块各自绑定的处理函数，切换页面时清掉
  main.oninput = null;
  main.onchange = null;
  main.onsubmit = null;
  main.onfocusout = null;
  if (mod.module) return mod.module.render(main, S.params || {});
  (views[S.view] || viewModule)(mod);
}

// ---------- 概览 ----------

function viewOverview() {
  const acc = currentAccount();
  const needProfile = acc && !acc.positioning;
  const quick = [
    needProfile && { title: '① 建立账号定位', text: '和 agent 聊聊你的账号，它会帮你梳理定位、人群和风格，并写进知识库。', prompt: '请帮我建立账号定位：先问我几个关键问题（一次一个），最后把结论整理成知识库文档，并更新账号管理里的定位信息。' },
    { title: '整理知识库', text: '让 agent 检查知识库结构，补全缺失的基础文档。', prompt: '请阅读知识库现有文档，告诉我还缺哪些基础内容，并帮我补上第一篇。' },
    { title: '沉淀一条经验', text: '把你的运营经验口述给 agent，它会整理成规范的知识文档。', prompt: '我想沉淀一条运营经验到知识库：' },
    { title: '找对标账号', text: '让 agent 根据你的定位推荐值得学习的对标账号。', prompt: '请根据我的账号定位，帮我找 5 个值得对标的小红书账号，说明理由，并记录到知识库的对标拆解目录。' },
  ].filter(Boolean);

  $('#main').innerHTML = `
    <h1 class="page-title">你好，${esc(acc ? acc.name : '')} 👋</h1>
    <p class="page-sub">在右侧和你的 agent 对话，或者点下面的卡片快速开始。<button class="btn small ghost" data-onboard style="margin-left:8px">${icon("rocket")} 新手引导</button></p>
    <div class="grid">
      ${quick.map((q) => `<div class="card quick-card" data-prompt="${esc(q.prompt)}"><h3>${esc(q.title)}</h3><p>${esc(q.text)}</p></div>`).join('')}
    </div>
    ${alertsHtml()}
    <h3 style="margin-top:28px">运营流水线</h3>
    <div class="pipeline">
      ${PIPELINE.map(([id, text], i) => {
        const m = MODULES.find((x) => x.id === id);
        return `<div class="card quick-card" data-nav="${id}"><div class="muted">第 ${i + 1} 步</div><h3>${icon(m.icon)} ${esc(m.name)}</h3><p>${esc(text)}</p></div>`;
      }).join('')}
    </div>`;
}

const PIPELINE = [
  ['benchmark', '找到值得学的账号，让 agent 拆出爆款规律'],
  ['topics', '结合热点和拆解结果出选题，按分数挑'],
  ['copywriting', '一键写成笔记，检查违禁词、预览效果'],
  ['cover', '自由生图、参考图复刻或根据文案配图'],
  ['schedule', '安排发布时间，到点提醒你手动发布'],
  ['engage', '起草评论私信回复，确认后发送'],
  ['analytics', '抓数据、写复盘，结论回流知识库'],
];

// ---------- 提醒 ----------

function alertsHtml() {
  if (!S.alerts.length) return '';
  return `<div class="card alerts-card" style="margin-top:20px">
    <h3 style="margin-top:0">${icon("bell")} 需要你处理</h3>
    ${alertListHtml()}
  </div>`;
}

function alertListHtml() {
  const multi = S.accounts.accounts.length > 1;
  const kindName = { publish: '发布', engage: '互动', radar: '对标' };
  return `<ul class="alert-list">${S.alerts
    .map((a, i) => `<li><button class="alert-item" data-alert="${i}"><span class="badge ${a.status === 'failed' || a.status === 'missed' ? 'bad' : 'warn'}">${kindName[a.kind] || '提醒'}</span>
      ${multi ? `<span class="muted">[${esc(a.accountName)}]</span>` : ''} ${a.title ? `<strong>${esc(a.title)}</strong>` : ''} ${esc(a.text)}</button></li>`)
    .join('')}</ul>`;
}

async function refreshAlerts() {
  try {
    S.alerts = (await api('GET', '/api/alerts')).items;
  } catch {
    return;
  }
  const btn = $('#alerts-btn');
  btn.querySelector('.count').textContent = S.alerts.length || '';
  btn.classList.toggle('has', S.alerts.length > 0);
  if (S.view === 'overview') viewOverview();
}

function onAlert(ev) {
  toast(ev.text);
  refreshAlerts();
  // 到点提醒：页面不在前台时用系统通知
  if (ev.urgent && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
    new Notification('小红书运营工作台', { body: ev.text });
  }
}

function openAlert(i) {
  const a = S.alerts[i];
  $('#overlay').hidden = true;
  if (!a) return;
  if (a.account !== S.accountId) switchAccount(a.account);
  if (a.kind === 'radar') return go('benchmark', { id: a.id });
  go(a.kind === 'publish' ? 'schedule' : 'engage');
}

function showAlerts() {
  // 不自动请求通知权限：Chrome 的权限弹窗会卡住整个页面，改成用户点按钮才请求
  const askPermission = 'Notification' in window && Notification.permission === 'default'
    ? '<button class="btn small" id="notify-allow">允许系统通知</button>'
    : '';
  showOverlay(`<div class="row"><h3 style="margin:0">${icon("bell")} 提醒</h3><div class="spacer"></div>${askPermission}<button class="btn small ghost" data-close-overlay>关闭</button></div>
    ${S.alerts.length ? alertListHtml() : '<p class="muted">没有需要处理的事项。</p>'}
    <p class="muted" style="font-size:12px;margin-bottom:0">允许系统通知后，到点发布时即使页面在后台也会提醒你。</p>`);
  const btn = $('#notify-allow');
  if (btn) {
    btn.onclick = async () => {
      try {
        await Notification.requestPermission();
      } catch {
        /* 用户拒绝 */
      }
      showAlerts(); // 重渲染：按钮变成权限结果
    };
  }
}

// ---------- 未上线模块 ----------

function viewModule(mod) {
  $('#main').innerHTML = `
    <div class="module-intro">
      <h1 class="page-title">${icon(mod.icon)} ${esc(mod.name)} <span class="badge brand">${mod.stage} 开发中</span></h1>
      <p class="page-sub">${esc(mod.desc)}</p>
      <div class="card">
        <strong>面板还在开发中，不过现在就可以直接让 agent 帮你做：</strong>
        <div class="prompt-list">
          ${mod.prompts.map((p) => `<button class="prompt-chip" data-prompt="${esc(p)}">${esc(p)}</button>`).join('')}
        </div>
      </div>
    </div>`;
}

// ---------- 知识库 ----------

async function refreshKnowledge() {
  try {
    const data = await api('GET', '/api/knowledge');
    S.kb.docs = data.docs;
    S.kb.folders = data.folders;
    // 当前文档被 agent 改了且本地没在编辑时，重新加载
    if (S.kb.current && !S.kb.dirty) {
      const still = data.docs.find((d) => d.path === S.kb.current.path);
      if (!still) S.kb.current = null;
      else if (still.updatedAt !== S.kb.current.updatedAt) S.kb.current = await api('GET', `/api/knowledge/file?path=${encodeURIComponent(still.path)}`);
    }
    if (S.kb.query) S.kb.results = (await api('GET', `/api/knowledge/search?q=${encodeURIComponent(S.kb.query)}`)).results;
    if (S.view === 'knowledge' && !S.kb.editing) viewKnowledge();
    else if (S.view === 'knowledge') renderKbTree();
  } catch (err) {
    console.error(err);
  }
}

function viewKnowledge() {
  $('#main').innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <div>
        <h1 class="page-title">${icon("book")} 知识库</h1>
        <div class="muted" style="font-size:13px">品牌口径、爆款方法、对标拆解、复盘结论都沉淀在这里，agent 写稿时会参考。</div>
      </div>
      <div class="spacer"></div>
      <button class="btn" id="kb-new">新建文档</button>
    </div>
    <div class="kb">
      <div class="card kb-side">
        <input type="search" id="kb-search" placeholder="搜索知识库，例如：怎么写标题" value="${esc(S.kb.query)}">
        <div class="kb-tree" id="kb-tree"></div>
      </div>
      <div class="card kb-main" id="kb-main"></div>
    </div>`;
  renderKbTree();
  renderKbDoc();
}

function renderKbTree() {
  const tree = $('#kb-tree');
  if (!tree) return;
  const cur = S.kb.current && S.kb.current.path;
  if (S.kb.query) {
    const r = S.kb.results || [];
    tree.innerHTML = r.length
      ? r.map((d) => `<button class="kb-doc${d.path === cur ? ' active' : ''}" data-doc="${esc(d.path)}">${esc(d.title)}<span class="snippet">${highlight(d.snippet)}</span></button>`).join('')
      : '<div class="empty">没有找到</div>';
    tree.insertAdjacentHTML('beforeend', `<button class="btn small ask-kb" data-ask-kb>${icon("bot")} 问 agent：「${esc(S.kb.query)}」</button>`);
    return;
  }
  const byFolder = new Map([['', []], ...S.kb.folders.map((f) => [f, []])]);
  for (const d of S.kb.docs) {
    if (!byFolder.has(d.folder)) byFolder.set(d.folder, []);
    byFolder.get(d.folder).push(d);
  }
  let html = '';
  for (const [folder, docs] of byFolder) {
    if (folder) html += `<div class="kb-folder">${icon("folder")} ${esc(folder)}</div>`;
    html += docs.map((d) => `<button class="kb-doc${d.path === cur ? ' active' : ''}" data-doc="${esc(d.path)}" title="${esc(d.path)}">${esc(d.title)}</button>`).join('');
    if (folder && !docs.length) html += '<div class="kb-doc muted" style="cursor:default">（空）</div>';
  }
  tree.innerHTML = html || '<div class="empty">知识库是空的</div>';
}

// 搜索结果片段：\u0001…\u0002 之间是命中的词
function highlight(snip) {
  return esc(snip).replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>');
}

function renderKbDoc() {
  const box = $('#kb-main');
  if (!box) return;
  const doc = S.kb.current;
  if (!doc) {
    box.innerHTML = '<div class="empty" style="margin:auto">从左侧选择一篇文档，或者让 agent 帮你写一篇</div>';
    return;
  }
  const tags = doc.tags.map((t) => `<span class="badge">${esc(t)}</span>`).join(' ');
  box.innerHTML = `
    <div class="kb-toolbar">
      <strong>${esc(doc.title)}</strong> ${tags}
      <span class="path">${esc(doc.path)} · ${fmtTime(doc.updatedAt)}</span>
      <div class="spacer"></div>
      ${S.kb.editing
        ? `<button class="btn small ghost" id="kb-cancel">取消</button><button class="btn small primary" id="kb-save">保存</button>`
        : `<button class="btn small" id="kb-ask">让 agent 处理</button><button class="btn small" id="kb-edit">编辑</button><button class="btn small ghost danger" id="kb-delete">删除</button>`}
    </div>
    ${S.kb.editing
      ? `<textarea class="kb-editor" id="kb-editor" spellcheck="false">${esc(doc.content)}</textarea>`
      : `<div class="kb-body md">${md(stripFrontmatter(doc.content))}</div>`}`;
  if (S.kb.editing) {
    const ed = $('#kb-editor');
    ed.addEventListener('input', () => (S.kb.dirty = true));
    ed.focus();
  }
}

async function openDoc(path) {
  if (S.kb.dirty && !confirm('当前文档有未保存的修改，确定切换吗？')) return;
  try {
    S.kb.current = await api('GET', `/api/knowledge/file?path=${encodeURIComponent(path)}`);
    S.kb.editing = false;
    S.kb.dirty = false;
    renderKbTree();
    renderKbDoc();
  } catch (err) {
    toast(err.message);
  }
}

async function saveDoc() {
  try {
    S.kb.current = await api('PUT', '/api/knowledge/file', { path: S.kb.current.path, content: $('#kb-editor').value });
    S.kb.editing = false;
    S.kb.dirty = false;
    toast('已保存');
    await refreshKnowledge();
  } catch (err) {
    toast(err.message);
  }
}

async function newDoc() {
  const folders = S.kb.folders.length ? `\n现有目录：${S.kb.folders.join('、')}` : '';
  let name = prompt(`新文档的路径（可带目录，例如：爆款方法论/标题公式）${folders}`);
  if (!name) return;
  name = name.trim().replace(/^\/+/, '');
  if (!name.toLowerCase().endsWith('.md')) name += '.md';
  if (S.kb.docs.some((d) => d.path === name)) return openDoc(name);
  const title = name.split('/').pop().replace(/\.md$/i, '');
  const today = new Date().toISOString().slice(0, 10);
  try {
    S.kb.current = await api('PUT', '/api/knowledge/file', {
      path: name,
      content: `---\ntitle: ${title}\ntags: []\nupdated: ${today}\n---\n\n# ${title}\n\n`,
    });
    S.kb.editing = true;
    await refreshKnowledge();
    renderKbDoc();
  } catch (err) {
    toast(err.message);
  }
}

async function deleteDoc() {
  if (!confirm(`把「${S.kb.current.title}」移入回收站？（文件会移到数据目录的 .trash/ 下，可以找回）`)) return;
  try {
    await api('DELETE', `/api/knowledge/file?path=${encodeURIComponent(S.kb.current.path)}`);
    S.kb.current = null;
    toast('已移入回收站');
    await refreshKnowledge();
  } catch (err) {
    toast(err.message);
  }
}

// ---------- 账号管理 ----------

async function refreshAccounts() {
  try {
    S.accounts = await api('GET', '/api/accounts');
    if (!S.accounts.accounts.some((a) => a.id === S.accountId)) S.accountId = S.accounts.defaultAccountId || S.accounts.accounts[0]?.id;
    renderAccountSelect();
    if (S.view === 'accounts' || S.view === 'overview') renderMain();
  } catch (err) {
    console.error(err);
  }
}

function renderAccountSelect() {
  $('#account-select').innerHTML = S.accounts.accounts.map((a) => `<option value="${esc(a.id)}"${a.id === S.accountId ? ' selected' : ''}>${esc(a.name)}</option>`).join('');
}

async function loadCuratorCard() {
  const box = $('#curator-card');
  if (!box) return;
  try {
    const cfg = await api('GET', `/api/automation?${acc()}`);
    const opts = [[0, '关闭'], [6, '每 6 小时'], [12, '每 12 小时'], [24, '每天一次'], [48, '每两天一次']];
    box.innerHTML = `<div class="row"><h3 style="margin:0">${icon("book")} 知识库管家</h3><div class="spacer"></div>
      <label class="muted" style="font-size:13px">整理频率
        <select id="curator-every">${opts.map(([v, n]) => `<option value="${v}"${cfg.curator.everyHours === v ? ' selected' : ''}>${n}</option>`).join('')}</select>
      </label></div>
      <p class="muted" style="margin:8px 0 0;font-size:12px">agent 会按频率自动整理知识库：归档新拆解和复盘结论、合并重复文档、维护「知识库地图」索引。${cfg.lastRuns.curator ? `上次整理：${fmtTime(cfg.lastRuns.curator)}。` : '还没有整理过。'}需要工作台保持运行。</p>`;
    $('#curator-every').onchange = async (e) => {
      try {
        await api('POST', `/api/automation?${acc()}`, { curator: { everyHours: Number(e.target.value) } });
        toast('知识库管家设置已保存');
      } catch (err) {
        toast(err.message);
      }
    };
  } catch {
    box.innerHTML = `${icon("book")} 知识库管家：加载失败`;
  }
}

function viewAccounts() {
  const editing = S.editingAccount;
  const list = S.accounts.accounts.map((a) => `
    <div class="card">
      <div class="row"><h3 style="margin:0">${esc(a.name)}</h3>
        ${a.id === S.accountId ? '<span class="badge brand">当前</span>' : ''}
        ${a.id === S.accounts.defaultAccountId ? '<span class="badge">默认</span>' : ''}
        <div class="spacer"></div>
        ${a.id !== S.accountId ? `<button class="btn small" data-use-account="${esc(a.id)}">切换到它</button>` : ''}
        <button class="btn small" data-edit-account="${esc(a.id)}">编辑</button>
      </div>
      <dl class="kv" style="margin-top:10px">
        <dt>小红书号</dt><dd>${esc(a.xhsId) || '<span class="muted">未填写</span>'}</dd>
        <dt>定位</dt><dd>${esc(a.positioning) || '<span class="muted">未填写</span>'}</dd>
        <dt>目标人群</dt><dd>${esc(a.audience) || '<span class="muted">未填写</span>'}</dd>
        <dt>内容风格</dt><dd>${esc(a.style) || '<span class="muted">未填写</span>'}</dd>
        <dt>浏览器登录</dt><dd>${browserLine(a)}</dd>
      </dl>
      <div class="row" style="margin-top:10px"><button class="btn small" data-login-account="${esc(a.id)}">${a.browser && a.browser.loggedIn ? '检查登录状态' : '在浏览器里登录这个账号'}</button></div>
    </div>`).join('');

  const a = editing === 'new' ? {} : S.accounts.accounts.find((x) => x.id === editing);
  const form = editing ? `
    <div class="card" style="margin-bottom:16px">
      <h3 style="margin-top:0">${editing === 'new' ? '添加账号' : `编辑：${esc(a.name)}`}</h3>
      <form class="form" id="account-form">
        <label>账号名称 *<input type="text" name="name" required value="${esc(a.name)}"></label>
        <label>小红书号<input type="text" name="xhsId" value="${esc(a.xhsId)}"></label>
        <label>定位（这个号做什么、给谁看、提供什么价值）<textarea name="positioning" rows="3">${esc(a.positioning)}</textarea></label>
        <label>目标人群<textarea name="audience" rows="2">${esc(a.audience)}</textarea></label>
        <label>内容风格（语气、人设、视觉偏好）<textarea name="style" rows="2">${esc(a.style)}</textarea></label>
        <div class="row">
          <button class="btn primary" type="submit">保存</button>
          <button class="btn ghost" type="button" id="account-cancel">取消</button>
          ${editing !== 'new' && editing !== S.accounts.defaultAccountId ? `<button class="btn ghost" type="button" data-default-account="${esc(editing)}">设为默认账号</button>` : ''}
        </div>
      </form>
    </div>` : '';

  $('#main').innerHTML = `
    <div class="row" style="margin-bottom:16px">
      <div><h1 class="page-title">${icon("user")} 账号管理</h1><div class="muted" style="font-size:13px">支持多账号矩阵，每个账号的数据单独存放；agent 会按当前账号的定位工作。</div></div>
      <div class="spacer"></div>
      <button class="btn" id="account-add">添加账号</button>
    </div>
    ${form}
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr))">${list}</div>`;
}

function browserLine(a) {
  const live = S.bridge?.browserWorker?.accounts?.[a.id];
  const state = live && live.phase !== 'idle' ? `<div class="muted">后台窗口：${esc(live.phase)} · ${live.window === 'minimized' ? '已请求最小化' : live.window === 'visible' ? '可见有头' : live.window === 'unknown' ? '需手动恢复窗口' : '关闭'}${live.reason ? ` · ${esc(live.reason)}` : ''}</div>` : '';
  const b = a.browser;
  if (!b) return `<span class="muted">尚未保存登录记录（以实时核对为准）</span>${state}`;
  const who = [b.nickname, b.xhsId && `小红书号 ${b.xhsId}`].filter(Boolean).map(esc).join(' · ');
  const mismatch = a.xhsId && b.xhsId && a.xhsId !== b.xhsId;
  return `${b.loggedIn ? `${icon("check", "icon-ok")} 上次已登录` : `${icon("warning", "icon-warn")} 上次未登录`}${who ? `：${who}` : ''}${b.checkedAt ? `<span class="muted">（${fmtTime(b.checkedAt)} 检查，以实时页面为准）</span>` : ''}${mismatch ? `<div class="error-line">登录的小红书号和账号信息里填的（${esc(a.xhsId)}）不一致，自动操作会被拦下</div>` : ''}${state}`;
}

function loginAccount(id) {
  if (id !== S.accountId) switchAccount(id);
  if (S.bridge?.browserWorker?.enabled && S.bridge.browserWorker.available && S.bridge.browserWorker.compatible) {
    return sendMessage('检查浏览器登录账号', { taskKind: 'browser.prepare' });
  }
  sendMessage('请按 playbooks/browser.md 打开小红书创作者中心，检查这个账号的浏览器登录状态；没登录就停在登录页等我本人登录（每 15 秒检查一次，最多等 5 分钟）。完成后更新登录状态文件，不要做任何其他操作。');
}

async function saveAccountForm(form) {
  const data = Object.fromEntries(new FormData(form));
  if (S.editingAccount !== 'new') data.id = S.editingAccount;
  try {
    const acc = await api('POST', '/api/accounts', data);
    S.editingAccount = null;
    if (!data.id) S.accountId = acc.id;
    toast('已保存');
    await refreshAccounts();
    viewAccounts();
  } catch (err) {
    toast(err.message);
  }
}

// ---------- 连接与设置 ----------

async function refreshBridge() {
  try {
    const { status } = await api('GET', '/api/bridge');
    S.bridge = status;
    renderBridge();
    if (S.view === 'settings') viewSettings();
  } catch (err) {
    console.error(err);
  }
}

function bridgeSummary() {
  const b = S.bridge;
  if (!b) return { cls: 'bad', label: '工作台已断开' };
  if (!b.configured) return { cls: 'bad', label: '未连接 agent' };
  if (b.mode === 'cli') return { cls: 'ok', label: b.adapter ? b.adapter.name : 'CLI 模式' };
  return b.inboxOnline ? { cls: 'ok', label: '值守 agent 在线' } : { cls: 'warn', label: '等待 agent 值守' };
}

function renderBridge(override) {
  const sum = override ? { cls: 'bad', label: override } : bridgeSummary();
  const pill = $('#bridge-pill');
  pill.className = `bridge-pill ${sum.cls}`;
  pill.querySelector('.label').textContent = sum.label;
  renderChatBanner();
}

function workerSettingsHtml(w = {}) {
  const PHASE = { idle: '空闲', starting: '启动中', ready: '就绪', 'checking-login': '核对登录中', searching: '搜索中', 'reading-profile': '读取主页中', needsLogin: '等待本人登录', needsReview: '需要人工核对', error: '错误' };
  const current = w.accounts?.[S.accountId] || {};
  const available = w.available && w.compatible;
  return `<div class="card" style="max-width:760px;margin-top:16px">
    <h3 style="margin-top:0">后台有头只读采集（可选）</h3>
    <p class="muted">同账号复用独立浏览器资料；登录/验证码窗口必须可见，核对成功后尝试最小化。不能保证不抢焦点或避开平台风控；发布由本人在官方应用手动完成。</p>
    <dl class="kv">
      <dt>组件</dt><dd>${w.available ? '已安装' : '未安装'}${w.compatible ? '' : ' · 需要 CLI + 有头 Playwright MCP'}</dd>
      <dt>当前账号</dt><dd>${PHASE[current.phase] || esc(current.phase || '空闲')} · ${current.window === 'minimized' ? '已请求最小化' : current.window === 'visible' ? '可见有头窗口' : current.window === 'unknown' ? '需手动恢复窗口' : '窗口关闭'}${current.lastElapsedMs ? ` · 最近 ${(current.lastElapsedMs / 1000).toFixed(1)} 秒` : ''}${current.reason ? `<br>${esc(current.reason)}` : ''}${current.windowNote ? `<br>${esc(current.windowNote)}` : ''}</dd>
      <dt>资料占用</dt><dd>${current.window && current.window !== 'closed' ? 'worker 持有；原 MCP 任务启动前会先释放' : '空闲 / 原 agent 任务自行管理'}</dd>
    </dl>
    ${w.available ? `<button class="btn" id="worker-toggle" ${w.enabled || available ? '' : 'disabled'}>${w.enabled ? '关闭后台读取' : '开启后台读取'}</button>` : '<p class="muted">请让 agent 向你说明并在你确认后运行 <code>node scripts/workbench.mjs browser-worker-setup --yes</code> 安装可选组件；默认不安装、不启用。</p>'}
    ${w.enabled && S.bridge?.adapter?.id === 'claude-code' ? `<div class="row" style="margin-top:12px"><label>可选快速模型（只在歧义时给人工建议，留空则不调用）<input id="fast-read-model" type="text" placeholder="例如 haiku" value="${esc(w.fastModel || '')}"></label><button class="btn small" id="fast-model-save">保存</button></div>` : ''}
  </div>`;
}

function viewSettings() {
  const b = S.bridge || {};
  const info = S.info || {};
  const modeText = !b.configured ? '未配置' : b.mode === 'cli' ? 'CLI 模式（工作台直接调用 agent 命令行）' : `收件箱模式（${b.hostAgent ? b.hostAgent.name : 'agent'} 在自己的会话里值守）`;
  if (!S.detected && !S.detecting) {
    S.detecting = true;
    api('GET', '/api/bridge/detect').then((r) => { S.detected = r.adapters; S.detectedDesktop = r.desktop || []; }).catch(() => { S.detected = []; S.detectedDesktop = []; }).finally(() => { S.detecting = false; if (S.view === 'settings') viewSettings(); });
  }
  const detected = S.detected;
  const detectedDesktop = S.detectedDesktop || [];
  $('#main').innerHTML = `
    <h1 class="page-title">${icon("plug")} 连接与设置</h1>
    <p class="page-sub">这里选择工作台实际调用的 Agent；不会自动跟随当前聊天应用切换。</p>
    <div class="card" id="curator-card" style="max-width:760px;margin-bottom:16px">${icon("book")} 知识库管家：加载中…</div>
    <div class="card" style="max-width:760px">
      <h3 style="margin-top:0">Agent 连接</h3>
      <dl class="kv">
        <dt>连接模式</dt><dd>${esc(modeText)}</dd>
        ${b.mode === 'cli' && b.adapter ? `<dt>Agent</dt><dd>${esc(b.adapter.name)} <code>${esc(b.adapter.command)}</code></dd>` : ''}
        ${b.mode === 'inbox' ? `<dt>值守状态</dt><dd>${b.inboxOnline ? icon('dot', 'icon-ok') + ' 在线' : icon('dot', 'icon-warn') + ' 离线'}${b.lastPollAt ? `（最近一次 ${fmtTime(b.lastPollAt)}）` : ''}，待领取 ${b.pending} 条</dd>` : ''}
        <dt>上次测试</dt><dd>${b.testedAt ? fmtTime(b.testedAt) : '—'}</dd>
        ${b.mode === 'cli' ? `<dt>浏览器控制</dt><dd>${b.browser === 'playwright' ? `${icon('check', 'icon-ok')} Playwright（${b.adapter?.id==='codex'?'只读采集':'独立浏览器'}）` : b.browser === 'chrome' ? `${icon('check', 'icon-ok')} Claude in Chrome` : '未开启（只读采集需要）'}</dd>` : ''}
        ${b.mode === 'cli' && b.browser === 'playwright' ? `<dt>抓取浏览器</dt><dd>${b.adapter && b.adapter.browserChannel && b.adapter.browserChannel !== 'chromium' ? `${icon('check', 'icon-ok')} 系统浏览器（${b.adapter.browserChannel === 'msedge' ? 'Edge' : 'Chrome'}；仍有平台风控风险）` : `${icon('warning', 'icon-warn')} 内置浏览器（建议重新运行 browser-setup，自动切换到系统 Edge/Chrome）`}；${b.adapter && b.adapter.headless ? '无头（后台）' : '有头（弹窗）'}</dd>` : ''}
      </dl>
      <div class="row" style="margin-top:14px">
        ${b.mode === 'cli' ? '<button class="btn" id="bridge-test">重新测试连接</button>' : ''}
        <button class="btn" id="bridge-detect">检测本机 agent</button>
        ${b.mode !== 'inbox' ? '<button class="btn ghost" id="bridge-inbox">改用收件箱模式</button>' : ''}
      </div>
      ${detected ? `
        <div style="margin-top:14px">
          <div class="muted" style="margin-bottom:4px">本机检测到的 agent（由你决定网页里的对话交给谁处理，不会自动切换）</div>
          ${detected.map((a) => `<div class="row" style="padding:6px 0;border-top:1px solid var(--line)"><span>${esc(a.name)}</span>${b.mode === 'cli' && b.adapter?.id === a.id ? '<span class="muted">（当前）</span>' : ''}<code class="muted">${esc(a.command)}</code><span class="muted">CLI 模式 · 无需保持窗口</span><div class="spacer"></div><button class="btn small" data-use-adapter="${esc(a.id)}">测试并使用</button></div>`).join('')}
          ${detectedDesktop.map((a) => `<div class="row" style="padding:6px 0;border-top:1px solid var(--line)"><span>${esc(a.name)}</span>${b.mode === 'inbox' && b.hostAgent?.id === a.id ? '<span class="muted">（当前）</span>' : ''}<span class="muted">收件箱模式 · 需要它的窗口保持打开并值守</span><div class="spacer"></div><button class="btn small" data-use-host="${esc(a.id)}">使用它值守</button></div>`).join('')}
          ${!detected.length && !detectedDesktop.length ? '<div class="muted">本机没有检测到支持的 agent，可使用收件箱模式，让你正在用的 agent 值守。</div>' : ''}
        </div>` : ''}
      ${b.mode === 'cli' && !b.browser ? `
        <div class="chat-banner" style="margin:14px 0 0">
          需要配置只读采集浏览器？回到你的 agent，发送：<br>
          <code>为小红书工作台开启浏览器控制</code>
        </div>` : ''}
      ${b.mode === 'inbox' ? `
        <div class="chat-banner" style="margin:14px 0 0">
          收件箱模式需要 agent 在它自己的窗口里「值守」。回到你的 agent，发送：<br>
          <code>打开小红书工作台，并进入值守模式</code>
        </div>` : ''}
    </div>
    <div class="card" id="video-service-settings" style="max-width:760px;margin-top:16px">视频生成服务：加载中…</div>
    <div class="card" id="image-service-settings" style="max-width:760px;margin-top:16px">图片生成服务：加载中…</div>
    ${workerSettingsHtml(b.browserWorker)}
    <div id="system-panels"></div>
    <div class="card" style="max-width:760px;margin-top:16px">
      <h3 style="margin-top:0">目录</h3>
      <dl class="kv">
        <dt>数据目录</dt><dd><code>${esc(info.workspace)}</code></dd>
        <dt>技能包目录</dt><dd><code>${esc(info.skillDir)}</code></dd>
        <dt>版本</dt><dd>v${esc(info.version)}${info.upgrade ? `（数据格式 v${esc(info.upgrade.dataVersion)}）` : ''}</dd>
        ${info.upgrade?.lastUpgrade ? `<dt>最近升级</dt><dd>${fmtTime(info.upgrade.lastUpgrade.at)} · ${info.upgrade.lastUpgrade.from ? 'v' + esc(info.upgrade.lastUpgrade.from) : '旧版本'} → v${esc(info.upgrade.lastUpgrade.to)}${info.upgrade.lastUpgrade.ok === false ? ` ${icon('dot', 'icon-warn')} 失败：${esc(info.upgrade.lastUpgrade.error || '')}` : ''}${info.upgrade.lastUpgrade.backup ? `<br><span class="muted">升级前已自动备份：${esc(info.upgrade.lastUpgrade.backup)}（见上方「备份与恢复」）</span>` : ''}</dd>` : ''}
        ${info.upgrade?.startup && info.upgrade.startup.ok === false ? `<dt>升级状态</dt><dd>${icon('dot', 'icon-warn')} ${esc(info.upgrade.startup.error || '')}</dd>` : ''}
      </dl>
    </div>`;
  renderSystem($('#system-panels'));
  mountImageServiceSettings($('#image-service-settings'));
  mountVideoSettings($('#video-service-settings'));
  loadCuratorCard();
}

// ---------- 对话 ----------

async function refreshSessions() {
  try {
    S.sessions = (await api('GET', '/api/chats')).sessions;
    renderSessionSelect();
  } catch (err) {
    console.error(err);
  }
}

function renderSessionSelect() {
  const cur = S.session && S.session.id;
  const opts = S.sessions.map((s) => `<option value="${esc(s.id)}"${s.id === cur ? ' selected' : ''}>${esc(s.title)} · ${fmtTime(s.updatedAt)}</option>`);
  if (!cur) opts.unshift('<option value="" selected>新对话</option>');
  $('#session-select').innerHTML = opts.join('');
}

async function openSession(id) {
  if (!id) {
    S.session = null;
  } else {
    try {
      S.session = await api('GET', `/api/chat?id=${encodeURIComponent(id)}`);
    } catch (err) {
      toast(err.message);
      S.session = null;
    }
  }
  try { localStorage.setItem('xhs-session', S.session ? S.session.id : ''); } catch { /* 忽略 */ }
  renderSessionSelect();
  renderMessages();
}

function isBusy() {
  const s = S.session;
  const last = s && s.messages[s.messages.length - 1];
  return !!last && last.role === 'assistant' && (last.status === 'pending' || last.status === 'running');
}

function msgHtml(m) {
  if (m.role === 'user') return `<div class="msg user" data-msg="${m.id}"><div class="bubble">${esc(m.text)}</div></div>`;
  const tools = (m.tools || []).slice(-6).map((t) => `<div class="tool" title="${esc(t.detail)}">${t.name === '进度' ? icon('clock') : icon('wrench')} ${esc(t.name)} ${esc(t.detail)}</div>`).join('');
  const more = (m.tools || []).length > 6 ? `<div class="tool">… 共使用工具 ${m.tools.length} 次</div>` : '';
  const working = m.status === 'pending' || m.status === 'running';
  let status = '';
  if (m.status === 'pending') {
    status = S.bridge && S.bridge.mode === 'cli' ? '排队中：这个账号的上一个任务完成后开始' : S.bridge && !S.bridge.inboxOnline ? '等待 agent 领取任务…' : '已发送，等待 agent 领取…';
  }
  else if (m.status === 'running' && !m.text) status = 'agent 正在处理…';
  return `<div class="msg assistant" data-msg="${m.id}"><div class="bubble">
      ${tools || more ? `<div class="tools">${more}${tools}</div>` : ''}
      <div class="md${working ? ' typing' : ''}">${md(m.text)}</div>
      ${status ? `<div class="status">${status}</div>` : ''}
      ${m.status === 'error' ? `<div class="error">${icon("warning")} ${esc(m.error || '出错了')}</div>` : ''}
    </div></div>`;
}

function renderMessages() {
  const box = $('#chat-messages');
  const s = S.session;
  if (!s || !s.messages.length) {
    box.innerHTML = `<div class="chat-empty">${icon('bulb')} 在这里给你的 agent 布置任务<br>例如「帮我把这篇爆款笔记拆解后存进知识库」</div>`;
  } else {
    box.innerHTML = s.messages.map(msgHtml).join('');
    box.scrollTop = box.scrollHeight;
  }
  renderComposer();
}

function updateMessage(m) {
  const el = document.querySelector(`[data-msg="${m.id}"]`);
  const box = $('#chat-messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  if (el) el.outerHTML = msgHtml(m);
  else return renderMessages();
  if (atBottom) box.scrollTop = box.scrollHeight;
  renderComposer();
}

function renderComposer() {
  const busy = isBusy();
  $('#stop-btn').hidden = !busy;
  $('#send-btn').disabled = busy || !(S.bridge && S.bridge.configured);
  const acc = currentAccount();
  $('#composer-hint').textContent = acc ? `以「${acc.name}」的身份工作` : '';
}

function renderChatBanner() {
  const el = $('#chat-banner');
  const b = S.bridge;
  let html = '';
  if (b && !b.configured) html = '还没有连接 agent。回到你的 agent，说：<code>运行小红书工作台的连接自检</code>';
  else if (b && b.mode === 'inbox' && !b.inboxOnline) html = `收件箱模式：${esc(b.hostAgent ? b.hostAgent.name : 'agent')} 目前没在值守，消息会排队。回到它的窗口，说：<code>进入小红书工作台值守模式</code>`;
  el.innerHTML = html;
  el.hidden = !html;
  renderComposer();
}

function onChatEvent(ev) {
  if (!S.session || ev.sessionId !== S.session.id) {
    if (ev.type === 'chat.done') refreshSessions();
    return;
  }
  const s = S.session;
  if (ev.type === 'chat.done') {
    const i = s.messages.findIndex((m) => m.id === ev.msg.id);
    if (i >= 0) s.messages[i] = ev.msg;
    updateMessage(ev.msg);
    refreshSessions();
    return;
  }
  const m = s.messages.find((x) => x.id === ev.msgId);
  if (!m) return;
  if (ev.type === 'chat.delta') {
    m.text += ev.text;
    m.status = 'running';
  } else if (ev.type === 'chat.tool') {
    m.tools = m.tools || [];
    m.tools.push({ name: ev.name, detail: ev.detail });
    m.status = 'running';
  } else if (ev.type === 'chat.status') {
    m.status = ev.status;
  }
  updateMessage(m);
}

async function sendMessage(text, options = {}) {
  text = text.trim();
  document.body.classList.add('chat-open');
  document.body.classList.remove('chat-hidden');
  if (!text || isBusy()) return;
  try {
    const session = await api('POST', '/api/chat/send', { sessionId: S.session && S.session.id, accountId: S.accountId, text, ...options });
    S.session = session;
    try { localStorage.setItem('xhs-session', session.id); } catch { /* 忽略 */ }
    $('#chat-input').value = '';
    renderMessages();
    refreshSessions();
  } catch (err) {
    toast(err.message);
  }
}

// 把预设提示词放进输入框，方便用户补充后发送
function usePrompt(text) {
  const input = $('#chat-input');
  input.value = text;
  document.body.classList.add('chat-open');
  document.body.classList.remove('chat-hidden');
  input.focus();
  input.setSelectionRange(text.length, text.length);
}

// ---------- 事件绑定 ----------

function bindEvents() {
  document.addEventListener('click', async (e) => {
    if (e.target.id === 'overlay') return ($('#overlay').hidden = true);
    const t = e.target.closest('[data-nav],[data-prompt],[data-doc],[data-use-account],[data-login-account],[data-ask-kb],[data-edit-account],[data-default-account],[data-use-adapter],[data-alert],[data-close-overlay],[data-onboard],[data-onboard-skip],button');
    if (!t) return;
    if (t.dataset.alert) return openAlert(Number(t.dataset.alert));
    if (t.dataset.onboard !== undefined) return onboarding.open();
    if (t.dataset.onboardSkip !== undefined) {
      onboarding.dismiss();
      return ($('#overlay').hidden = true);
    }
    if (t.dataset.askKb !== undefined) {
      return sendMessage(`请在知识库（knowledge/ 目录）里查找和「${S.kb.query}」相关的内容并回答我的问题，按意思找、不要只按字面匹配，回答时列出引用的文档路径。可以先用 \`node ${S.info.skillDir}/scripts/workbench.mjs kb-search "${S.kb.query}"\` 找候选文档（不能执行命令时直接搜索文件）。`);
    }
    if (t.dataset.closeOverlay !== undefined) return ($('#overlay').hidden = true);
    if (t.dataset.nav) return go(t.dataset.nav);
    if (t.dataset.prompt) return usePrompt(t.dataset.prompt);
    if (t.dataset.doc) return openDoc(t.dataset.doc);
    if (t.dataset.useAccount) return switchAccount(t.dataset.useAccount);
    if (t.dataset.loginAccount) return loginAccount(t.dataset.loginAccount);
    if (t.dataset.editAccount) {
      S.editingAccount = t.dataset.editAccount;
      return viewAccounts();
    }
    if (t.dataset.defaultAccount) {
      await api('POST', '/api/accounts/default', { id: t.dataset.defaultAccount }).catch((err) => toast(err.message));
      S.editingAccount = null;
      return refreshAccounts();
    }
    if (t.dataset.useHost) {
      if (!confirm('改用收件箱模式后，需要该 agent 的窗口保持打开并进入值守才能处理消息。确定吗？')) return;
      await api('PUT', '/api/bridge', { mode: 'inbox', hostAgentId: t.dataset.useHost }).catch((err) => toast(err.message));
      return refreshBridge();
    }
    if (t.dataset.useAdapter) {
      return withBusy(t, '测试中…（最长约 3 分钟）', async () => {
        const r = await api('PUT', '/api/bridge', { adapterId: t.dataset.useAdapter });
        toast(r.ok ? '连接成功，已切换' : `测试失败：${r.error}`);
        await refreshBridge();
      });
    }
    switch (t.id) {
      case 'kb-new': return newDoc();
      case 'kb-edit':
        S.kb.editing = true;
        return renderKbDoc();
      case 'kb-cancel':
        if (S.kb.dirty && !confirm('放弃未保存的修改？')) return;
        S.kb.editing = false;
        S.kb.dirty = false;
        return renderKbDoc();
      case 'kb-save': return saveDoc();
      case 'kb-delete': return deleteDoc();
      case 'kb-ask': return usePrompt(`请处理知识库文档「knowledge/${S.kb.current.path}」：`);
      case 'account-add':
        S.editingAccount = 'new';
        return viewAccounts();
      case 'account-cancel':
        S.editingAccount = null;
        return viewAccounts();
      case 'worker-toggle':
        return withBusy(t, '切换中…', async () => {
          await api('POST', '/api/browser/worker', { enabled: !S.bridge?.browserWorker?.enabled });
          await refreshBridge();
        });
      case 'fast-model-save':
        return withBusy(t, '保存中…', async () => {
          await api('POST', '/api/browser/worker', { fastModel: $('#fast-read-model').value.trim() });
          await refreshBridge();
          toast('快速模型设置已保存；只在歧义时使用');
        });
      case 'bridge-test':
        return withBusy(t, '测试中…', async () => {
          const r = await api('POST', '/api/bridge/test');
          toast(r.ok ? `连接正常（${(r.ms / 1000).toFixed(1)} 秒）` : `连接失败：${r.error}`);
          await refreshBridge();
        });
      case 'bridge-detect':
        return withBusy(t, '检测中…', async () => {
          const r = await api('GET', '/api/bridge/detect?refresh=1');
          S.detected = r.adapters;
          S.detectedDesktop = r.desktop || [];
          viewSettings();
        });
      case 'bridge-inbox':
        if (!confirm('改用收件箱模式后，需要 agent 在它自己的窗口里值守才能处理消息。确定吗？')) return;
        await api('PUT', '/api/bridge', { mode: 'inbox' }).catch((err) => toast(err.message));
        return refreshBridge();
      case 'new-chat': return openSession('');
      case 'stop-btn':
        await api('POST', '/api/chat/cancel', { sessionId: S.session.id }).catch((err) => toast(err.message));
        return;
      case 'headless-toggle': {
        if ($('#headless-toggle').checked && !confirm('无头模式抓取小红书有封号风险（无头浏览器的特征容易被平台风控识别）。\n\n推荐保持有头 + 系统真实浏览器。确定要开启无头吗？')) {
          $('#headless-toggle').checked = false;
          return;
        }
        document.body.dataset.headlessBusy = '1';
        const r = await api('POST', '/api/bridge/headless', { on: $('#headless-toggle').checked }).catch((err) => (toast(err.message), null));
        delete document.body.dataset.headlessBusy;
        if (r) toast(r.headless ? '已切换为无头模式，下次抓取生效' : '已切换为有头模式，下次抓取生效');
        return;
      }
      case 'chat-toggle':
        // 窄屏：浮层滑入 / 滑出；宽屏：显示 / 收起常驻面板
        if (window.matchMedia('(max-width: 1100px)').matches) return document.body.classList.toggle('chat-open');
        return document.body.classList.toggle('chat-hidden');
      case 'chat-close':
        // 面板内 ×：一律收起（窄屏关浮层，宽屏隐藏常驻面板）
        document.body.classList.remove('chat-open');
        return document.body.classList.add('chat-hidden');
      case 'nav-toggle': return document.body.classList.toggle('nav-open');
      case 'alerts-btn': return showAlerts();
    }
  });

  document.addEventListener('submit', (e) => {
    if (e.target.id === 'account-form') {
      e.preventDefault();
      saveAccountForm(e.target);
    }
  });

  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage($('#chat-input').value);
  });
  $('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage(e.target.value);
    }
  });
  $('#session-select').addEventListener('change', (e) => openSession(e.target.value));
  $('#account-select').addEventListener('change', (e) => switchAccount(e.target.value));

  let searchTimer;
  document.addEventListener('input', (e) => {
    if (e.target.id !== 'kb-search') return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      S.kb.query = e.target.value.trim();
      S.kb.results = S.kb.query ? (await api('GET', `/api/knowledge/search?q=${encodeURIComponent(S.kb.query)}`)).results : null;
      renderKbTree();
    }, 250);
  });

  window.addEventListener('beforeunload', (e) => {
    if (S.kb.dirty) e.preventDefault();
  });
}

function switchAccount(id) {
  if (S.accountId !== id) {
    S.session = null;
    renderSessionSelect();
    renderMessages();
  }
  S.accountId = id;
  try { localStorage.setItem('xhs-account', id); } catch { /* 忽略 */ }
  renderAccountSelect();
  renderComposer();
  S.params = {};
  if (S.view !== 'knowledge' && S.view !== 'settings') renderMain();
  cover.autoRender({ area: 'notes' });
  toast(`已切换到「${currentAccount().name}」`);
}

// ---------- 启动 ----------

async function boot() {
  S.token = initToken();
  setHooks({ send: sendMessage, fill: usePrompt, go });
  bindEvents();
  if (!S.token) {
    showOverlay('<h3>请通过 agent 打开工作台</h3><p class="muted">回到你的 agent，说「打开小红书工作台」，它会给你一个带访问令牌的链接。</p>');
    return;
  }
  try {
    const state = await api('GET', '/api/state');
    S.info = state;
    S.bridge = state.bridge;
    S.accounts = state.accounts;
  } catch (err) {
    console.error(err);
    return;
  }
  let saved = {};
  try {
    saved = { view: localStorage.getItem('xhs-view'), account: localStorage.getItem('xhs-account'), session: localStorage.getItem('xhs-session') };
  } catch { /* 忽略 */ }
  S.accountId = S.accounts.accounts.some((a) => a.id === saved.account) ? saved.account : S.accounts.defaultAccountId || S.accounts.accounts[0]?.id;
  S.view = MODULES.some((m) => m.id === saved.view) ? saved.view : 'overview';

  initTopbarIcons();
  renderAccountSelect();
  renderBridge();
  renderNav();
  renderMain();
  connectEvents();
  await Promise.all([refreshKnowledge(), refreshSessions()]);
  await openSession(S.sessions.some((s) => s.id === saved.session) ? saved.session : '');
  cover.autoRender({ area: 'notes' });
  refreshAlerts();
  setInterval(refreshAlerts, 60_000);
  onboarding.maybeAutoShow();
}

boot();
