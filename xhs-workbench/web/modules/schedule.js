import {renderDraft,draftBusy} from '../schedule-draft.js';
// 发布排期：安排发布时间 → 到点提醒手动发布（附发布助手）或交给 agent 自动发布
import { esc } from '../md.js';
import { icon } from '../icons.js';
import { S, $, api, acc, toast, fmtTime, ask, opt, accDirRel } from '../core.js';

export const CREATOR_URL = 'https://creator.xiaohongshu.com/publish/publish';

const STATUS = {
  planned: ['草案（不执行）',''],
  scheduled: ['已排期', ''],
  due: ['待手动发布', 'warn'],
  running: ['agent 发布中', 'warn'],
  check: ['待确认', 'warn'],
  published: ['已发布', 'brand'],
  failed: ['失败', 'bad'],
  missed: ['已错过', 'bad'],
  cancelled: ['已取消', ''],
};
const MODE = { draft: '草案（不发布）', remind: '到点提醒我', auto: 'agent 自动发布' };
const ATTENTION = ['due', 'missed', 'failed', 'check'];

const V = { items: [], notes: [], cfg: null, showSettings: false, helper: null };

async function load() {
  const accountId=S.accountId;
  const [sch, notes, cfg] = await Promise.all([
    api('GET', `/api/schedule?${acc()}`),
    api('GET', `/api/notes?${acc()}`),
    api('GET', `/api/automation?${acc()}`),
  ]);
  if(S.view!=='schedule'||accountId!==S.accountId)return false;
  V.items = sch.items;
  V.notes = notes.items;
  V.cfg = cfg;
  return true;
}

export async function render(main, params = {}) {
  const accountId=S.accountId;
  V.selected=params.id;
  if (V.accountId !== S.accountId) {
    V.accountId = S.accountId;
    V.helper = null;
  }
  main.innerHTML = '<div class="empty">加载中…</div>';
  try {
    if(!await load())return;
  } catch (err) {
    if(S.view==='schedule'&&accountId===S.accountId)main.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  if(S.view==='schedule'&&accountId===S.accountId)draw(main);
}

export async function onContent(ev) {
  if(draftBusy())return;
  if (!['schedule', 'notes', 'automation'].includes(ev.area)) return;
  // 用户正在填表时不打断
  const active = document.activeElement;
  if (active && active.closest && active.closest('#main form')) return;
  if(!await load())return;
  if(S.view==='schedule')draw($('#main'));
}

function badge(status) {
  const [label, cls] = STATUS[status] || [status, ''];
  return `<span class="badge ${cls}">${label}</span>`;
}

function nextHour() {
  const d = new Date(Date.now() + 3600_000);
  d.setMinutes(0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
}

function settingsHtml() {
  const p = V.cfg.publish;
  return `<div class="card" style="margin-bottom:16px;max-width:640px">
    <h3 style="margin-top:0">发布设置（当前账号）</h3>
    <form class="form" id="publish-settings">
      <label>默认发布方式
        <select name="defaultMode">${opt('remind', '到点提醒我手动发布（推荐）', p.defaultMode)}${opt('auto', 'agent 控制浏览器自动发布', p.defaultMode)}</select>
      </label>
      <div class="row" style="align-items:stretch">
        <label style="flex:1">每天最多发布（篇）<input type="text" name="dailyLimit" value="${esc(p.dailyLimit)}"></label>
        <label style="flex:1">两次发布至少间隔（分钟）<input type="text" name="minIntervalMin" value="${esc(p.minIntervalMin)}"></label>
      </div>
      <p class="muted" style="margin:0;font-size:12px">自动发布需要你的 agent 具备浏览器控制能力，并在它打开的浏览器里登录过小红书创作者中心，详见「连接与设置」。频率限制用来避免触发平台风控。</p>
      <div class="row"><button class="btn primary" type="submit">保存设置</button><button class="btn ghost" type="button" data-act="toggle-settings">收起</button></div>
    </form>
  </div>`;
}

function weekHtml() {
  const days = [];
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  for (let i = 0; i < 7; i++) days.push(new Date(start.getTime() + i * 86400_000));
  const names = ['日', '一', '二', '三', '四', '五', '六'];
  return `<div class="week">${days
    .map((d, i) => {
      const items = V.items.filter((s) => s.status !== 'cancelled' && new Date(s.publishedAt || s.publishAt).toDateString() === d.toDateString());
      return `<div class="week-day${i === 0 ? ' today' : ''}">
        <div class="week-head">${i === 0 ? '今天' : `周${names[d.getDay()]}`}<span class="muted">${d.getMonth() + 1}/${d.getDate()}</span></div>
        ${items.map((s) => `<div class="week-item ${s.status}" title="${esc(s.title)}"><span>${fmtTime(s.publishedAt || s.publishAt).slice(-5)}</span> ${esc(s.title)}</div>`).join('') || '<div class="muted week-empty">—</div>'}
      </div>`;
    })
    .join('')}</div>`;
}

function helperHtml(s) {
  const n = V.notes.find((x) => x.id === s.noteId);
  return `<div class="helper">
    <div class="helper-steps">
      <div><strong>① 复制内容</strong>
        <div class="row" style="margin-top:6px">
          <button class="btn small" data-copy="title" data-note="${esc(s.noteId)}">复制标题</button>
          <button class="btn small" data-copy="body" data-note="${esc(s.noteId)}">复制正文 + 话题</button>
          <a class="btn small" href="/api/notes/bundle?${acc(`id=${encodeURIComponent(s.noteId)}`)}&t=${encodeURIComponent(S.token)}">下载全部素材（封面 + 配图 + 实况视频）</a>
          ${n && !n.hasCover ? '<span class="muted">（这篇还没有模板封面）</span>' : ''}
        </div>
      </div>
      <div><strong>② 去发布</strong>
        <div class="row" style="margin-top:6px"><a class="btn small primary" href="${CREATOR_URL}" target="_blank" rel="noopener">打开小红书创作者中心 ↗</a></div>
      </div>
      <div><strong>③ 发布后回填链接</strong>
        <form class="row" data-published="${esc(s.id)}" style="margin-top:6px">
          <input type="text" name="url" placeholder="笔记链接（可选，方便后续抓数据）" style="flex:1;min-width:200px">
          <button class="btn small primary" type="submit">我已发布</button>
        </form>
      </div>
    </div>
  </div>`;
}

function attentionCard(s) {
  const open = V.helper === s.id || s.status === 'due';
  return `<div class="card attention ${s.status}">
    <div class="row">
      ${badge(s.status)}<strong>${esc(s.title)}</strong>
      <span class="muted" style="font-size:12px">计划 ${fmtTime(s.publishAt)} · ${MODE[s.mode] || s.mode}</span>
      <div class="spacer"></div>
      ${s.status !== 'due' ? `<button class="btn small" data-act="helper" data-id="${esc(s.id)}">手动发布</button>` : ''}
      <button class="btn small" data-act="agent-now" data-id="${esc(s.id)}">让 agent 现在发布</button>
      ${['failed', 'missed', 'check'].includes(s.status) ? `<button class="btn small" data-act="retry" data-id="${esc(s.id)}">重新排期</button>` : ''}
      <button class="btn small ghost" data-act="cancel" data-id="${esc(s.id)}">取消</button>
    </div>
    ${s.error ? `<div class="error-line">${esc(s.error)}</div>` : ''}
    ${open ? helperHtml(s) : ''}
  </div>`;
}

function draw(main) {
  const scheduledNoteIds = new Set(V.items.filter((s) => ['scheduled', 'due', 'running', 'check'].includes(s.status)).map((s) => s.noteId));
  const candidates = V.notes.filter((n) => n.status !== 'published' && !scheduledNoteIds.has(n.id));
  const attention = V.items.filter((s) => s.mode!=='draft'&&!s.nonExecuting&&ATTENTION.includes(s.status));
  const rows = [...V.items].reverse();

  if(S.view!=='schedule')return;
  main.innerHTML = `
    <div class="row page-head">
      <div><h1 class="page-title">${icon("calendar")} 发布排期</h1><div class="muted">安排好发布时间，到点提醒你手动发，或交给 agent 自动发。</div></div>
      <div class="spacer"></div>
      <button class="btn" data-act="toggle-settings">${icon("sliders")} 发布设置</button>
    </div>
    ${V.showSettings ? settingsHtml() : ''}
    ${attention.length ? `<h3 class="section-title">需要处理（${attention.length}）</h3>${attention.map(attentionCard).join('')}` : ''}
    <div class="card" id="draft-panel" style="margin:16px 0"></div>
    <details><summary>正式发布排期（会提醒或执行发布）</summary><div class="card" style="margin:16px 0">
      <h3 style="margin-top:0">安排发布</h3>
      ${candidates.length ? `<form class="row" id="schedule-form" style="align-items:flex-end">
        <label class="stack" style="flex:2;min-width:200px">笔记<select name="noteId">${candidates.map((n) => opt(n.id, `${n.title || '（无标题）'}${n.hasCover ? '' : '（无封面）'}`, '')).join('')}</select></label>
        <label class="stack" style="flex:1;min-width:180px">发布时间<input type="datetime-local" name="publishAt" value="${nextHour()}"></label>
        <label class="stack" style="flex:1;min-width:150px">方式<select name="mode">${opt('remind', MODE.remind, V.cfg.publish.defaultMode)}${opt('auto', MODE.auto, V.cfg.publish.defaultMode)}</select></label>
        <button class="btn primary" type="submit">加入排期</button>
      </form>` : '<div class="muted">没有可以排期的笔记。先去「文案」写一篇吧。</div>'}
    </div>
    </details><h3 class="section-title">未来 7 天</h3>
    ${weekHtml()}
    <h3 class="section-title">全部排期</h3>
    ${rows.length ? `<div class="card table-wrap" style="padding:0"><table class="data-table">
      <thead><tr><th>计划时间</th><th>笔记</th><th>方式</th><th>状态</th><th></th></tr></thead>
      <tbody>${rows.map((s) => `<tr>
        <td>${fmtTime(s.publishAt)}</td>
        <td>${s.publishedUrl ? `<a href="${esc(s.publishedUrl)}" target="_blank" rel="noopener">${esc(s.title)}</a>` : esc(s.title)}</td>
        <td>${MODE[s.mode] || esc(s.mode)}</td>
        <td>${badge(s.status)}</td>
        <td class="row-actions">${s.mode!=='draft'&&!s.nonExecuting&&s.status === 'scheduled' ? `<button class="btn small ghost" data-act="retime" data-id="${esc(s.id)}">改时间</button><button class="btn small ghost" data-act="switch-mode" data-id="${esc(s.id)}">改为${s.mode === 'auto' ? '提醒' : '自动'}</button><button class="btn small ghost" data-act="cancel" data-id="${esc(s.id)}">取消</button>` : ''}
          ${['published', 'cancelled'].includes(s.status) ? `<button class="btn small ghost danger" data-act="delete" data-id="${esc(s.id)}">删除</button>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>` : '<div class="muted">还没有排期。</div>'}`;
  if(main._draftUpdated)main.removeEventListener('draft-updated',main._draftUpdated);
  main._draftUpdated=async()=>{const account=S.accountId;if(!await load())return;if(S.view==='schedule'&&account===S.accountId&&!draftBusy())draw(main);};
  main.addEventListener('draft-updated',main._draftUpdated);
  bind(main);
  renderDraft(main.querySelector('#draft-panel'),V.notes,V.items,V.selected);
  V.selected=null;
}

async function update(data) {
  try {
    await api('POST', `/api/schedule/update?${acc()}`, data);
    await load();
    draw($('#main'));
  } catch (err) {
    toast(err.message);
  }
}

// 剪贴板接口不可用（页面未聚焦、非安全上下文）时退回到 execCommand
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('浏览器不允许复制');
  }
}

async function copyNote(noteId, what) {
  try {
    const n = await api('GET', `/api/notes/detail?${acc(`id=${noteId}`)}`);
    const text = what === 'title' ? n.title || '' : `${(n.content || '').trim()}\n\n${(n.tags || []).map((t) => `#${t}`).join(' ')}`.trim();
    await copyText(text);
    toast(what === 'title' ? '标题已复制' : '正文和话题已复制');
  } catch (err) {
    toast(`复制失败：${err.message}`);
  }
}

function bind(main) {
  main.onclick = async (e) => {
    const t = e.target.closest('[data-act],[data-copy]');
    if (!t) return;
    if (t.dataset.copy) return copyNote(t.dataset.note, t.dataset.copy);
    const s = V.items.find((x) => x.id === t.dataset.id);
    switch (t.dataset.act) {
      case 'toggle-settings':
        V.showSettings = !V.showSettings;
        return draw(main);
      case 'helper':
        V.helper = V.helper === s.id ? null : s.id;
        return draw(main);
      case 'agent-now':
        return ask(`请按 playbooks/publish.md 现在发布笔记 ${s.noteId}（文件在 ${accDirRel()}/notes/${s.noteId}/），排期 id：${s.id}。完成后更新 ${accDirRel()}/schedule.json 中该条目的状态。`, true);
      case 'retry':
        return update({ id: s.id, status: 'scheduled' });
      case 'cancel':
        if (!confirm(`取消「${s.title}」的排期？`)) return;
        return update({ id: s.id, status: 'cancelled' });
      case 'switch-mode':
        return update({ id: s.id, mode: s.mode === 'auto' ? 'remind' : 'auto' });
      case 'retime': {
        const v = prompt('新的发布时间（格式：2026-10-20 20:00）', fmtTime(s.publishAt));
        if (!v) return;
        const full = /^\d{4}-/.test(v) ? v : `${new Date().getFullYear()}-${v}`;
        return update({ id: s.id, publishAt: new Date(full.replace(' ', 'T')).toISOString() });
      }
      case 'delete':
        await api('DELETE', `/api/schedule?${acc(`id=${s.id}`)}`).catch((err) => toast(err.message));
        await load();
        return draw(main);
    }
  };

  main.onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    const data = Object.fromEntries(new FormData(form));
    try {
      if (form.id === 'schedule-form') {
        await api('POST', `/api/schedule?${acc()}`, { ...data, publishAt: new Date(data.publishAt).toISOString() });
        toast('已加入排期');
      } else if (form.id === 'publish-settings') {
        await api('POST', `/api/automation?${acc()}`, { publish: data });
        toast('设置已保存');
      } else if (form.dataset.published) {
        await api('POST', `/api/schedule/update?${acc()}`, { id: form.dataset.published, status: 'published', publishedUrl: data.url.trim() });
        V.helper = null;
        toast('已标记为发布');
      }
      await load();
      draw(main);
    } catch (err) {
      toast(err.message);
    }
  };
}
