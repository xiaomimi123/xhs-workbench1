// 选题热点：选题池（agent 生成 / 手动添加）→ 打分排序 → 一键写成笔记
import { esc } from '../md.js';
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

const V = { items: [], filter: 'active', form: null };

async function load() {
  V.items = (await api('GET', `/api/topics?${acc()}`)).items;
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
    <div class="score ${scoreClass(score)}" title="综合评分">${score || '–'}</div>
    <div class="topic-body">
      <div class="topic-title">${esc(t.title)}</div>
      ${t.angle ? `<div class="topic-angle">${esc(t.angle)}</div>` : ''}
      <div class="row topic-meta">
        ${keywords.map((k) => `<span class="badge">${esc(k)}</span>`).join('')}
        ${t.source ? `<span class="muted">来源：${esc(t.source)}</span>` : ''}
        ${subs}
      </div>
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
      <div><h1 class="page-title">🔥 选题热点</h1><div class="muted">agent 结合热点、对标拆解和你的账号定位生成选题并打分，选中后一键写成笔记。</div></div>
      <div class="spacer"></div>
      <button class="btn" data-act="hot">让 agent 找热点选题</button>
      <button class="btn" data-act="add">手动添加</button>
    </div>
    ${V.form ? formHtml(V.form) : ''}
    <div class="chips">
      ${filters.map(([id, name]) => `<button class="chip${V.filter === id ? ' active' : ''}" data-filter="${id}">${name}${counts[id] !== undefined ? ` ${counts[id]}` : ''}</button>`).join('')}
    </div>
    ${list.length ? `<div class="topic-list">${list.map(topicCard).join('')}</div>` : `<div class="card empty-card">
      <p>${V.items.length ? '这个分类下没有选题。' : '选题池还是空的。'}</p>
      <p class="muted">点「让 agent 找热点选题」，或者先去「竞品对标」拆解几个账号，再从拆解结果生成选题。</p>
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
    const note = await api('POST', `/api/notes?${acc()}`, { create: true, title: topic.title.slice(0, 20), topicId: topic.id });
    go('copywriting', { id: note.id });
    ask(
      `请按 playbooks/copywriting.md 把选题写成一篇小红书笔记。选题：「${topic.title}」${topic.angle ? `，切入角度：${topic.angle}` : ''}（选题 id：${topic.id}）。` +
        `笔记已建好，id：${note.id}，文件在 ${accDirRel()}/notes/${note.id}/，写好后更新 meta.json 和 content.md。`,
      true,
    );
  } catch (err) {
    toast(err.message);
  }
}

function bind(main) {
  main.onclick = async (e) => {
    const t = e.target.closest('[data-act],[data-filter],[data-write],[data-open-note],[data-edit],[data-del]');
    if (!t) return;
    const find = (id) => V.items.find((x) => x.id === id);
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
