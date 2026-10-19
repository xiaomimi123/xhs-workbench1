// 选题热点：选题池（agent 生成 / 手动添加）→ 打分排序 → 一键写成笔记
import { esc } from '../md.js';
import { icon } from '../icons.js';
import { S, $, api, acc, toast, ask, go, opt, accDirRel } from '../core.js';

const STATUSES = [
  ['idea', '候选'],
  ['selected', '已选中'],
  ['writing', '写作中'],
  ['done', '已完成'],
  ['discarded', '已放弃'],
];
const STATUS_NAME = Object.fromEntries(STATUSES);
const SCORE_NAMES = { heat: '热度', fit: '契合度', competition: '竞争空间', ease: '易产出' };

const V = { items: [], jobs: [], sources: [], filter: 'active', form: null };

async function load() {
  const data=await api('GET', `/api/topics?${acc()}`);
  V.items=data.items; V.jobs=data.jobs||[]; V.sources=data.sources||[];
}

export async function render(main) {
  if (V.accountId !== S.accountId) {
    V.accountId = S.accountId;
    V.form = null;
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

export async function onContent(ev) {
  if (ev.area !== 'topics' || V.form) return;
  await load();
  draw($('#main'));
}

function visible() {
  const list = V.items.filter((t) => (V.filter === 'all' ? true : V.filter === 'active' ? !['done', 'discarded'].includes(t.status) : t.status === V.filter));
  return list.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
}

function scoreClass(n) {
  return n >= 80 ? 'hi' : n >= 60 ? 'mid' : 'lo';
}

function topicCard(t) {
  const score = Number(t.score) || 0;
  const subs = t.scores && typeof t.scores === 'object'
    ? Object.entries(t.scores).map(([k, v]) => `<span class="muted">${esc(SCORE_NAMES[k] || k)} ${esc(v)}</span>`).join(' · ')
    : '';
  const keywords = Array.isArray(t.keywords) ? t.keywords : String(t.keywords || '').split(/[,，]/).filter(Boolean);
  return `<div class="card topic${t.status === 'discarded' ? ' faded' : ''}">
    <div class="score ${scoreClass(score)}" title="综合评分">${score || '待评估'}</div>
    <div class="topic-body">
      <div class="topic-title">${esc(t.title)}</div>
      ${t.angle ? `<div class="topic-angle">${esc(t.angle)}</div>` : ''}
      <div class="row topic-meta">
        ${keywords.map((k) => `<span class="badge">${esc(k)}</span>`).join('')}
        ${t.source ? `<span class="muted">来源：${esc(t.source)}</span>` : ''}
        ${subs}
      </div>
      ${t.basis ? `<div class="muted">${t.basis==='review' ? '依据：复盘报告与冻结证据' : t.basis === 'analyzed' ? '依据：已完成的对标拆解' : '依据：已采集资料，尚未完成拆解'} · 实时热度未核实</div>` : ''}
      ${Array.isArray(t.sources) ? t.sources.map(ref => { let u; try { u = new URL(ref.url); } catch { return ''; } return u.protocol === 'https:' && u.hostname === 'www.xiaohongshu.com' ? `<a href="${esc(u.href)}" target="_blank" rel="noopener noreferrer">来源：${esc(ref.benchmarkName || '对标笔记')}</a>` : ''; }).join(' · ') : ''}
      ${t.reason ? `<div class="muted topic-reason">${esc(t.reason)}</div>` : ''}
    </div>
    <div class="topic-actions">
      <select data-status="${esc(t.id)}" aria-label="选题状态">${STATUSES.map(([v, n]) => opt(v, n, t.status || 'idea')).join('')}</select>
      ${t.noteId
        ? `<button class="btn small" data-open-note="${esc(t.noteId)}">打开笔记</button>`
        : `<button class="btn small primary" data-write="${esc(t.id)}">写成笔记</button>`}
      <div class="row" style="gap:4px">
        <button class="btn small ghost" data-edit="${esc(t.id)}">编辑</button>
        <button class="btn small ghost danger" data-del="${esc(t.id)}">删除</button>
      </div>
    </div>
  </div>`;
}

function draw(main) {
  const counts = Object.fromEntries(STATUSES.map(([s]) => [s, V.items.filter((t) => (t.status || 'idea') === s).length]));
  const filters = [['active', '进行中'], ...STATUSES, ['all', '全部']];
  const list = visible();
  main.innerHTML = `
    <div class="row page-head">
      <div><h1 class="page-title">${icon("flame")} 选题热点</h1><div class="muted">结合已采集资料与账号定位生成有来源的选题，区分资料观察与拆解结论，选中后一键写成草稿。</div></div>
      <div class="spacer"></div>
      <button class="btn" data-act="hot">让 agent 找热点选题</button>
      <button class="btn" data-act="add">手动添加</button>
    </div>
    <div class="card row" style="margin-bottom:16px;gap:12px">
      <label>从已采集对标生成 <select id="topic-source">${V.sources.map(b=>opt(b.id, `${b.name} · ${b.noteCount}篇 · ${b.basis==='analyzed'?'已拆解':'仅采集'}`, V.sourceId || V.sources[0]?.id)).join('')}</select></label>
      <button class="btn primary" data-act="generate" ${V.sources.length?'':'disabled'}>生成 3 个有来源的选题</button>
      <span class="muted">${V.sources.length?'复用本地资料，不重复抓取。未核实热度不打分。':'先采集至少一个对标账号的笔记。'}</span>
    </div>
    ${V.jobs.length ? `<div class="card" style="margin-bottom:16px"><h3>生成任务</h3>${V.jobs.slice(0,6).map(j=>`<div class="row" style="margin:10px 0"><span>${j.kind==='generate'?'生成选题':'写成笔记'} · ${{queued:'排队中',running:'处理中',done:'已完成',error:'未完成'}[j.status]||j.status}</span><span class="muted">${esc(j.error||j.progress||'等待 agent')}</span>${j.status==='error'?`<button class="btn small" data-retry="${esc(j.id)}">重试</button>`:''}${j.noteId?`<button class="btn small" data-open-note="${esc(j.noteId)}">打开草稿</button>`:''}</div>`).join('')}</div>`:''}
    ${V.form ? formHtml(V.form) : ''}
    <div class="chips">
      ${filters.map(([id, name]) => `<button class="chip${V.filter === id ? ' active' : ''}" data-filter="${id}">${name}${counts[id] !== undefined ? ` ${counts[id]}` : ''}</button>`).join('')}
    </div>
    ${list.length ? `<div class="topic-list">${list.map(topicCard).join('')}</div>` : `<div class="card empty-card">
      <p>${V.items.length ? '这个分类下没有选题。' : '选题池还是空的。'}</p>
      <p class="muted">已有对标资料时，可在上方直接生成选题；也可以手动添加或让 agent 找热点。</p>
    </div>`}`;
  bind(main);
}

function formHtml(f) {
  const kw = Array.isArray(f.keywords) ? f.keywords.join('，') : f.keywords || '';
  return `<div class="card" style="margin-bottom:16px;max-width:640px">
    <h3 style="margin-top:0">${f.id ? '编辑选题' : '添加选题'}</h3>
    <form class="form" id="topic-form">
      <label>选题 *<input type="text" name="title" required value="${esc(f.title)}"></label>
      <label>切入角度<textarea name="angle" rows="2">${esc(f.angle)}</textarea></label>
      <label>关键词（逗号分隔）<input type="text" name="keywords" value="${esc(kw)}"></label>
      <label>综合评分（0-100，可留空）<input type="text" name="score" value="${esc(f.score ?? '')}"></label>
      <div class="row"><button class="btn primary" type="submit">保存</button><button class="btn ghost" type="button" data-act="cancel">取消</button></div>
    </form>
  </div>`;
}

async function writeNote(topic) {
  try {
    const job=await api('POST', `/api/topics/write?${acc()}`, {topicId:topic.id});
    if(job.status==='done')go('copywriting',{id:job.noteId});
    else toast(job.status==='error'?'此前任务未完成，请在任务列表重试':'写稿已排队，完成后打开草稿');
    await load(); if(S.view==='topics')draw($('#main'));
  } catch(err){toast(err.message);}
}

function bind(main) {
  main.onclick = async (e) => {
    const t = e.target.closest('[data-act],[data-filter],[data-write],[data-open-note],[data-edit],[data-del],[data-retry]');
    if (!t) return;
    const find = (id) => V.items.find((x) => x.id === id);
    if (t.dataset.retry) {
      try { await api('POST', `/api/topics/retry?${acc()}`, {id:t.dataset.retry}); await load(); draw(main); } catch(err){toast(err.message);} return;
    }
    if (t.dataset.filter) {
      V.filter = t.dataset.filter;
      return draw(main);
    }
    if (t.dataset.write) return writeNote(find(t.dataset.write));
    if (t.dataset.openNote) return go('copywriting', { id: t.dataset.openNote });
    if (t.dataset.edit) {
      V.form = { ...find(t.dataset.edit) };
      return draw(main);
    }
    if (t.dataset.del) {
      const topic = find(t.dataset.del);
      if (!confirm(`删除选题「${topic.title}」？`)) return;
      await api('DELETE', `/api/topics?${acc(`id=${topic.id}`)}`).catch((err) => toast(err.message));
      await load();
      return draw(main);
    }
    switch (t.dataset.act) {
      case 'generate':
        try { V.sourceId=main.querySelector('#topic-source')?.value; const job=await api('POST', `/api/topics/generate?${acc()}`, {benchmarkId:V.sourceId}); toast(job.status==='done'?'这批资料已生成选题，结果已在选题池':'任务已登记，可在下方查看进度'); await load(); draw(main); } catch(err){toast(err.message);} return;
      case 'hot':
        return ask(`请按 playbooks/topics.md，结合最近的热点和我的账号定位、知识库，生成 10 个选题并打分，写入选题池（${accDirRel()}/topics/topics.json）。`, true);
      case 'add':
        V.form = {};
        return draw(main);
      case 'cancel':
        V.form = null;
        return draw(main);
    }
  };

  main.onchange = async (e) => {
    const id = e.target.dataset.status;
    if (!id) return;
    try {
      await api('POST', `/api/topics?${acc()}`, { id, status: e.target.value });
      await load();
      draw(main);
    } catch (err) {
      toast(err.message);
    }
  };

  const form = $('#topic-form', main);
  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      data.keywords = data.keywords.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      data.score = data.score === '' ? undefined : Math.max(0, Math.min(100, Number(data.score) || 0));
      if (data.score === undefined) delete data.score;
      if (V.form.id) data.id = V.form.id;
      try {
        await api('POST', `/api/topics?${acc()}`, data);
        V.form = null;
        await load();
        draw(main);
        toast('已保存');
      } catch (err) {
        toast(err.message);
      }
    };
  }
}
