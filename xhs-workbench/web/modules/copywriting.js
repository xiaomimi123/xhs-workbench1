import {imagePages} from '../note-preview.js';
// 文案：笔记列表 + 编辑器（标题 / 正文 / 话题），实时字数与违禁词检查，手机预览，一键让 agent 写 / 改
import { esc } from '../md.js';
import { icon } from '../icons.js';
import { S, $, api, acc, fileUrl, toast, fmtTime, ask, go, opt, accDirRel } from '../core.js';
import { lint, LIMITS } from '../lint.js';
import { mediaHtml, bindMedia } from './media.js';

export const NOTE_STATUSES = [
  ['draft', '草稿'],
  ['ready', '待发布'],
  ['published', '已发布'],
];
const STATUS_NAME = Object.fromEntries(NOTE_STATUSES);

const V = { items: [], current: null, note: null, dirty: false, preview: false, previewIndex: 0, filter: 'all', jobs: [], instruction: '', revision: 0 };

async function loadList() {
  V.items = (await api('GET', `/api/notes?${acc()}`)).items;
}

async function loadNote(id, {guard=false}={}) {
  const revision=V.revision, account=S.accountId;
  const note=id?await api('GET', `/api/notes/detail?${acc(`id=${id}`)}`):null;
  const jobs=id?(await api('GET', `/api/notes/jobs?${acc(`noteId=${id}`)}`)).items:[];
  if(account!==S.accountId || guard&&(V.revision!==revision||V.current!==id)) return false;
  V.note=note;V.current=note?note.id:null;V.jobs=jobs;V.dirty=false;
  return true;
}

export function canLeave() {
  return !V.dirty || confirm('笔记有未保存的修改，确定离开吗？');
}

export async function render(main, params = {}) {
  if(params.preview!==undefined)V.preview=!!params.preview;
  V.previewIndex=0;
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
  if (!V.dirty && V.current) await loadNote(V.items.some((n) => n.id === V.current) ? V.current : null, {guard:true});
  if (V.dirty) { drawList(); V.jobs = V.current ? (await api('GET', `/api/notes/jobs?${acc(`noteId=${V.current}`)}`)).items : []; const panel=$('#copy-jobs');if(panel)panel.innerHTML=jobsHtml(); }
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
        ${n.video && !n.hasCover ? `<span class="note-thumb">${icon("video")}</span>` : n.hasCover ? `<img src="${fileUrl(`notes/${n.id}/cover.png`, n.coverHash)}" alt="">` : `<span class="note-thumb">${icon("memo")}</span>`}
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
    : `${icon("check", "icon-ok")} 没有发现字数超限或常见违禁词`;
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
        : `${icon("video")} 视频首帧`
    : n.coverMode === 'first' && first
      ? `<img class="phone-cover" src="${fileUrl(`notes/${n.id}/images/${first}`, n.updatedAt)}" alt="">`
      : n.hasCover
        ? `<img class="phone-cover" src="${fileUrl(`notes/${n.id}/cover.png`, n.coverHash)}" alt="">`
        : '<div class="phone-cover placeholder">还没有封面</div>';
  const pages=imagePages(n);V.previewIndex=Math.max(0,Math.min(V.previewIndex,pages.length-1));
  const page=pages[V.previewIndex];
  const displayed=page?`<img class="phone-cover" src="${fileUrl(`notes/${n.id}/${page.path}`,n.updatedAt)}" alt="${esc(page.label)}" style="object-fit:contain">`:cover;
  return `${pages.length?`<div class="row" style="justify-content:center;margin:10px"><button class="btn small" data-act="preview-prev" ${V.previewIndex===0?'disabled':''}>上一张</button><span>${V.previewIndex+1} / ${pages.length} · ${esc(page.label)}</span><button class="btn small" data-act="preview-next" ${V.previewIndex===pages.length-1?'disabled':''}>下一张</button></div>`:''}<div class="phone">
    ${displayed}
    <div class="phone-body">
      ${total > 1 ? `<div class="phone-dots">${'<span></span>'.repeat(Math.min(total, 18))}</div>` : ''}
      <div class="phone-title">${esc(data.title || '（无标题）')}</div>
      <div class="phone-text">${esc(data.content)}</div>
      <div class="phone-tags">${data.tags.map((t) => `#${esc(t)}`).join(' ')}</div>
    </div>
  </div>`;
}

function jobsHtml() {
  const names={rewrite:'改写正文',titles:'标题优化',check:'内容检查'};
  return V.jobs.slice(0,8).map(j=>`<div class="card" style="margin-top:10px">
    <strong>${names[j.kind] || esc(j.kind)} · ${{queued:'排队中',running:'处理中',done:'已完成',error:'失败'}[j.status] || esc(j.status)}</strong>
    <div class="muted">${esc(j.error || j.progress || '等待 agent')} · ${fmtTime(j.createdAt)}</div>
    ${j.status==='error'?`<button class="btn small" data-copy-retry="${esc(j.id)}">重试</button>`:''}
    ${j.kind==='titles'&&j.status==='done'?`<ul>${j.result.titles.map(t=>`<li>${esc(t.title)}：${esc(t.reason)}</li>`).join('')}</ul>`:''}
    ${j.kind==='check'&&j.status==='done'?`<p>${j.stale||V.dirty?'<strong class="bad">报告已过期，请重新检查当前稿件。</strong>':''}${esc(j.result.summary)}</p>
      <ul>${j.result.issues.map(i=>`<li><strong>${esc(i.severity)}</strong>「${esc(i.quote)}」：${esc(i.suggestion)}</li>`).join('')}</ul>
      ${j.result.unverified.length?`<p>待核实：${j.result.unverified.map(esc).join('；')}</p>`:''}
      <p class="muted">规则检查：标题 ${j.lint.titleLen} 字，正文 ${j.lint.bodyLen} 字，${j.lint.issues.length} 项提示。检查结果不代表平台审核通过。</p>`:''}
  </div>`).join('');
}

async function runCopy(kind) {
  if (!(await save(true))) return;
  const noteId=V.current,account=S.accountId;
  try {
    await api('POST', `/api/notes/run?${acc()}`, {noteId,kind,instruction:kind==='rewrite'?V.instruction:''});
    if(noteId!==V.current||account!==S.accountId)return;
    if(!V.dirty) await loadNote(V.current,{guard:true});
    if(!V.dirty) draw($('#main')); else { V.jobs=(await api('GET',`/api/notes/jobs?${acc(`noteId=${V.current}`)}`)).items;const panel=$('#copy-jobs');if(panel)panel.innerHTML=jobsHtml(); }
  } catch(err) { toast(err.message); }
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
          <button class="btn small" data-act="schedule-draft">发布前检查</button><button class="btn small" data-act="preview">${V.preview ? '编辑' : '手机预览'}</button>
          <button class="btn small primary" data-act="save">保存</button>
          <details class="more-menu"><summary class="btn small ghost" aria-label="更多操作">更多</summary>
            <div class="more-menu-body"><button class="btn small ghost danger" data-act="delete">删除这篇笔记（移到回收站）</button></div></details>
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
        <label class="field">改写要求（可选）<input id="copy-instruction" maxlength="2000" value="${esc(V.instruction)}" placeholder="例如：开头更直接，保留步骤，减少套话"></label>
        <div class="note-actions">
          <div class="row action-group"><span class="muted">让 agent 帮忙</span>
            <button class="btn small primary" data-act="write">${data.content.trim() ? '改写正文' : '写正文'}</button>
            <button class="btn small" data-act="titles">生成标题备选</button>
            <button class="btn small" data-act="agent-check">深度检查</button></div>
          <div class="row action-group"><span class="muted">配套内容</span>
            <button class="btn small" data-act="video-script">${icon("video")} ${n.videoScript && n.videoScript.trim() ? '改视频脚本' : '写视频脚本'}</button>
            <button class="btn small" data-act="cover">${icon("palette")} 生成图片</button></div>
        </div>
      </div>
      ${n.topicId?`<div class="muted">关联选题：${esc(n.topicId)}</div>`:''}
      ${(n.sources||[]).map(ref=>/^https:\/\/www\.xiaohongshu\.com\//.test(ref.url)?`<a href="${esc(ref.url)}" target="_blank" rel="noopener noreferrer">来源：${esc(ref.benchmarkName||'对标')}</a>`:'').join(' · ')}
      <div class="muted">${n.basis==='observed'?'来源为已采集观察，尚未完成拆解。':''} 文案任务保留原稿快照，不自动发布。</div>
      <div id="copy-jobs">${jobsHtml()}</div>
      ${V.preview ? '' : `<div class="card lint-box" id="lint-box">${lintHtml(data)}</div>`}
      ${V.preview ? '' : mediaHtml(n)}`;
  }

  main.innerHTML = `
    <div class="row page-head">
      <div><h1 class="page-title">${icon("pen")} 文案</h1><div class="muted">agent 按知识库里的方法写稿，你在这里修改、检查、预览。</div></div>
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

// ---------- 视频脚本 ----------

async function openVideoScript(note) {
  let current = note.videoScript || '';
  if (!note.videoScript && !current) {
    // 没有脚本时先问一次，避免空白弹层
    try {
      const r = await api('GET', `/api/notes/video-script?${acc(`id=${note.id}`)}`);
      current = r.videoScript || '';
    } catch {
      /* 忽略 */
    }
  }
  const overlay = $('#overlay');
  overlay.innerHTML = `<div class="card" style="max-width:720px">
    <div class="row"><h3 style="margin:0">${icon('video')} 视频脚本</h3><span class="muted" style="font-size:12px">分镜表 + 口播 + 素材清单，照着拍就行</span><div class="spacer"></div>
      <button class="btn small ghost" data-vscript="close">关闭</button></div>
    <textarea id="video-script-text" rows="16" style="width:100%;margin:10px 0;font-family:var(--mono, monospace);font-size:13px" placeholder="还没有脚本。点下面的「让 agent 写脚本」，或者直接在这里按格式写。">${esc(current)}</textarea>
    <div class="row"><button class="btn primary small" data-vscript="save">保存脚本</button>
      <button class="btn small" data-vscript="ask">让 agent 写脚本（按选题和知识库生成分镜）</button>
      <span class="muted" style="font-size:12px">格式见 playbooks/video.md；agent 写完会回填到这里。</span></div>
  </div>`;
  overlay.hidden = false;
  overlay.onclick = async (e) => {
    const b = e.target.closest('[data-vscript]');
    if (!b) return;
    const text = $('#video-script-text').value;
    if (b.dataset.vscript === 'close') {
      overlay.hidden = true;
      overlay.onclick = null;
      return;
    }
    if (b.dataset.vscript === 'save') {
      b.disabled = true;
      try {
        await api('POST', `/api/notes/video-script?${acc()}`, { id: note.id, markdown: text });
        if (V.note && V.note.id === note.id) V.note.videoScript = text;
        toast('脚本已保存');
        overlay.hidden = true;
        overlay.onclick = null;
      } catch (err) {
        toast(err.message);
        b.disabled = false;
      }
      return;
    }
    if (b.dataset.vscript === 'ask') {
      b.disabled = true;
      try {
        await api('POST', `/api/notes/video-script?${acc()}`, { id: note.id, markdown: text });
        if (V.note && V.note.id === note.id) V.note.videoScript = text;
      } catch {
        /* 保存失败也让 agent 继续 */
      }
      overlay.hidden = true;
      overlay.onclick = null;
      ask(`请按 playbooks/video.md 为笔记「${note.title || note.id}」（notes/${note.id}/）写视频脚本：先读选题和知识库相关内容（账号定位、爆款方法论、对标拆解），把分镜表、素材清单、口播全文写成 notes/${note.id}/video.md。写完在工作台「视频脚本」弹层里能看到。`, true);
    }
  };
}

// 配图变化只重绘配图区，不覆盖编辑器里还没保存的文字
function onMediaChange(fresh) {
  if (!V.note || fresh.id !== V.note.id) return;
  for (const k of ['media', 'images', 'looseVideos', 'coverMode', 'hasCover', 'coverHash', 'coverStale', 'video', 'videoScript', 'updatedAt']) V.note[k] = fresh[k];
  const box = $('#media-box');
  if (!box) return;
  box.outerHTML = mediaHtml(V.note);
  bindMedia($('#media-box'), V.note, onMediaChange);
  loadList().then(drawList);
}

async function save(silent) {
  if (!V.note) return;
  const revision=V.revision, noteId=V.note.id, account=S.accountId;
  const data = V.preview
    ? { title: V.note.title, content: V.note.content, tags: V.note.tags, status: $('#note-status').value, visibility: $('#note-visibility').value }
    : readEditor();
  try {
    const fresh = await api('POST', `/api/notes?${acc()}`, { id: noteId, ...data });
    if(account!==S.accountId||V.current!==noteId||revision!==V.revision){toast('保存期间有新修改，请再次保存后操作');return false;}
    V.note=fresh;
    V.dirty = false;
    await loadList();
    if(account!==S.accountId||V.current!==noteId||revision!==V.revision)return false;
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
    const t = e.target.closest('[data-act],[data-note],[data-filter],[data-title],[data-copy-retry]');
    if (!t) return;
    if(t.dataset.copyRetry){
      if(V.dirty){toast('请先保存当前修改，再基于当前稿件发起操作');return;}
      const noteId=V.current,account=S.accountId;
      try{
        await api('POST',`/api/notes/retry?${acc()}`,{id:t.dataset.copyRetry});
        if(noteId!==V.current||account!==S.accountId)return;
        if(!V.dirty)await loadNote(noteId,{guard:true});
        if(!V.dirty)draw(main);
      }catch(err){toast(err.message);}return;
    }
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
      V.dirty = true; V.revision++;
      const panel=$('#copy-jobs');if(panel)panel.innerHTML=jobsHtml();
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
        if(await save()) return draw(main);
        return;
      case 'preview-prev': V.previewIndex--;return draw(main);
      case 'preview-next': V.previewIndex++;return draw(main);
      case 'preview':
        if (!V.preview) {
          Object.assign(V.note, readEditor());
        }
        V.preview = !V.preview;
        return draw(main);
      case 'write': return runCopy('rewrite');
      case 'titles': return runCopy('titles');
      case 'agent-check': return runCopy('check');
      case 'video-script':
        if (!(await save(true))) return;
        return openVideoScript(V.note);
      case 'schedule-draft':
        if(V.dirty && !(await save(true)))return;
        return go('schedule',{id:V.note.id});
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
    if(e.target.id==='copy-instruction'){V.instruction=e.target.value;return;}
    if (['note-title', 'note-body', 'note-tags'].includes(e.target.id)) {
      V.dirty = true; V.revision++;
      const panel=$('#copy-jobs');if(panel)panel.innerHTML=jobsHtml();
      refreshLint();
    }
  };
  main.onchange = (e) => {
    if (e.target.id === 'note-status' || e.target.id === 'note-visibility') {V.dirty = true;V.revision++;}
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

