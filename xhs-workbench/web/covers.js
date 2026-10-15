// 封面模板：用 Canvas 绘制 1080×1440（3:4）封面，纯前端、无依赖。
// 封面规格（spec）由用户在面板里编辑，或由 agent 写进笔记 meta.json 的 cover / coverOptions。

export const W = 1080;
export const H = 1440;

const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif';

export const TEMPLATES = [
  { id: 'bigtext', name: '大字报', desc: '纯色大字，信息直给' },
  { id: 'photo', name: '图片大字', desc: '实拍图 + 底部大标题' },
  { id: 'list', name: '清单', desc: '标题 + 编号要点' },
  { id: 'memo', name: '便签', desc: '笔记本纸 + 荧光笔强调' },
];

export const PALETTES = {
  red: { name: '小红', bg: '#ff2442', bg2: '#ff6a5b', text: '#ffffff', accent: '#ffe14d', sub: 'rgba(255,255,255,0.88)', card: 'rgba(255,255,255,0.16)', onAccent: '#2b2118' },
  cream: { name: '奶油', bg: '#fff6e5', bg2: '#ffe6bf', text: '#2b2118', accent: '#ff6b3d', sub: '#7a6551', card: '#ffffff', onAccent: '#ffffff' },
  mint: { name: '薄荷', bg: '#e8f7ef', bg2: '#c9ecd9', text: '#16332a', accent: '#12b76a', sub: '#4b6b5f', card: '#ffffff', onAccent: '#ffffff' },
  sakura: { name: '樱花', bg: '#ffe8ee', bg2: '#ffcfdc', text: '#3d1f2b', accent: '#ff4f81', sub: '#8a5a6b', card: '#ffffff', onAccent: '#ffffff' },
  blue: { name: '雾蓝', bg: '#e9f1ff', bg2: '#cddfff', text: '#10224a', accent: '#2f6bff', sub: '#4a5b80', card: '#ffffff', onAccent: '#ffffff' },
  night: { name: '深夜', bg: '#141824', bg2: '#2a3350', text: '#ffffff', accent: '#7cf1c8', sub: 'rgba(255,255,255,0.75)', card: 'rgba(255,255,255,0.08)', onAccent: '#141824' },
};

export const DEFAULT_SPEC = { template: 'bigtext', palette: 'red', title: '', emphasis: [], subtitle: '', badge: '', items: [], image: '' };

export function normalizeSpec(spec) {
  const s = { ...DEFAULT_SPEC, ...(spec || {}) };
  if (!TEMPLATES.some((t) => t.id === s.template)) s.template = 'bigtext';
  if (!PALETTES[s.palette]) s.palette = 'red';
  s.items = Array.isArray(s.items) ? s.items.filter(Boolean).map(String) : String(s.items || '').split('\n').filter(Boolean);
  s.emphasis = Array.isArray(s.emphasis) ? s.emphasis.filter(Boolean).map(String) : String(s.emphasis || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean);
  return s;
}

// ---------- 文字排版 ----------

const font = (size, weight = 700) => `${weight} ${size}px ${FONT}`;

// 中文逐字断行，英文数字按词不拆；支持 \n 手动换行
function wrap(ctx, text, maxWidth) {
  const lines = [];
  for (const para of String(text || '').split('\n')) {
    const start = lines.length;
    const tokens = para.match(/[A-Za-z0-9%.#@&'-]+|\s+|./gu) || [];
    let line = '';
    for (const tok of tokens) {
      const test = line + tok;
      if (line && ctx.measureText(test).width > maxWidth) {
        lines.push(line.trimEnd());
        line = tok.trimStart();
      } else line = test;
    }
    lines.push(line);
    // 避免最后一行只剩一两个字（孤字），从上一行挪两个字下来
    const n = lines.length;
    if (n - start >= 2 && [...lines[n - 1].trim()].length <= 2) {
      const prev = [...lines[n - 2]];
      const moved = prev.splice(-2).join('');
      lines[n - 2] = prev.join('').trimEnd();
      lines[n - 1] = (moved + lines[n - 1]).trimStart();
    }
  }
  return lines;
}

// 在给定区域内找最大可用字号
function fit(ctx, text, { maxWidth, maxHeight, maxSize, minSize = 40, lineHeight = 1.25, weight = 800, maxLines = 6 }) {
  // 优先保证用户手动换行的每一行不再被拆开，字号最多缩到 60%
  const manual = String(text || '').split('\n').length;
  if (manual > 1) {
    for (let size = maxSize; size >= Math.max(minSize, maxSize * 0.6); size -= 4) {
      ctx.font = font(size, weight);
      const lines = wrap(ctx, text, maxWidth);
      if (lines.length === manual && lines.length * size * lineHeight <= maxHeight) return { size, lines, lineHeight, weight };
    }
  }
  for (let size = maxSize; size >= minSize; size -= 4) {
    ctx.font = font(size, weight);
    const lines = wrap(ctx, text, maxWidth);
    if (lines.length <= maxLines && lines.length * size * lineHeight <= maxHeight) return { size, lines, lineHeight, weight };
  }
  ctx.font = font(minSize, weight);
  return { size: minSize, lines: wrap(ctx, text, maxWidth).slice(0, maxLines), lineHeight, weight };
}

// 按强调词拆分一行
function segments(line, emphasis) {
  if (!emphasis.length) return [{ text: line, em: false }];
  const re = new RegExp(`(${emphasis.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g');
  return line.split(re).filter(Boolean).map((t) => ({ text: t, em: emphasis.includes(t) }));
}

/**
 * 绘制多行文字。emStyle: 'color' 强调词换色；'marker' 强调词下画荧光笔
 */
function drawLines(ctx, layout, x, y, { color, accent, emphasis = [], emStyle = 'color', align = 'left', maxWidth }) {
  const { size, lines, lineHeight, weight } = layout;
  ctx.font = font(size, weight);
  ctx.textBaseline = 'top';
  let cy = y;
  for (const line of lines) {
    const lw = ctx.measureText(line).width;
    let cx = align === 'center' ? x + (maxWidth - lw) / 2 : x;
    for (const seg of segments(line, emphasis)) {
      const w = ctx.measureText(seg.text).width;
      if (seg.em && emStyle === 'marker') {
        ctx.fillStyle = accent;
        ctx.globalAlpha = 0.55;
        ctx.fillRect(cx - 4, cy + size * 0.55, w + 8, size * 0.45);
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = seg.em && emStyle === 'color' ? accent : color;
      ctx.fillText(seg.text, cx, cy);
      cx += w;
    }
    cy += size * lineHeight;
  }
  return cy;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function gradientBg(ctx, p) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, p.bg);
  g.addColorStop(1, p.bg2);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function drawBadge(ctx, text, x, y, bg, color) {
  if (!text) return 0;
  ctx.font = font(44, 700);
  const w = ctx.measureText(text).width + 56;
  roundRect(ctx, x, y, w, 84, 42);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 28, y + 44);
  return 84;
}

function drawCoverImage(ctx, img) {
  const scale = Math.max(W / img.width, H / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
}

// ---------- 模板 ----------

const DRAW = {
  bigtext(ctx, s, p) {
    gradientBg(ctx, p);
    ctx.fillStyle = p.card;
    ctx.beginPath();
    ctx.arc(W - 120, 180, 260, 0, Math.PI * 2);
    ctx.fill();
    const pad = 96;
    drawBadge(ctx, s.badge, pad, 120, p.accent, p.onAccent);
    const layout = fit(ctx, s.title || '在这里输入标题', { maxWidth: W - pad * 2, maxHeight: 820, maxSize: 168, maxLines: 5 });
    const blockH = layout.lines.length * layout.size * layout.lineHeight;
    const y = 300 + (820 - blockH) / 2;
    const end = drawLines(ctx, layout, pad, y, { color: p.text, accent: p.accent, emphasis: s.emphasis, maxWidth: W - pad * 2 });
    if (s.subtitle) {
      const sub = fit(ctx, s.subtitle, { maxWidth: W - pad * 2, maxHeight: 200, maxSize: 60, minSize: 36, weight: 500, maxLines: 3, lineHeight: 1.4 });
      ctx.fillStyle = p.accent;
      ctx.fillRect(pad, end + 40, 120, 12);
      drawLines(ctx, sub, pad, end + 90, { color: p.sub, accent: p.accent, maxWidth: W - pad * 2 });
    }
  },

  photo(ctx, s, p, img) {
    if (img) drawCoverImage(ctx, img);
    else gradientBg(ctx, p);
    const g = ctx.createLinearGradient(0, H * 0.35, 0, H);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.78)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    const pad = 80;
    drawBadge(ctx, s.badge, pad, 90, p.accent, p.onAccent);
    const layout = fit(ctx, s.title || '在这里输入标题', { maxWidth: W - pad * 2, maxHeight: 520, maxSize: 140, maxLines: 4 });
    const subLayout = s.subtitle ? fit(ctx, s.subtitle, { maxWidth: W - pad * 2, maxHeight: 140, maxSize: 52, minSize: 32, weight: 500, maxLines: 2, lineHeight: 1.4 }) : null;
    const titleH = layout.lines.length * layout.size * layout.lineHeight;
    const subH = subLayout ? subLayout.lines.length * subLayout.size * subLayout.lineHeight + 40 : 0;
    const y = H - 110 - subH - titleH;
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 24;
    const end = drawLines(ctx, layout, pad, y, { color: '#ffffff', accent: p.accent, emphasis: s.emphasis, maxWidth: W - pad * 2 });
    if (subLayout) drawLines(ctx, subLayout, pad, end + 30, { color: 'rgba(255,255,255,0.9)', accent: p.accent, maxWidth: W - pad * 2 });
    ctx.shadowBlur = 0;
  },

  list(ctx, s, p) {
    gradientBg(ctx, p);
    const pad = 84;
    let y = 100;
    if (s.badge) y += drawBadge(ctx, s.badge, pad, y, p.accent, p.onAccent) + 40;
    const layout = fit(ctx, s.title || '在这里输入标题', { maxWidth: W - pad * 2, maxHeight: 380, maxSize: 120, maxLines: 3 });
    y = drawLines(ctx, layout, pad, y, { color: p.text, accent: p.accent, emphasis: s.emphasis, maxWidth: W - pad * 2 }) + 24;
    if (s.subtitle) {
      const sub = fit(ctx, s.subtitle, { maxWidth: W - pad * 2, maxHeight: 80, maxSize: 48, minSize: 32, weight: 500, maxLines: 1 });
      y = drawLines(ctx, sub, pad, y, { color: p.sub, accent: p.accent, maxWidth: W - pad * 2 });
    }
    y += 24;
    const items = (s.items.length ? s.items : ['要点一', '要点二', '要点三']).slice(0, 6);
    const gap = 24;
    const itemH = Math.min(170, (H - y - 90 - gap * (items.length - 1)) / items.length);
    for (let i = 0; i < items.length; i++) {
      roundRect(ctx, pad, y, W - pad * 2, itemH, 28);
      ctx.fillStyle = p.card;
      ctx.fill();
      const r = Math.min(44, itemH * 0.3);
      ctx.fillStyle = p.accent;
      ctx.beginPath();
      ctx.arc(pad + 36 + r, y + itemH / 2, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = p.onAccent;
      ctx.font = font(r * 1.1, 800);
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), pad + 36 + r, y + itemH / 2 + 2);
      ctx.textAlign = 'left';
      const tx = pad + 36 + r * 2 + 32;
      const it = fit(ctx, items[i], { maxWidth: W - pad - tx - 36, maxHeight: itemH - 30, maxSize: 58, minSize: 30, weight: 600, maxLines: 2, lineHeight: 1.3 });
      const th = it.lines.length * it.size * it.lineHeight;
      drawLines(ctx, it, tx, y + (itemH - th) / 2 + 4, { color: p.card.startsWith('rgba') ? p.text : '#1f1f1f', accent: p.accent, maxWidth: W - pad - tx - 36 });
      y += itemH + gap;
    }
  },

  memo(ctx, s, p) {
    ctx.fillStyle = '#fffdf6';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(80,120,200,0.18)';
    ctx.lineWidth = 3;
    for (let y = 260; y < H; y += 96) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,80,80,0.35)';
    ctx.beginPath();
    ctx.moveTo(110, 0);
    ctx.lineTo(110, H);
    ctx.stroke();
    // 胶带
    ctx.save();
    ctx.translate(W / 2, 70);
    ctx.rotate(-0.04);
    ctx.fillStyle = p.accent;
    ctx.globalAlpha = 0.45;
    ctx.fillRect(-170, -36, 340, 72);
    ctx.restore();
    ctx.globalAlpha = 1;
    const pad = 150;
    let y = 200;
    if (s.badge) {
      ctx.font = font(48, 700);
      ctx.fillStyle = p.accent;
      ctx.textBaseline = 'top';
      ctx.fillText(`# ${s.badge}`, pad, y);
      y += 110;
    }
    const layout = fit(ctx, s.title || '在这里输入标题', { maxWidth: W - pad - 90, maxHeight: 700, maxSize: 140, maxLines: 5, weight: 900 });
    y = drawLines(ctx, layout, pad, y, { color: '#1f1f1f', accent: p.accent, emphasis: s.emphasis, emStyle: 'marker', maxWidth: W - pad - 90 });
    if (s.subtitle) {
      const sub = fit(ctx, s.subtitle, { maxWidth: W - pad - 90, maxHeight: 300, maxSize: 56, minSize: 34, weight: 500, maxLines: 4, lineHeight: 1.5 });
      drawLines(ctx, sub, pad, y + 50, { color: '#555555', accent: p.accent, maxWidth: W - pad - 90 });
    }
  },
};

function loadImage(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * 在 canvas 上绘制封面。imageUrl：背景图地址（photo 模板使用）
 */
export async function drawCover(canvas, spec, imageUrl) {
  const s = normalizeSpec(spec);
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  const img = s.template === 'photo' ? await loadImage(imageUrl) : null;
  DRAW[s.template](ctx, s, PALETTES[s.palette], img);
  return canvas;
}
