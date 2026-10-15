// 文案：笔记列表 + 编辑器（标题 / 正文 / 话题），实时字数与违禁词检查，手机预览，一键让 agent 写 / 改
import { esc } from '../md.js';
import { S, $, api, acc, fileUrl, toast, fmtTime, ask, go, opt, accDirRel } from '../core.js';
import { lint, LIMITS } from '../lint.js';
import { mediaHtml, bindMedia } from './media.js';

export const NOTE_STATUSES = [
  ['draft', '草稿'],
  ['ready', '待发布'],
  ['published', '已发布'],
];
const STATUS_NAME = Object.fromEntries(NOTE_STATUSES);

const V = { items: [], current: null, note: null, dirty: false, preview: false, filter: 'all' };

async function loadList() {
  V.items = (await api('GET', `/api/notes?${acc()}`)).items;
}

async function loadNote(id) {
  V.note = id ? await api('GET', `/api/notes/detail?${acc(`id=${id}`)}`) : null;
  V.current = V.note ? V.note.id : null;
  V.dirty = false;
}

export function canLeave() {
  return !V.dirty || confirm('笔记有未保存的修改，确定离开吗？');
}

export async function render(main, params = {}) {
  if (V.accountId !== S.accountId) {
    V.accountId = S.accountId;
    V.current = null;
    V.note = null;
  }
  main.innerHTML = '<div class="empty">加载中…</div>';
  try {
    await loadList();
    const id = params.id || V.current || (V.items[0] && V.items[0].id);
    await loadNote(V.items.some((n) => n.id === id) ? id : null);
  } catch (err) {
    main.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  draw(main);
}

export async function onContent(ev) {
  if (ev.area !== 'notes') return;
  await loadList();
  // 正在编辑时不覆盖用户的输入，只刷新列表
  if (!V.dirty && V.current) await loadNote(V.items.some((n) => n.id === V.current) ? V.current : null);
  if (V.dirty) drawList();
  else draw($('#main'));
}

function readEditor() {
  const main = $('#main');
  return {
    title: $('#note-title', main).value.trim(),
    content: $('#note-body', main).value,
    tags: $('#note-tags', main).value.split(/[#,，\s]+/).map((s) => s.trim()).filter(Boolean),
    status: $('#note-status', main).value,
    visibility: $('#note-visibility', main).value,
  };
}

function drawList() {
  const box = $('#note-list');
  if (!box) return;
  const items = V.items.filter((n) => V.filter === 'all' || n.status === V.filter);
  box.innerHTML = items.length
    ? items.map((n) => `<button class="note-item${n.id === V.current ? ' active' : ''}" data-note="${esc(n.id)}">
        ${n.video && !n.hasCover ? '<span class="note-thumb">🎬</span>' : n.hasCover ? `<img src="${fileUrl(`notes/${n.id}/cover.png`, n.coverHash)}" alt="">` : '<span class="note-thumb">📝</span>'}
        <span class="note-item-text"><span class="note-item-title">${esc(n.title || '（无标题）')}</span>
        <span class="muted">${STATUS_NAME[n.status] || n.status} · ${n.video ? '视频 · ' : ''}${fmtTime(n.updatedAt)}</span></span>
      </button>`).join('')
    : '<div class="empty">还没有笔记</div>';
}

function lintHtml(data) {
  const { issues, titleLen, bodyLen } = lint({ title: data.title, body: data.content, tags: data.tags });
  const counter = `<div class="row counters">
      <span class="${titleLen > LIMITS.title ? 'bad' : ''}">标题 ${titleLen}/${LIMITS.title}</span>
      <span class="${bodyLen > LIMITS.body ? 'bad' : ''}">正文 ${bodyLen}/${LIMITS.body}</span>
      <span>话题 ${data.tags.length}</span>
    </div>`;
  const list = issues.length
    ? `<ul class="issues">${issues.map((i) => `<li class="${i.level}"><strong>${esc(i.where)}</strong> ${i.word ? `出现「${esc(i.word)}」（${esc(i.category)}）：` : ''}${esc(i.tip)}</li>`).join('')}</ul>`
    : '<div class="ok-line">✅ 没有发现字数超限或常见违禁词</div>';
  return counter + list;
}

function previewHtml(data) {
  const n = V.note;
  const first = n.media && n.media[0] && /\.(png|jpe?g|webp|gif)$/i.test(n.media[0].file) ? n.media[0].file : null;
  const total = n.video ? 1 : (n.media ? n.media.length : 0) + (n.coverMode !== 'first' && n.hasCover ? 1 : 0);
  const cover = n.video
    ? n.video.cover
      ? `<img class="phone-cover" src="${fileUrl(`notes/${n.id}/images/${n.video.cover}`, n.updatedAt)}" alt="">`
      : n.hasCover && n.coverMode !== 'first'
        ? `<img class="phone-cover" src="${fileUrl(`notes/${n.id}/cover.png`, n.coverHash)}" alt="">`
        : '<div class="phone-cover placeholder">🎬 视频首帧</div>'
    : n.coverMode === 'first' && first
      ? `<img class="phone-cover" src="${fileUrl(`notes/${n.id}/images/${first}`, n.updatedAt)}" alt="">`
      : n.hasCover
        ? `<img class="phone-cover" src="${fileUrl(`notes/${n.id}/cover.png`, n.coverHash)}" alt="">`
        : '<div class="phone-cover placeholder">还没有封面</div>';
  return `<div class="phone">
    ${cover}
    <div class="phone-body">
      ${total > 1 ? `<div class="phone-dots">${'<span></span>'.repeat(Math.min(total, 18))}</div>` : ''}
      <div class="phone-title">${esc(data.title || '（无标题）')}</div>
      <div class="phone-text">${esc(data.content)}</div>
      <div class="phone-tags">${data.tags.map((t) => `#${esc(t)}`).join(' ')}</div>
    </div>
  </div>`;
}

function draw(main) {
  const filters = [['all', '全部'], ...NOTE_STATUSES];
  const n = V.note;
  let editor;
  if (!n) {
    editor = `<div class="card empty-card"><p>选择左侧的笔记，或者新建一篇。</p><p class="muted">也可以去「选题热点」选中一个选题，点「写成笔记」让 agent 直接写好。</p></div>`;
  } else {
    const data = { title: n.title || '', content: n.content || '', tags: n.tags || [], status: n.status };
    editor = `
      <div class="card note-editor">
        <div class="row">
          <select id="note-status" aria-label="状态">${NOTE_STATUSES.map(([v, name]) => opt(v, name, n.status)).join('')}</select>
          <select id="note-visibility" aria-label="可见范围">${opt('public', '公开', n.visibility || 'public')}${opt('private', '仅自己可见', n.visibility || 'public')}</select>
          <span class="muted" style="font-size:12px">${esc(n.id)} · 更新于 ${fmtTime(n.updatedAt)}</span>
          <div class="spacer"></div>
          <button class="btn small" data-act="preview">${V.preview ? '编辑' : '手机预览'}</button>
          <button class="btn small primary" data-act="save">保存</button>
        </div>
        ${V.preview ? previewHtml(data) : `
        <label class="field">标题
          <input type="text" id="note-title" value="${esc(data.title)}" placeholder="不超过 20 字">
        </label>
        ${n.titleOptions && n.titleOptions.length ? `<div class="chips title-options"><span class="muted">备选标题：</span>${n.titleOptions.map((t) => `<button class="chip" data-title="${esc(t)}">${esc(t)}</button>`).join('')}</div>` : ''}
        <label class="field">正文
          <textarea id="note-body" rows="16" placeholder="不超过 1000 字">${esc(data.content)}</textarea>
        </label>
        <label class="field">话题标签（空格或逗号分隔，不用加 #）
          <input type="text" id="note-tags" value="${esc(data.tags.join(' '))}">
        </label>`}
        <div class="row" style="margin-top:12px">
          <button class="btn small" data-act="write">${data.content.trim() ? '让 agent 改写' : '让 agent 写正文'}</button>
          <button class="btn small" data-act="titles">生成标题备选</button>
          <button class="btn small" data-act="agent-check">让 agent 深度检查</button>
          <button class="btn small" data-act="cover">🎨 做封面</button>
          <div class="spacer"></div>
          <button class="btn small ghost danger" data-act="delete">删除</button>
        </div>
      </div>
      ${V.preview ? '' : `<div class="card lint-box" id="lint-box">${lintHtml(data)}</div>`}
      ${V.preview ? '' : mediaHtml(n)}`;
  }

  main.innerHTML = `
    <div class="row page-head">
      <div><h1 class="page-title">✍️ 文案</h1><div class="muted">agent 按知识库里的方法写稿，你在这里修改、检查、预览。</div></div>
      <div class="spacer"></div>
      <button class="btn primary" data-act="new">新建笔记</button>
    </div>
    <div class="split">
      <div class="card split-side">
        <div class="chips">${filters.map(([id, name]) => `<button class="chip${V.filter === id ? ' active' : ''}" data-filter="${id}">${name}</button>`).join('')}</div>
        <div id="note-list"></div>
      </div>
      <div class="split-main">${editor}</div>
    </div>`;
  drawList();
  bind(main);
  if (n && !V.preview) bindMedia($('#media-box', main), n, onMediaChange);
}

// 配图变化只重绘配图区，不覆盖编辑器里还没保存的文字
function onMediaChange(fresh) {
  if (!V.note || fresh.id !== V.note.id) return;
  for (const k of ['media', 'images', 'looseVideos', 'coverMode', 'hasCover', 'coverHash', 'coverStale', 'video', 'updatedAt']) V.note[k] = fresh[k];
  const box = $('#media-box');
  if (!box) return;
  box.outerHTML = mediaHtml(V.note);
  bindMedia($('#media-box'), V.note, onMediaChange);
  loadList().then(drawList);
}

async function save(silent) {
  if (!V.note) return;
  const data = V.preview
    ? { title: V.note.title, content: V.note.content, tags: V.note.tags, status: $('#note-status').value, visibility: $('#note-visibility').value }
    : readEditor();
  try {
    V.note = await api('POST', `/api/notes?${acc()}`, { id: V.note.id, ...data });
    V.dirty = false;
    await loadList();
    if (!silent) toast('已保存');
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  }
}

function noteRef() {
  return `笔记 ${V.note.id}（文件在 ${accDirRel()}/notes/${V.note.id}/）`;
}

function bind(main) {
  main.onclick = async (e) => {
    const t = e.target.closest('[data-act],[data-note],[data-filter],[data-title]');
    if (!t) return;
    if (t.dataset.note) {
      if (t.dataset.note === V.current || !canLeave()) return;
      await loadNote(t.dataset.note);
      return draw(main);
    }
    if (t.dataset.filter) {
      V.filter = t.dataset.filter;
      return drawList();
    }
    if (t.dataset.title) {
      $('#note-title', main).value = t.dataset.title;
      V.dirty = true;
      return refreshLint();
    }
    switch (t.dataset.act) {
      case 'new': {
        if (!canLeave()) return;
        const note = await api('POST', `/api/notes?${acc()}`, { create: true, title: '' }).catch((err) => toast(err.message));
        if (!note) return;
        await loadList();
        await loadNote(note.id);
        return draw(main);
      }
      case 'save':
        await save();
        return draw(main);
      case 'preview':
        if (!V.preview) {
          Object.assign(V.note, readEditor());
        }
        V.preview = !V.preview;
        return draw(main);
      case 'write':
        if (!(await save(true))) return;
        if (V.note.content.trim()) return ask(`请按 playbooks/copywriting.md 改写${noteRef()}的正文，要求：`);
        return ask(`请按 playbooks/copywriting.md 为${noteRef()}写正文。${V.note.title ? `当前标题：「${V.note.title}」。` : ''}写好后更新 content.md，并在 meta.json 补充 titleOptions 和 tags。`, true);
      case 'titles':
        if (!(await save(true))) return;
        return ask(`请按 playbooks/copywriting.md 为${noteRef()}生成 5 个标题备选（每个不超过 20 字），写入 meta.json 的 titleOptions，不要改正文。`, true);
      case 'agent-check':
        if (!(await save(true))) return;
        return ask(`请按 playbooks/copywriting.md 的「发布前检查」逐项检查${noteRef()}，列出问题和修改建议，先不要直接改文件。`, true);
      case 'cover':
        if (!(await save(true))) return;
        return go('cover', { id: V.note.id });
      case 'delete':
        if (!confirm(`删除笔记「${V.note.title || V.note.id}」？（会移到回收站）`)) return;
        await api('DELETE', `/api/notes?${acc(`id=${V.note.id}`)}`).catch((err) => toast(err.message));
        V.dirty = false;
        await loadList();
        await loadNote(V.items[0] && V.items[0].id);
        return draw(main);
    }
  };

  main.oninput = (e) => {
    if (['note-title', 'note-body', 'note-tags'].includes(e.target.id)) {
      V.dirty = true;
      refreshLint();
    }
  };
  main.onchange = (e) => {
    if (e.target.id === 'note-status' || e.target.id === 'note-visibility') V.dirty = true;
  };
}

let lintTimer;
function refreshLint() {
  clearTimeout(lintTimer);
  lintTimer = setTimeout(() => {
    const box = $('#lint-box');
    if (box && $('#note-title')) box.innerHTML = lintHtml(readEditor());
  }, 150);
}

