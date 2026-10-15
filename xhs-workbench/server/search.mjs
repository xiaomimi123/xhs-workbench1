// 知识库检索：中文按「二字片段」、英文数字按词切分，BM25 打分；标题、标签加权，返回最相关的片段
const HL_START = '\u0001';
const HL_END = '\u0002';

/** 文本 → 词元：中文连续段切成二字片段（单字段保留单字），英文数字按词 */
export function tokenize(text) {
  const out = [];
  const s = String(text || '').toLowerCase();
  for (const m of s.matchAll(/[一-鿿]+|[a-z0-9]+/g)) {
    const run = m[0];
    if (/^[a-z0-9]/.test(run)) out.push(run);
    else if (run.length === 1) out.push(run);
    else for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

// 查询里的疑问词、虚词不参与打分（只在查询侧去掉，文档侧保留原文）
const QUERY_STOPWORDS = ['怎么样', '为什么', '有没有', '是不是', '能不能', '怎么', '如何', '什么', '哪些', '哪个', '可以', '应该', '一下', '我的', '我们', '你的', '一个', '这个', '那个', '帮我', '请问', '吗', '呢', '吧', '啊', '的', '了', '和', '与', '及', '在', '是'];

export function queryTokens(query) {
  let q = String(query || '');
  for (const w of QUERY_STOPWORDS) q = q.split(w).join(' ');
  const tokens = [...new Set(tokenize(q))];
  return tokens.length ? tokens : [...new Set(tokenize(query))]; // 全是虚词时退回原查询
}

const K1 = 1.2;
const B = 0.75;
const FIELD_WEIGHT = { title: 3, tags: 2, headings: 2, body: 1 };

/**
 * docs: [{ id, title, tags: [], body }] → [{ id, score, snippet }]（按分数降序）
 */
export function search(docs, query, limit = 20) {
  const qTokens = queryTokens(query);
  if (!qTokens.length) return [];

  // 每篇文档的加权词频
  const stats = docs.map((d) => {
    const tf = new Map();
    let len = 0;
    for (const [field, w] of Object.entries(FIELD_WEIGHT)) {
      const text =
        field === 'tags' ? (d.tags || []).join(' ') : field === 'headings' ? (String(d.body || '').match(/^#{1,6}\s+.+$/gm) || []).join(' ') : d[field];
      for (const t of tokenize(text)) {
        tf.set(t, (tf.get(t) || 0) + w);
        len += w;
      }
    }
    return { d, tf, len };
  });
  const avgLen = stats.reduce((s, x) => s + x.len, 0) / Math.max(1, stats.length);
  const df = new Map(qTokens.map((t) => [t, stats.filter((x) => x.tf.has(t)).length]));
  const N = stats.length;

  const results = [];
  for (const { d, tf, len } of stats) {
    let score = 0;
    let hits = 0;
    for (const t of qTokens) {
      const f = tf.get(t);
      if (!f) continue;
      hits++;
      const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
      score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * len) / avgLen));
    }
    if (!hits) continue;
    // 查询词覆盖得越全越靠前（避免只命中一个常见二字片段的文档排太前）
    score *= 0.5 + 0.5 * (hits / qTokens.length);
    results.push({ id: d.id, score, snippet: snippet(d.body, qTokens) });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** 找命中最多的一段（约 90 字），命中处用控制字符包起来，前端转成高亮 */
function snippet(body, qTokens) {
  const text = String(body || '').replace(/^---[\s\S]*?---/, '').replace(/[#>*`|-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const lower = text.toLowerCase();
  const W = 90;
  let best = 0;
  let bestHits = -1;
  for (let start = 0; start < Math.max(1, lower.length - W / 2); start += 15) {
    const win = lower.slice(start, start + W);
    const h = qTokens.reduce((n, t) => n + (win.includes(t) ? 1 : 0), 0);
    if (h > bestHits) {
      bestHits = h;
      best = start;
    }
  }
  let piece = text.slice(best, best + W);
  // 高亮：按长度从长到短替换，避免重叠
  const marks = [...qTokens].sort((a, b) => b.length - a.length);
  const lowerPiece = piece.toLowerCase();
  const flags = new Array(piece.length).fill(false);
  for (const t of marks) {
    let i = lowerPiece.indexOf(t);
    while (i >= 0) {
      for (let k = i; k < i + t.length; k++) flags[k] = true;
      i = lowerPiece.indexOf(t, i + 1);
    }
  }
  let out = '';
  for (let i = 0; i < piece.length; i++) {
    if (flags[i] && !flags[i - 1]) out += HL_START;
    out += piece[i];
    if (flags[i] && !flags[i + 1]) out += HL_END;
  }
  return (best > 0 ? '…' : '') + out + (best + W < text.length ? '…' : '');
}
