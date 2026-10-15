// 笔记配图编辑：排序（拖拽 / 按钮）、裁剪、删除、实况图（静态图 + 动态视频）配对、素材打包下载
import { esc } from '../md.js';
import { S, $, api, acc, fileUrl, toast, readFileAsDataURL } from '../core.js';

export const MAX_IMAGES = 18;
const BROWSER_IMG = /\.(png|jpe?g|webp|gif)$/i;
const MAX_UPLOAD = 55 * 1024 * 1024;

let current = null; // { note, box, onChange }

function src(note, file) {
  return fileUrl(`notes/${note.id}/images/${file}`, note.updatedAt);
}

function tile(note, m, i, offset) {
  const canShow = BROWSER_IMG.test(m.file);
  return `<div class="media-tile" draggable="true" data-idx="${i}">
    <div class="media-thumb">
      ${canShow ? `<img src="${src(note, m.file)}" alt="" draggable="false">` : `<div class="media-placeholder">${esc(m.file.split('.').pop().toUpperCase())}<br><span>浏览器无法预览</span></div>`}
      ${m.video ? `<video src="${src(note, m.video)}" muted loop playsinline preload="none"></video><span class="live-badge">LIVE</span>` : ''}
      <span class="media-no">${i + 1 + offset}</span>
    </div>
    <div class="media-actions">
      <button class="icon-mini" data-media-act="left" data-idx="${i}" title="前移" ${i === 0 ? 'disabled' : ''}>←</button>
      <button class="icon-mini" data-media-act="right" data-idx="${i}" title="后移" ${i === note.media.length - 1 ? 'disabled' : ''}>→</button>
      ${canShow && !m.video ? `<button class="icon-mini" data-media-act="crop" data-idx="${i}" title="裁剪">✂</button>` : ''}
      ${m.video
        ? `<button class="icon-mini" data-media-act="unlive" data-idx="${i}" title="取消实况（视频保留为未配对）">⊘</button>`
        : note.looseVideos.length ? `<select class="pair" data-media-pair="${i}" title="配上动态视频变成实况图"><option value="">+实况</option>${note.looseVideos.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}</select>` : ''}
      <button class="icon-mini danger" data-media-act="delete" data-idx="${i}" title="删除（进回收站）">🗑</button>
    </div>
  </div>`;
}

export function mediaHtml(note) {
  const offset = note.coverMode !== 'first' && note.hasCover ? 1 : 0;
  const total = note.media.length + offset;
  const live = note.media.filter((m) => m.video).length;
  return `<div class="card media-box" id="media-box">
    <div class="row">
      <h3 style="margin:0">配图</h3>
      <span class="${total > MAX_IMAGES ? 'bad' : 'muted'}" style="font-size:13px">${total}/${MAX_IMAGES} 张${live ? ` · ${live} 张实况图` : ''}</span>
      <div class="spacer"></div>
      <label class="muted" style="font-size:13px">封面
        <select data-cover-mode>
          <option value="template"${note.coverMode !== 'first' ? ' selected' : ''}>用模板封面${note.hasCover ? '' : '（还没做）'}</option>
          <option value="first"${note.coverMode === 'first' ? ' selected' : ''}>用第一张配图</option>
        </select>
      </label>
      <label class="btn small upload-btn">上传图片 / 实况视频<input type="file" multiple accept="image/*,.heic,.mov,.mp4,video/quicktime,video/mp4" data-media-upload hidden></label>
      ${note.media.length || note.hasCover ? `<a class="btn small" href="/api/notes/bundle?${acc(`id=${encodeURIComponent(note.id)}`)}&t=${encodeURIComponent(S.token)}">下载全部素材</a>` : ''}
    </div>
    <div class="media-grid">
      ${offset ? `<div class="media-tile fixed"><div class="media-thumb"><img src="${fileUrl(`notes/${note.id}/cover.png`, note.coverHash)}" alt=""><span class="media-no">1</span><span class="live-badge cover">封面</span></div><div class="media-actions muted">模板封面</div></div>` : ''}
      ${note.media.map((m, i) => tile(note, m, i, offset)).join('')}
      ${note.media.length ? '' : '<div class="muted media-empty">还没有配图。可以上传照片，或者让 agent 生成配图。</div>'}
    </div>
    ${total > MAX_IMAGES ? `<div class="error-line">超过 ${MAX_IMAGES} 张，发布时会被平台拒绝，请删掉一些。</div>` : ''}
    ${note.looseVideos.length ? `<div class="muted" style="font-size:12px;margin-top:8px">未配对的视频：${note.looseVideos.map(esc).join('、')}。在图片下方的「+实况」里选择，就能把它和这张图配成实况图。</div>` : ''}
    <div class="muted" style="font-size:12px;margin-top:8px">拖动图片调整顺序。实况图 = 一张静态图 + 一段动态视频；上传同名的照片和视频（如 iPhone 导出的 IMG_1234.HEIC 和 IMG_1234.MOV）会自动配对。</div>
  </div>`;
}

async function save(media) {
  try {
    const note = await api('POST', `/api/notes/media?${acc()}`, { id: current.note.id, media });
    current.onChange(note);
  } catch (err) {
    toast(err.message);
  }
}

const plain = (media) => media.map((m) => ({ file: m.file, ...(m.video ? { video: m.video } : {}) }));

function move(from, to) {
  const media = plain(current.note.media);
  const [x] = media.splice(from, 1);
  media.splice(to, 0, x);
  return save(media);
}

/** 渲染后调用：绑定事件。onChange(note) 在配图变化后回调 */
export function bindMedia(box, note, onChange) {
  current = { note, box, onChange };
  if (!box) return;

  box.onclick = async (e) => {
    const t = e.target.closest('[data-media-act]');
    if (!t) return;
    const i = Number(t.dataset.idx);
    const media = plain(note.media);
    switch (t.dataset.mediaAct) {
      case 'left':
        return move(i, i - 1);
      case 'right':
        return move(i, i + 1);
      case 'unlive':
        delete media[i].video;
        return save(media);
      case 'crop':
        return openCrop(note, note.media[i].file);
      case 'delete':
        if (!confirm(`删除这张配图${note.media[i].video ? '（连同它的动态视频）' : ''}？会移到回收站，可以恢复。`)) return;
        try {
          onChange(await api('POST', `/api/notes/media/delete?${acc()}`, { id: note.id, file: note.media[i].file }));
        } catch (err) {
          toast(err.message);
        }
    }
  };

  box.onchange = async (e) => {
    const t = e.target;
    if (t.dataset.mediaPair !== undefined && t.value) {
      const media = plain(note.media);
      media[Number(t.dataset.mediaPair)].video = t.value;
      return save(media);
    }
    if (t.dataset.coverMode !== undefined) {
      try {
        await api('POST', `/api/notes?${acc()}`, { id: note.id, coverMode: t.value });
        onChange(await api('GET', `/api/notes/detail?${acc(`id=${note.id}`)}`));
      } catch (err) {
        toast(err.message);
      }
      return;
    }
    if (t.dataset.mediaUpload !== undefined) {
      const files = [...t.files];
      const label = t.closest('label');
      label.classList.add('disabled');
      try {
        for (const f of files) {
          if (f.size > MAX_UPLOAD) {
            toast(`「${f.name}」超过 55MB，跳过`);
            continue;
          }
          await api('POST', `/api/notes/upload?${acc()}`, { id: note.id, filename: f.name, data: await readFileAsDataURL(f) });
        }
        toast(`已上传 ${files.length} 个文件`);
        onChange(await api('GET', `/api/notes/detail?${acc(`id=${note.id}`)}`));
      } catch (err) {
        toast(err.message);
        label.classList.remove('disabled');
      }
    }
  };

  // 实况图：鼠标移上去播放动态视频
  box.onmouseover = (e) => {
    const v = e.target.closest('.media-thumb') && e.target.closest('.media-thumb').querySelector('video');
    if (v) {
      v.classList.add('playing');
      v.play().catch(() => {});
    }
  };
  box.onmouseout = (e) => {
    const thumb = e.target.closest('.media-thumb');
    const v = thumb && thumb.querySelector('video');
    if (v && !thumb.contains(e.relatedTarget)) {
      v.pause();
      v.classList.remove('playing');
    }
  };

  // 拖拽排序
  let dragFrom = null;
  box.ondragstart = (e) => {
    const t = e.target.closest('.media-tile[data-idx]');
    if (!t) return;
    dragFrom = Number(t.dataset.idx);
    e.dataTransfer.effectAllowed = 'move';
    t.classList.add('dragging');
  };
  box.ondragover = (e) => {
    if (dragFrom === null) return;
    const t = e.target.closest('.media-tile[data-idx]');
    if (!t) return;
    e.preventDefault();
    box.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target'));
    t.classList.add('drop-target');
  };
  box.ondragend = () => {
    dragFrom = null;
    box.querySelectorAll('.dragging,.drop-target').forEach((x) => x.classList.remove('dragging', 'drop-target'));
  };
  box.ondrop = (e) => {
    const t = e.target.closest('.media-tile[data-idx]');
    if (dragFrom === null || !t) return;
    e.preventDefault();
    const to = Number(t.dataset.idx);
    const from = dragFrom;
    dragFrom = null;
    if (from !== to) move(from, to);
  };
}

// ---------- 裁剪 ----------

const RATIOS = [
  ['3:4', 3 / 4],
  ['1:1', 1],
  ['4:3', 4 / 3],
  ['原比例', 0],
];

function openCrop(note, file) {
  const img = new Image();
  img.onload = () => cropDialog(note, file, img);
  img.onerror = () => toast('图片加载失败');
  img.src = src(note, file);
}

function cropDialog(note, file, img) {
  const st = { ratio: 3 / 4, zoom: 1, cx: 0.5, cy: 0.5 };
  const overlay = $('#overlay');
  overlay.innerHTML = `<div class="card crop-card">
    <div class="row"><h3 style="margin:0">裁剪</h3><span class="muted" style="font-size:12px">拖动画面调整位置</span><div class="spacer"></div>
      ${RATIOS.map(([n], i) => `<button class="chip${i === 0 ? ' active' : ''}" data-ratio="${i}">${n}</button>`).join('')}
    </div>
    <canvas class="crop-canvas" width="360" height="480"></canvas>
    <label class="row muted" style="font-size:13px">缩放 <input type="range" min="1" max="4" step="0.01" value="1" data-zoom style="flex:1"></label>
    <div class="row"><div class="spacer"></div><button class="btn ghost" data-crop="cancel">取消</button><button class="btn primary" data-crop="ok">保存裁剪</button></div>
    <div class="muted" style="font-size:12px">原图会移到回收站，可以恢复。</div>
  </div>`;
  overlay.hidden = false;
  const canvas = $('.crop-canvas', overlay);
  const ctx = canvas.getContext('2d');

  // 当前裁剪框（原图像素坐标）
  const rect = () => {
    const r = st.ratio || img.width / img.height;
    let w = img.width;
    let h = w / r;
    if (h > img.height) {
      h = img.height;
      w = h * r;
    }
    w /= st.zoom;
    h /= st.zoom;
    const x = Math.min(Math.max(st.cx * img.width - w / 2, 0), img.width - w);
    const y = Math.min(Math.max(st.cy * img.height - h / 2, 0), img.height - h);
    return { x, y, w, h };
  };
  const draw = () => {
    const c = rect();
    const scale = Math.min(360 / c.w, 480 / c.h);
    canvas.width = Math.round(c.w * scale);
    canvas.height = Math.round(c.h * scale);
    ctx.drawImage(img, c.x, c.y, c.w, c.h, 0, 0, canvas.width, canvas.height);
  };
  draw();

  let drag = null;
  canvas.onpointerdown = (e) => {
    drag = { x: e.clientX, y: e.clientY, cx: st.cx, cy: st.cy };
    canvas.setPointerCapture(e.pointerId);
  };
  canvas.onpointermove = (e) => {
    if (!drag) return;
    const c = rect();
    const k = c.w / canvas.width; // 屏幕像素 → 原图像素
    st.cx = drag.cx - ((e.clientX - drag.x) * k) / img.width;
    st.cy = drag.cy - ((e.clientY - drag.y) * k) / img.height;
    const r = rect(); // 回写被边界限制后的中心点，避免拖出界后"粘住"
    st.cx = (r.x + r.w / 2) / img.width;
    st.cy = (r.y + r.h / 2) / img.height;
    draw();
  };
  canvas.onpointerup = () => (drag = null);

  overlay.oninput = (e) => {
    if (e.target.dataset.zoom !== undefined) {
      st.zoom = Number(e.target.value);
      draw();
    }
  };
  overlay.onclick = async (e) => {
    const r = e.target.closest('[data-ratio]');
    if (r) {
      st.ratio = RATIOS[Number(r.dataset.ratio)][1];
      overlay.querySelectorAll('[data-ratio]').forEach((b) => b.classList.toggle('active', b === r));
      return draw();
    }
    const btn = e.target.closest('[data-crop]');
    if (!btn) return;
    if (btn.dataset.crop === 'cancel') return close();
    const c = rect();
    const scale = Math.min(1, 2160 / Math.max(c.w, c.h)); // 长边最多 2160 像素
    const out = document.createElement('canvas');
    out.width = Math.round(c.w * scale);
    out.height = Math.round(c.h * scale);
    out.getContext('2d').drawImage(img, c.x, c.y, c.w, c.h, 0, 0, out.width, out.height);
    btn.disabled = true;
    try {
      const updated = await api('POST', `/api/notes/media/crop?${acc()}`, { id: note.id, file, data: out.toDataURL('image/jpeg', 0.92) });
      close();
      toast('已裁剪');
      current.onChange(updated);
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  };
  function close() {
    overlay.hidden = true;
    overlay.onclick = null;
    overlay.oninput = null;
  }
}
