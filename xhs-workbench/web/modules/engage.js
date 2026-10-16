// 评论私信：agent 抓取新评论 / 私信并起草回复 → 用户修改确认 → agent 发送
import { esc } from '../md.js';
import { icon } from '../icons.js';
import { S, $, api, acc, toast, fmtTime, ask, opt, accDirRel } from '../core.js';
import { lint } from '../lint.js';

const FILTERS = [
  ['todo', '待处理'],
  ['approved', '待发送'],
  ['sent', '已回复'],
  ['ignored', '已忽略'],
  ['all', '全部'],
];
const STATUS = { new: ['新消息', 'warn'], drafted: ['已起草', ''], approved: ['已确认', 'brand'], sent: ['已回复', ''], ignored: ['已忽略', ''], failed: ['发送失败', 'bad'] };

const V = { items: [], cfg: null, filter: 'todo', type: 'all', showSettings: false, editing: new Set() };

async function load() {
  const [list, cfg] = await Promise.all([api('GET', `/api/engage?${acc()}`), api('GET', `/api/automation?${acc()}`)]);
  V.items = list.items;
  V.cfg = cfg;
}

export async function render(main) {
  if (V.accountId !== S.accountId) {
    V.accountId = S.accountId;
    V.editing.clear();
  }
  main.innerHTML = '<div class="empty">加载中…</div>';
  try {
    await load();
  } catch (err) {
    main.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  draw(main);
}

export function canLeave() {
  return !V.editing.size || confirm('有修改过但未保存的回复，确定离开吗？');
}

export async function onContent(ev) {
  if (!['engage', 'automation'].includes(ev.area) || V.editing.size) return;
  await load();
  draw($('#main'));
}

function matches(e) {
  const f = V.filter;
  const okStatus = f === 'all' || (f === 'todo' ? ['new', 'drafted', 'failed'].includes(e.status) : e.status === f);
  return okStatus && (V.type === 'all' || e.type === V.type);
}

function itemHtml(e) {
  const [label, cls] = STATUS[e.status] || [e.status, ''];
  const issues = e.draft ? lint({ body: e.draft }).issues.filter((i) => i.word) : [];
  const editable = !['sent', 'ignored'].includes(e.status);
  return `<div class="card engage-item" data-item="${esc(e.id)}">
    <div class="row">
      <span class="badge">${e.type === 'dm' ? '私信' : '评论'}</span>
      <strong>${esc(e.user || '匿名用户')}</strong>
      <span class="badge ${cls}">${label}</span>
      <span class="muted" style="font-size:12px">${esc(e.time ? fmtTime(e.time) : '')}</span>
      <div class="spacer"></div>
      ${e.noteTitle ? `<span class="muted engage-note" title="${esc(e.noteTitle)}">${icon("memo")} ${e.noteUrl ? `<a href="${esc(e.noteUrl)}" target="_blank" rel="noopener">${esc(e.noteTitle)}</a>` : esc(e.noteTitle)}</span>` : ''}
    </div>
    <div class="engage-content">${esc(e.content)}</div>
    ${editable ? `
      <textarea class="engage-draft" data-draft="${esc(e.id)}" rows="2" placeholder="回复草稿（可以自己写，或让 agent 起草）">${esc(e.draft || '')}</textarea>
      ${issues.length ? `<div class="error-line">${icon("warning", "icon-warn")} ${issues.map((i) => `「${esc(i.word)}」${esc(i.category)}`).join('，')}</div>` : ''}
      ${e.error ? `<div class="error-line">${esc(e.error)}</div>` : ''}
      <div class="row" style="margin-top:6px">
        <button class="btn small primary" data-act="approve" data-id="${esc(e.id)}" ${e.draft || V.editing.has(e.id) ? '' : 'disabled'}>${e.status === 'approved' ? '已确认 ✓' : '确认回复'}</button>
        ${e.status === 'approved' ? `<button class="btn small ghost" data-act="unapprove" data-id="${esc(e.id)}">撤回确认</button>` : ''}
        <button class="btn small ghost" data-act="ignore" data-id="${esc(e.id)}">忽略</button>
      </div>`
      : e.draft ? `<div class="engage-reply">↳ ${esc(e.draft)}${e.sentAt ? `<span class="muted">（${fmtTime(e.sentAt)}）</span>` : ''}</div>` : ''}
  </div>`;
}

function settingsHtml() {
  const g = V.cfg.engage;
  return `<div class="card" style="margin-bottom:16px;max-width:640px">
    <h3 style="margin-top:0">评论私信设置（当前账号）</h3>
    <form class="form" id="engage-settings">
      <label>定时检查新评论私信
        <select name="checkEveryHours">${[0, 1, 2, 4, 8, 12, 24].map((h) => opt(String(h), h ? `每 ${h} 小时` : '不自动检查', String(g.checkEveryHours))).join('')}</select>
      </label>
      <label>回复方式
        <select name="autoSend">${opt('false', '起草后等我确认再发（推荐）', String(g.autoSend))}${opt('true', 'agent 起草后直接发送', String(g.autoSend))}</select>
      </label>
      <label>每次最多回复（条）<input type="text" name="maxPerRun" value="${esc(g.maxPerRun)}"></label>
      <p class="muted" style="margin:0;font-size:12px">${V.cfg.lastRuns.engage ? `上次自动检查：${fmtTime(V.cfg.lastRuns.engage)}。` : ''}定时检查需要工作台保持运行、agent 能控制浏览器。短时间大量回复容易被判定为营销号，建议保持人工确认。</p>
      <div class="row"><button class="btn primary" type="submit">保存设置</button><button class="btn ghost" type="button" data-act="toggle-settings">收起</button></div>
    </form>
  </div>`;
}

function draw(main) {
  const count = (f) => V.items.filter((e) => (f === 'all' ? true : f === 'todo' ? ['new', 'drafted', 'failed'].includes(e.status) : e.status === f)).length;
  const list = V.items.filter(matches);
  const undrafted = V.items.filter((e) => e.status === 'new' && !e.draft).length;
  const approved = count('approved');
  main.innerHTML = `
    <div class="row page-head">
      <div><h1 class="page-title">${icon("chat")} 评论私信</h1><div class="muted">agent 抓取新评论和私信、按知识库口径起草回复，你确认后再发送。</div></div>
      <div class="spacer"></div>
      <button class="btn" data-act="toggle-settings">${icon("sliders")} 设置</button>
      <button class="btn" data-act="fetch">让 agent 检查新消息</button>
    </div>
    ${V.showSettings ? settingsHtml() : ''}
    <div class="row action-bar">
      <button class="btn small" data-act="draft-all" ${undrafted ? '' : 'disabled'}>让 agent 起草 ${undrafted} 条回复</button>
      <button class="btn small primary" data-act="send" ${approved ? '' : 'disabled'}>发送已确认的 ${approved} 条</button>
      <button class="btn small ghost" data-act="faq">整理成回复口径</button>
    </div>
    <div class="chips">
      ${FILTERS.map(([id, name]) => `<button class="chip${V.filter === id ? ' active' : ''}" data-filter="${id}">${name} ${count(id)}</button>`).join('')}
      <span class="spacer"></span>
      <select data-type aria-label="类型">${opt('all', '评论和私信', V.type)}${opt('comment', '只看评论', V.type)}${opt('dm', '只看私信', V.type)}</select>
    </div>
    ${list.length ? `<div class="engage-list">${list.map(itemHtml).join('')}</div>` : `<div class="card empty-card">
      <p>${V.items.length ? '这个分类下没有消息。' : '还没有抓取过评论和私信。'}</p>
      <p class="muted">点「让 agent 检查新消息」，agent 会打开创作者中心读取新评论和私信（需要浏览器控制能力；没有的话可以把评论截图发给 agent）。</p>
    </div>`}`;
  bind(main);
}

async function save(id, data) {
  try {
    await api('POST', `/api/engage?${acc()}`, { id, ...data });
    V.editing.delete(id);
    await load();
    draw($('#main'));
  } catch (err) {
    toast(err.message);
  }
}

function bind(main) {
  main.onclick = async (e) => {
    const t = e.target.closest('[data-act],[data-filter]');
    if (!t) return;
    if (t.dataset.filter) {
      V.filter = t.dataset.filter;
      return draw(main);
    }
    const id = t.dataset.id;
    const draftEl = id && $(`[data-draft="${id}"]`, main);
    const engageFile = `${accDirRel()}/engage/items.json`;
    switch (t.dataset.act) {
      case 'toggle-settings':
        V.showSettings = !V.showSettings;
        return draw(main);
      case 'approve': {
        const draft = draftEl ? draftEl.value.trim() : '';
        if (!draft) return toast('回复内容为空');
        return save(id, { draft, status: 'approved' });
      }
      case 'unapprove':
        return save(id, { draft: draftEl ? draftEl.value : undefined, status: 'drafted' });
      case 'ignore':
        return save(id, { status: 'ignored' });
      case 'fetch':
        return ask(`请按 playbooks/engage.md 检查当前账号的新评论和私信，写入 ${engageFile}，并为每条起草回复（只起草，不发送）。`, true);
      case 'draft-all':
        return ask(`请按 playbooks/engage.md，为 ${engageFile} 中状态为 new 且还没有草稿的消息起草回复（写入 draft，状态改为 drafted），不要发送。`, true);
      case 'send': {
        const n = V.items.filter((x) => x.status === 'approved').length;
        if (!confirm(`让 agent 发送 ${n} 条已确认的回复？`)) return;
        return ask(`请按 playbooks/engage.md 发送 ${engageFile} 中状态为 approved 的 ${n} 条回复（内容用 draft 字段，不要改写），逐条更新状态为 sent 或 failed。`, true);
      }
      case 'faq':
        return ask(`请分析 ${engageFile} 中的评论和私信，把高频问题和推荐回复整理到知识库「品牌口径/评论区回复口径.md」（已有则补充）。`, true);
    }
  };

  main.oninput = (e) => {
    const id = e.target.dataset.draft;
    if (!id) return;
    V.editing.add(id);
    const btn = $(`[data-act="approve"][data-id="${id}"]`, main);
    if (btn) btn.disabled = !e.target.value.trim();
  };
  // 离开输入框时自动保存草稿；如果是点了同一条的按钮，交给按钮处理，避免重绘吞掉点击
  main.onfocusout = (e) => {
    const id = e.target.dataset && e.target.dataset.draft;
    if (!id) return;
    const item = V.items.find((x) => x.id === id);
    if (!item || e.target.value === (item.draft || '')) return V.editing.delete(id);
    if (e.relatedTarget && e.relatedTarget.dataset && e.relatedTarget.dataset.id === id) return;
    save(id, { draft: e.target.value, status: item.status === 'new' && e.target.value.trim() ? 'drafted' : item.status });
  };

  main.onchange = (e) => {
    if (e.target.dataset.type !== undefined) {
      V.type = e.target.value;
      draw(main);
    }
  };

  main.onsubmit = async (e) => {
    e.preventDefault();
    if (e.target.id !== 'engage-settings') return;
    const d = Object.fromEntries(new FormData(e.target));
    try {
      await api('POST', `/api/automation?${acc()}`, { engage: { checkEveryHours: Number(d.checkEveryHours), autoSend: d.autoSend === 'true', maxPerRun: Number(d.maxPerRun) } });
      toast('设置已保存');
      await load();
      draw(main);
    } catch (err) {
      toast(err.message);
    }
  };
}
