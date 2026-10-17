// 素材库：收藏剪辑素材（视频片段 / 图片截图 / 文案稿字幕），卡片 + 标签 + 批注。
// agent 写内容时读批注模仿；规律由知识库管家提炼进知识库。
import { esc } from '../md.js';
import { S, $, api, acc, fileUrl, toast, fmtTime, ask, readFileAsDataURL } from '../core.js';
import { icon } from '../icons.js';

const V = { items: [], filter: 'all', editing: null };
const TYPE_NAME = { video: '视频', image: '图片', script: '文稿' };
const ACCEPT = '.mp4,.mov,.webm,.png,.jpg,.jpeg,.webp,.gif,.heic,.srt,.txt,.md';
const BROWSER_VIDEO = /\.(mp4|webm)$/i;
const BROWSER_IMG = /\.(png|jpe?g|webp|gif)$/i;

export async function render(main) {
  if (V.accountId !== S.accountId) {
    V.accountId = S.accountId;
    V.editing = null;
  }
  main.innerHTML = '<div class="empty">加载中…</div>';
  try {
    V.items = (await api('GET', '/api/materials')).items;
  } catch (err) {
    main.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  draw(main);
}

export async function onContent(ev) {
  if (ev.area !== 'materials') return;
  try {
    V.items = (await api('GET', '/api/materials')).items;
    draw($('#main'));
  } catch {
    /* 忽略 */
  }
}

function cardHtml(m) {
  const file = m.file ? fileUrl(`materials/files/${m.file}`) : '';
  let thumb;
  if (m.type === 'video') {
    thumb = BROWSER_VIDEO.test(m.file)
      ? `<video src="${file}" muted playsinline preload="metadata"></video>`
      : `<span class="note-thumb">${esc(m.file.split('.').pop().toUpperCase())}</span>`;
  } else if (m.type === 'image') {
    thumb = BROWSER_IMG.test(m.file)
      ? `<img src="${file}" alt="">`
      : `<span class="note-thumb">${esc(m.file.split('.').pop().toUpperCase())}</span>`;
  } else {
    thumb = `<span class="note-thumb">${icon("memo")}</span>`;
  }
  return `<div class="card material-card" data-mat="${esc(m.id)}">
    <div class="row" style="margin-bottom:6px">
      <span class="badge">${TYPE_NAME[m.type] || m.type}</span>
      <strong>${esc(m.title || m.file)}</strong>
      <div class="spacer"></div>
      <span class="muted" style="font-size:12px">${fmtTime(m.updatedAt)}</span>
    </div>
    ${thumb ? `<div class="material-thumb">${thumb}</div>` : ''}
    ${m.tags.length ? `<div class="chips" style="margin:8px 0 0">${m.tags.map((t) => `<span class="chip" style="cursor:default">${esc(t)}</span>`).join('')}</div>` : ''}
    ${m.note ? `<p class="material-note">${esc(m.note)}</p>` : ''}
    ${m.source ? `<div class="muted" style="font-size:12px;margin-top:6px">来源：${esc(m.source)}</div>` : ''}
    <div class="row" style="margin-top:10px">
      ${m.file ? `<a class="btn small" href="${file}" target="_blank" rel="noopener">打开文件</a>` : ''}
      ${m.type === 'script' ? '' : `<button class="btn small" data-act="learn" data-id="${esc(m.id)}">让 agent 学习这条</button>`}
      <div class="spacer"></div>
      <button class="btn small" data-act="edit" data-id="${esc(m.id)}">编辑</button>
      <button class="btn small ghost danger" data-act="delete" data-id="${esc(m.id)}">删除</button>
    </div>
  </div>`;
}

function draw(main) {
  const filters = [['all', '全部'], ['video', '视频'], ['image', '图片'], ['script', '文稿']];
  const items = V.items.filter((m) => V.filter === 'all' || m.type === V.filter);
  main.innerHTML = `
    <div class="row page-head">
      <div><h1 class="page-title">${icon("folder")} 素材库</h1><div class="muted">收藏你剪辑里值得学习模仿的片段、截图和文稿。agent 写内容时会参考这里的批注和标签。</div></div>
      <div class="spacer"></div>
      <button class="btn" data-act="learn-all">让 agent 提炼全部规律</button>
      <button class="btn primary" data-act="add">添加素材</button>
    </div>
    ${V.editing ? formHtml(V.editing) : ''}
    <div class="chips">${filters.map(([id, name]) => `<button class="chip${V.filter === id ? ' active' : ''}" data-filter="${id}">${name}</button>`).join('')}</div>
    ${items.length ? `<div class="grid">${items.map(cardHtml).join('')}</div>` : V.editing ? '' : `<div class="card empty-card">
      <p>素材库还是空的。</p>
      <p class="muted">把剪辑里的爆款片段、好看的封面截图、效果好的文稿存进来，写一句「为什么好」，agent 之后写内容就会模仿。</p>
    </div>`}`;
  bind(main);
}

function formHtml(f) {
  const currentFile = f.id && f.file ? `<div class="row" style="margin:0 0 4px"><span class="muted" style="font-size:12px">${icon('check', 'icon-ok')} 当前文件：<code>${esc(f.file)}</code>（不选新文件就保留它）</span></div>` : '';
  return `<div class="card" style="margin-bottom:16px;max-width:680px">
    <h3 style="margin-top:0">${f.id ? '编辑素材' : '添加素材'}</h3>
    <form class="form" id="material-form">
      <label>素材文件${f.id ? '（可换可不换）' : ' *'}<input type="file" id="material-file" accept="${ACCEPT}" ${f.id ? '' : 'required'}></label>
      ${currentFile}
      ${f._uploading ? '<div class="upload-progress"><div style="width:100%"></div></div>' : ''}
      <label>标题 *<input type="text" name="title" required value="${esc(f.title)}" placeholder="如：开头 3 秒钩子范本"></label>
      <label>标签（逗号分隔）<input type="text" name="tags" value="${esc((f.tags || []).join(', '))}" placeholder="开头钩子, 实拍, 口播"></label>
      <label>我的批注（为什么好、想学什么——agent 主要看这段）<textarea name="note" rows="3" placeholder="例：前 3 秒直接给结果不给过程，留一个悬念让人看完">${esc(f.note)}</textarea></label>
      <label>来源<input type="text" name="source" value="${esc(f.source)}" placeholder="如：@某账号 10-12 的爆款 / 自己 9 月 cut"></label>
      <div class="row"><button class="btn primary" type="submit">保存</button><button class="btn ghost" type="button" data-act="cancel-form">取消</button></div>
    </form>
  </div>`;
}

function bind(main) {
  main.onclick = async (e) => {
    const t = e.target.closest('[data-act],[data-filter]');
    if (!t) return;
    if (t.dataset.filter) {
      V.filter = t.dataset.filter;
      return draw(main);
    }
    const m = V.items.find((x) => x.id === t.dataset.id);
    switch (t.dataset.act) {
      case 'add':
        V.editing = { tags: [] };
        return draw(main);
      case 'cancel-form':
        V.editing = null;
        return draw(main);
      case 'edit':
        V.editing = { ...m };
        return draw(main);
      case 'delete':
        if (!confirm(`删除素材「${m.title || m.file}」？（文件会移到回收站）`)) return;
        await api('DELETE', `/api/materials?id=${encodeURIComponent(m.id)}`).catch((err) => toast(err.message));
        V.items = (await api('GET', '/api/materials')).items;
        return draw(main);
      case 'learn':
        return ask(
          `请学习素材库里的这条参考素材：读取 ${accDir()}/materials/files/${m.file}（${m.type === 'video' ? '视频，建议抽帧看节奏和转场' : m.type === 'script' ? '文稿，直接阅读' : '图片，直接查看'}）。` +
            `用户的批注：${m.note || '（无）'}。请总结它值得模仿的 2-3 个具体手法（结构 / 节奏 / 文案角度），按 playbooks/knowledge.md 沉淀到知识库「爆款方法论/」。`,
          true,
        );
      case 'learn-all':
        return ask(
          `请学习素材库（${accDir()}/materials/）里的全部素材：逐个读取 files/ 下的文件和 index.json 里的批注，提炼共性规律（结构、节奏、封面 / 文案手法），按 playbooks/knowledge.md 沉淀到知识库「爆款方法论/」，已有的相近结论就补充修正。`,
          true,
        );
    }
  };

  const form = $('#material-form', main);
  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      const fileInput = $('#material-file');
      let file = V.editing && V.editing.file;
      if (fileInput.files[0]) {
        const f = fileInput.files[0];
        if (f.size > 55 * 1024 * 1024) return toast(`「${f.name}」超过 55MB，请压缩后再传`);
        try {
          const up = await api('POST', '/api/materials/upload', { filename: f.name, data: await readFileAsDataURL(f) });
          file = up.name;
        } catch (err) {
          return toast(err.message);
        }
      }
      if (!file) return toast('请先上传素材文件');
      try {
        await api('POST', '/api/materials', { id: V.editing?.id, ...data, file, type: undefined });
        V.editing = null;
        V.items = (await api('GET', '/api/materials')).items;
        draw(main);
        toast('素材已保存');
      } catch (err) {
        toast(err.message);
      }
    };
  }
}

function accDir() {
  return `accounts/${S.accountId}`;
}
