// 封面配图：选模板 / 配色 / 文字 → 实时预览 → 保存为笔记封面。
// 受控任务校验封面与卡片规格，浏览器渲染并保存 PNG；旧式 cover 自动渲染兼容。
import { esc } from '../md.js';
import { icon } from '../icons.js';
import { S, $, api, acc, fileUrl, toast, ask, go, opt, readFileAsDataURL, accDirRel } from '../core.js';
import { mediaHtml, bindMedia } from './media.js';
import { TEMPLATES, PALETTES, normalizeSpec, drawCover } from '../covers.js';

const V = { notes: [], note: null, spec: null, dirty: false, revision: 0, jobs: [], state: null, editCard: null };

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
  const account=S.accountId, query=`account=${encodeURIComponent(account)}`;
  try {
    const { items } = await api('GET', `/api/notes?${query}`);
    for (const n of items.filter((x) => x.coverStale)) {
      if(S.accountId!==account)break;
      const canvas = document.createElement('canvas');
      await drawCover(canvas, n.cover, imageUrl(n, normalizeSpec(n.cover)));
      await api('POST', `/api/notes/cover?${query}`, { id: n.id, data: canvas.toDataURL('image/png'), hash: n.coverHash });
    }
    const {items:jobs}=await api('GET',`/api/covers/jobs?${query}`);
    for(const job of jobs.filter(j=>j.status==='ready'&&!j.stale)) {
      try {
        for(let i=0;i<3;i++) {
          if(S.accountId!==account)break;
          if(job.files[i])continue;
          const canvas=document.createElement('canvas');await drawCover(canvas,job.specs[i]);
          await api('POST',`/api/covers/render?${query}`,{id:job.id,index:i,spec:job.specs[i],expectedSpec:job.specHashes[i],data:canvas.toDataURL('image/png')});
        }
      }catch(err){await api('POST',`/api/covers/render-error?${query}`,{id:job.id,error:err.message}).catch(()=>{});}
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

async function loadNote(id, guard=false) {
  const account=S.accountId,revision=V.revision;
  const note=id?await api('GET',`/api/notes/detail?${acc(`id=${id}`)}`):null;
  const state=id?await api('GET',`/api/covers/state?account=${encodeURIComponent(account)}&noteId=${encodeURIComponent(id)}`):null;
  if(S.view!=='cover'||account!==S.accountId||guard&&(revision!==V.revision||V.note?.id!==id))return false;
  V.note=note;V.state=state;V.jobs=state?.jobs||[];V.spec=note?normalizeSpec(note.cover||{title:note.title}):null;V.dirty=false;V.editCard=null;
  return true;
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
  if(ev.area!=='notes'||!V.note)return;
  const account=S.accountId,id=V.note.id,revision=V.revision;
  const notes=(await api('GET',`/api/notes?${acc()}`)).items;
  const state=await api('GET',`/api/covers/state?account=${encodeURIComponent(account)}&noteId=${encodeURIComponent(id)}`).catch(()=>null);
  if(S.view!=='cover'||account!==S.accountId||V.note?.id!==id||!state)return;
  V.jobs=state.jobs;V.notes=notes;
  if(V.dirty||V.editCard||revision!==V.revision){const panel=$('#cover-jobs');if(panel)panel.innerHTML=jobsHtml();return;}
  if(await loadNote(id,true)&&S.view==='cover')draw($('#main'));
}
function jobsHtml(){
 return V.jobs.slice(0,8).map(j=>`<div class="card" style="margin-top:12px"><strong>${j.kind==='cards'?'内容卡片':'封面方案'} · ${{queued:'排队中',running:'设计中',ready:'待渲染',done:j.kind==='cards'?'PNG已保存':'方案已生成',error:'生成失败',render_error:'渲染失败'}[j.status]}</strong>
 <p class="muted">${esc(j.error||j.progress||'等待 agent')}${j.stale?' · 文案已修改，方案过期':''}</p>
 ${['error','render_error','ready'].includes(j.status)&&!j.stale?`<button class="btn small" data-retry="${esc(j.id)}">${j.status==='error'?'重试生成':'继续渲染'}</button>`:''}
 ${j.kind==='cards'&&j.specs?`<div class="option-grid">${j.specs.map((s,i)=>`<button class="option" data-card="${esc(j.id)}" data-index="${i}" ${j.stale?'disabled':''}>${j.files[i]?`<img style="width:100%" src="${fileUrl(`notes/${j.noteId}/images/${j.files[i]}`,j.specHashes[i])}" alt="${esc(s.title)}">`:''}<span>${i+1}. ${esc(s.title)} · 点击编辑</span></button>`).join('')}</div>`:''}</div>`).join('');
}
async function run(kind){
 const account=S.accountId,id=V.note.id;
 try{await api('POST',`/api/covers/run?${acc()}`,{noteId:id,kind});if(S.view==='cover'&&S.accountId===account&&V.note?.id===id){if(!V.dirty&&await loadNote(id,true))draw($('#main'));}autoRender();}catch(e){toast(e.message);}
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
      <div class="row page-head"><div><h1 class="page-title">${icon("palette")} 封面配图</h1><div class="muted">封面跟着笔记走，先有笔记再做封面。</div></div></div>
      <div class="card empty-card"><p>还没有笔记。</p><button class="btn primary" data-act="to-copy">去写一篇笔记</button></div>`;
    main.onclick = (e) => e.target.closest('[data-act="to-copy"]') && go('copywriting');
    return;
  }
  const n = V.note;
  const s = V.spec;
  const generated=V.jobs.find(j=>j.kind==='options'&&j.status==='done'&&!j.stale);
  const options=(generated?.specs||n.coverOptions||[]).map(normalizeSpec);
  V.options=options;
  main.innerHTML = `
    <div class="row page-head">
      <div><h1 class="page-title">${icon("palette")} 封面配图</h1><div class="muted">从当前草稿生成封面与内容卡片；模板排版，保存后可逐张预览。</div></div>
      <div class="spacer"></div>
      <select id="cover-note" aria-label="选择笔记">${V.notes.map((x) => opt(x.id, x.title || '（无标题）', n.id)).join('')}</select>
    </div>
    <div class="card"><strong>${esc(n.title)}</strong><p class="muted">${esc(n.content.slice(0,180))}</p><p class="muted">${(n.sources||[]).map(r=>esc(r.benchmarkName||'对标')).join('、')} · 文案保持不变，图片追加保存，不发布。</p>
    ${V.editCard?`<strong>正在编辑第 ${V.editCard.index+1} 张内容卡片</strong> <button class="btn small" data-act="back-cover">返回封面</button>`:''}
    <button class="btn small" data-act="schedule-draft">发布前检查</button><button class="btn small" data-act="preview-note">完整图文预览</button></div>
    <div class="cover-layout">
      <div class="card cover-side">${formHtml(s, n)}</div>
      <div class="cover-preview">
        <canvas id="cover-canvas" width="1080" height="1440"></canvas>
        <div class="row" style="justify-content:center;margin-top:10px">
          <button class="btn primary" data-act="save">${V.editCard?'保存内容卡片':'保存为封面'}</button>
          <button class="btn" data-act="download">下载 PNG</button>
        </div>
        ${n.hasCover ? `<div class="muted" style="text-align:center;font-size:12px;margin-top:6px">${V.dirty ? '有未保存的修改' : n.coverStale ? '封面待渲染' : `${icon('check', 'icon-ok')} 已保存为当前封面`}</div>` : ''}
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="row">
        <h3 style="margin:0">封面方案</h3>
        <span class="muted">agent 设计的方案，点击即可套用</span>
        <div class="spacer"></div>
        <button class="btn small" data-act="ask-options">让 agent 出 3 个方案</button>
        <button class="btn small" data-act="ask-image">生成三张内容卡片</button>
      </div>
      ${options.length ? `<div class="option-grid">${options.map((o, i) => `<button class="option" data-option="${i}"><canvas data-opt-canvas="${i}"></canvas><span>${esc(TEMPLATES.find((t) => t.id === o.template)?.name || '')} · ${esc(PALETTES[o.palette].name)}</span></button>`).join('')}</div>` : '<div class="muted" style="margin-top:10px">还没有方案。</div>'}
    </div>
    <div id="cover-jobs">${jobsHtml()}</div>
    ${mediaHtml(n)}`;
  redraw();
  options.forEach((o, i) => {
    const c = $(`[data-opt-canvas="${i}"]`, main);
    if (c) drawCover(c, o, imageUrl(n, o));
  });
  bind(main);
  bindMedia($('#media-box',main),n,fresh=>{if(V.note?.id!==fresh.id)return;V.note=fresh;const box=$('#media-box');if(box){box.outerHTML=mediaHtml(fresh);bindMedia($('#media-box'),fresh,()=>onContent({area:'notes'}));}});
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
  V.dirty = true;V.revision++;
}

async function save() {
  const n=V.note,account=S.accountId,revision=V.revision,spec=structuredClone(V.spec),edit=V.editCard&&{...V.editCard},state=V.state;
  try {
    const canvas=document.createElement('canvas');await drawCover(canvas,spec,imageUrl(n,spec));
    const query=`account=${encodeURIComponent(account)}`;
    if(edit)await api('POST',`/api/covers/render?${query}`,{id:edit.id,index:edit.index,expectedSpec:edit.expectedSpec,spec,data:canvas.toDataURL('image/png')});
    else await api('POST',`/api/covers/save?${query}`,{noteId:n.id,spec,data:canvas.toDataURL('image/png'),expected:state.version,expectedCover:state.coverHash});
    if(S.view!=='cover'||S.accountId!==account||V.note?.id!==n.id||V.revision!==revision){toast('已保存提交版本；当前新修改仍保留');return;}
    V.dirty=false;if(await loadNote(n.id,true))draw($('#main'));toast(edit?'卡片已保存':'封面已保存，旧封面已备份');
  }catch(err){toast(err.message);}
}

function bind(main) {
  main.onclick = async (e) => {
    const t = e.target.closest('[data-tpl],[data-palette],[data-act],[data-option],[data-card],[data-retry]');
    if (!t) return;
    if(t.dataset.retry){try{await api('POST',`/api/covers/retry?${acc()}`,{id:t.dataset.retry});autoRender();}catch(e){toast(e.message);}return;}
    if(t.dataset.card){if(!canLeave())return;const j=V.jobs.find(j=>j.id===t.dataset.card),i=Number(t.dataset.index);V.editCard={id:j.id,index:i,expectedSpec:j.specHashes[i]};V.spec=normalizeSpec(j.specs[i]);V.dirty=false;V.revision++;return draw(main);}

    if (t.dataset.tpl || t.dataset.palette) {
      readForm();
      if (t.dataset.tpl) {if(V.editCard&&t.dataset.tpl!=='list'){toast('内容卡片使用清单模板');return;}V.spec.template = t.dataset.tpl;}
      else V.spec.palette = t.dataset.palette;
      V.dirty = true;
      return draw(main);
    }
    if (t.dataset.option) {
      V.editCard=null;V.revision++;V.spec = normalizeSpec(V.options[Number(t.dataset.option)]);
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
      case 'ask-options': return run('options');
      case 'ask-image': return run('cards');
      case 'schedule-draft': if(canLeave())return go('schedule',{id:V.note.id});return;
      case 'preview-note': if(canLeave())return go('copywriting',{id:V.note.id,preview:true});return;
      case 'back-cover': if(canLeave()){await loadNote(V.note.id);return draw(main);}return;
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

