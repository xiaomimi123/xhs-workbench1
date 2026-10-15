// 封面配图：选模板 / 配色 / 文字 → 实时预览 → 保存为笔记封面。
// agent 只需把封面规格写进 meta.json 的 cover 或 coverOptions，工作台会自动渲染成 PNG。
import { esc } from '../md.js';
import { S, $, api, acc, fileUrl, toast, ask, go, opt, readFileAsDataURL, accDirRel } from '../core.js';
import { TEMPLATES, PALETTES, normalizeSpec, drawCover } from '../covers.js';

const V = { notes: [], note: null, spec: null, dirty: false };

function imageUrl(note, spec) {
  return spec.image ? fileUrl(`notes/${note.id}/images/${spec.image}`) : '';
}

// ---------- 后台自动渲染：agent 写了封面规格但还没有 PNG 时补上 ----------

let rendering = false;
let again = false;
export async function autoRender(ev) {
  if (ev && ev.area !== 'notes') return;
  if (!S.token || !S.accountId) return;
  if (rendering) {
    again = true;
    return;
  }
  rendering = true;
  try {
    const { items } = await api('GET', `/api/notes?${acc()}`);
    for (const n of items.filter((x) => x.coverStale)) {
      const canvas = document.createElement('canvas');
      await drawCover(canvas, n.cover, imageUrl(n, normalizeSpec(n.cover)));
      await api('POST', `/api/notes/cover?${acc()}`, { id: n.id, data: canvas.toDataURL('image/png'), hash: n.coverHash });
    }
  } catch (err) {
    console.warn('封面自动渲染失败', err);
  } finally {
    rendering = false;
    if (again) {
      again = false;
      autoRender();
    }
  }
}

// ---------- 面板 ----------

export function canLeave() {
  return !V.dirty || confirm('封面有未保存的修改，确定离开吗？');
}

async function loadNote(id) {
  V.note = id ? await api('GET', `/api/notes/detail?${acc(`id=${id}`)}`) : null;
  V.spec = V.note ? normalizeSpec(V.note.cover || { title: V.note.title }) : null;
  V.dirty = false;
}

export async function render(main, params = {}) {
  if (V.accountId !== S.accountId) {
    V.accountId = S.accountId;
    V.note = null;
  }
  main.innerHTML = '<div class="empty">加载中…</div>';
  try {
    V.notes = (await api('GET', `/api/notes?${acc()}`)).items;
    const id = params.id || (V.note && V.note.id) || (V.notes[0] && V.notes[0].id);
    await loadNote(V.notes.some((n) => n.id === id) ? id : null);
  } catch (err) {
    main.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  draw(main);
}

export async function onContent(ev) {
  if (ev.area !== 'notes') return;
  V.notes = (await api('GET', `/api/notes?${acc()}`)).items;
  if (!V.note) return;
  const fresh = await api('GET', `/api/notes/detail?${acc(`id=${V.note.id}`)}`).catch(() => null);
  if (!fresh) return;
  const optionsChanged = JSON.stringify(fresh.coverOptions) !== JSON.stringify(V.note.coverOptions);
  const imagesChanged = JSON.stringify(fresh.images) !== JSON.stringify(V.note.images);
  const specChanged = JSON.stringify(fresh.cover) !== JSON.stringify(V.note.cover);
  V.note = fresh;
  if (specChanged && !V.dirty) V.spec = normalizeSpec(fresh.cover || { title: fresh.title });
  if (optionsChanged || imagesChanged || (specChanged && !V.dirty)) draw($('#main'));
}

function formHtml(s, note) {
  const imgs = note.images || [];
  return `
    <div class="field-label">模板</div>
    <div class="tpl-grid">
      ${TEMPLATES.map((t) => `<button class="tpl${s.template === t.id ? ' active' : ''}" data-tpl="${t.id}"><strong>${t.name}</strong><span class="muted">${t.desc}</span></button>`).join('')}
    </div>
    <div class="field-label">配色</div>
    <div class="swatches">
      ${Object.entries(PALETTES).map(([id, p]) => `<button class="swatch${s.palette === id ? ' active' : ''}" data-palette="${id}" title="${p.name}" style="background:linear-gradient(135deg,${p.bg},${p.bg2})"><span style="background:${p.accent}"></span></button>`).join('')}
    </div>
    <form class="form cover-form" id="cover-form" onsubmit="return false">
      <label>标题（回车换行，控制断句）<textarea name="title" rows="3">${esc(s.title)}</textarea></label>
      <label>强调词（逗号分隔，会高亮显示）<input type="text" name="emphasis" value="${esc(s.emphasis.join('，'))}"></label>
      <label>副标题<input type="text" name="subtitle" value="${esc(s.subtitle)}"></label>
      <label>角标（如「干货」「第 3 期」）<input type="text" name="badge" value="${esc(s.badge)}"></label>
      ${s.template === 'list' ? `<label>清单要点（每行一条，最多 6 条）<textarea name="items" rows="5">${esc(s.items.join('\n'))}</textarea></label>` : ''}
      ${s.template === 'photo' ? `<div class="field-label" style="margin:0">背景图</div>
        <div class="row">
          <select name="image" style="flex:1" aria-label="背景图">${opt('', imgs.length ? '不使用图片' : '还没有图片', s.image)}${imgs.map((f) => opt(f, f, s.image)).join('')}</select>
          <label class="btn small upload-btn">上传图片<input type="file" accept="image/*" id="img-input" hidden></label>
        </div>` : ''}
    </form>`;
}

function draw(main) {
  if (!V.notes.length || !V.note) {
    main.innerHTML = `
      <div class="row page-head"><div><h1 class="page-title">🎨 封面配图</h1><div class="muted">封面跟着笔记走，先有笔记再做封面。</div></div></div>
      <div class="card empty-card"><p>还没有笔记。</p><button class="btn primary" data-act="to-copy">去写一篇笔记</button></div>`;
    main.onclick = (e) => e.target.closest('[data-act="to-copy"]') && go('copywriting');
    return;
  }
  const n = V.note;
  const s = V.spec;
  const options = (n.coverOptions || []).map(normalizeSpec);
  main.innerHTML = `
    <div class="row page-head">
      <div><h1 class="page-title">🎨 封面配图</h1><div class="muted">选模板、改文字，右侧实时预览；agent 出的方案也会出现在下方。</div></div>
      <div class="spacer"></div>
      <select id="cover-note" aria-label="选择笔记">${V.notes.map((x) => opt(x.id, x.title || '（无标题）', n.id)).join('')}</select>
    </div>
    <div class="cover-layout">
      <div class="card cover-side">${formHtml(s, n)}</div>
      <div class="cover-preview">
        <canvas id="cover-canvas" width="1080" height="1440"></canvas>
        <div class="row" style="justify-content:center;margin-top:10px">
          <button class="btn primary" data-act="save">保存为封面</button>
          <button class="btn" data-act="download">下载 PNG</button>
        </div>
        ${n.hasCover ? `<div class="muted" style="text-align:center;font-size:12px;margin-top:6px">${V.dirty ? '有未保存的修改' : n.coverStale ? '封面待渲染' : '✅ 已保存为当前封面'}</div>` : ''}
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="row">
        <h3 style="margin:0">封面方案</h3>
        <span class="muted">agent 设计的方案，点击即可套用</span>
        <div class="spacer"></div>
        <button class="btn small" data-act="ask-options">让 agent 出 3 个方案</button>
        <button class="btn small" data-act="ask-image">让 agent 生成配图</button>
      </div>
      ${options.length ? `<div class="option-grid">${options.map((o, i) => `<button class="option" data-option="${i}"><canvas data-opt-canvas="${i}"></canvas><span>${esc(TEMPLATES.find((t) => t.id === o.template)?.name || '')} · ${esc(PALETTES[o.palette].name)}</span></button>`).join('')}</div>` : '<div class="muted" style="margin-top:10px">还没有方案。</div>'}
    </div>`;
  redraw();
  options.forEach((o, i) => {
    const c = $(`[data-opt-canvas="${i}"]`, main);
    if (c) drawCover(c, o, imageUrl(n, o));
  });
  bind(main);
}

let redrawTimer;
function redraw() {
  clearTimeout(redrawTimer);
  redrawTimer = setTimeout(() => {
    const c = $('#cover-canvas');
    if (c && V.note) drawCover(c, V.spec, imageUrl(V.note, V.spec));
  }, 80);
}

function readForm() {
  const form = $('#cover-form');
  if (!form) return;
  const d = Object.fromEntries(new FormData(form));
  Object.assign(V.spec, normalizeSpec({ ...V.spec, ...d, items: d.items !== undefined ? d.items : V.spec.items }));
  V.dirty = true;
}

async function save() {
  const n = V.note;
  try {
    const spec = { ...V.spec };
    const saved = await api('POST', `/api/notes?${acc()}`, { id: n.id, cover: spec });
    const canvas = document.createElement('canvas');
    await drawCover(canvas, spec, imageUrl(n, spec));
    await api('POST', `/api/notes/cover?${acc()}`, { id: n.id, data: canvas.toDataURL('image/png'), hash: saved.coverHash });
    V.dirty = false;
    V.note = await api('GET', `/api/notes/detail?${acc(`id=${n.id}`)}`);
    toast('封面已保存');
    draw($('#main'));
  } catch (err) {
    toast(err.message);
  }
}

function bind(main) {
  main.onclick = async (e) => {
    const t = e.target.closest('[data-tpl],[data-palette],[data-act],[data-option]');
    if (!t) return;
    if (t.dataset.tpl || t.dataset.palette) {
      readForm();
      if (t.dataset.tpl) V.spec.template = t.dataset.tpl;
      else V.spec.palette = t.dataset.palette;
      V.dirty = true;
      return draw(main);
    }
    if (t.dataset.option) {
      V.spec = normalizeSpec(V.note.coverOptions[Number(t.dataset.option)]);
      V.dirty = true;
      return draw(main);
    }
    const ref = `笔记 ${V.note.id}（文件在 ${accDirRel()}/notes/${V.note.id}/）`;
    switch (t.dataset.act) {
      case 'save':
        readForm();
        return save();
      case 'download': {
        const a = document.createElement('a');
        a.download = `${V.note.title || V.note.id}-封面.png`;
        a.href = $('#cover-canvas').toDataURL('image/png');
        return a.click();
      }
      case 'ask-options':
        return ask(`请按 playbooks/cover.md 为${ref}设计 3 个风格不同的封面方案，写入 meta.json 的 coverOptions。`, true);
      case 'ask-image':
        return ask(`请为${ref}生成一张配图，保存到 images/ 目录（需要你具备生图或找图能力；做不到请告诉我）。图片要求：`);
    }
  };

  main.oninput = (e) => {
    if (e.target.closest('#cover-form')) {
      readForm();
      redraw();
    }
  };

  main.onchange = async (e) => {
    if (e.target.id === 'cover-note') {
      if (!canLeave()) {
        e.target.value = V.note.id;
        return;
      }
      await loadNote(e.target.value);
      return draw(main);
    }
    if (e.target.id === 'img-input') {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const { name } = await api('POST', `/api/notes/upload?${acc()}`, { id: V.note.id, filename: file.name, data: await readFileAsDataURL(file) });
        readForm();
        V.spec.image = name;
        V.note.images = [...(V.note.images || []), name];
        return draw(main);
      } catch (err) {
        toast(err.message);
      }
    }
    if (e.target.name === 'image') {
      readForm();
      redraw();
    }
  };
}

