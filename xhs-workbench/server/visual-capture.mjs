import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

// 原图只交给本机 OCR；临时图片在成功、失败、取消后都清除。
export async function recognizeScreenshot(png, { signal } = {}) {
  if (process.platform !== 'darwin') throw new Error('本机暂不支持 Apple Vision OCR，保留截图并标为部分完成');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xhs-ocr-'));
  try {
    const file = path.join(dir, 'page.png');
    await fs.writeFile(file, png);
    const { stdout } = await exec('/usr/bin/swift', [fileURLToPath(new URL('./vision-ocr.swift', import.meta.url)), file],
      { timeout: 25_000, maxBuffer: 1024 * 1024, signal });
    const result = JSON.parse(stdout);
    if (!result.text?.trim()) throw new Error('截图中没有识别到文字');
    return result;
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

export function corroborateProfile(profile, ocr) {
  const normalize = (s) => String(s || '').normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  const labels = { followers: '粉丝', following: '关注', likesAndCollects: '获赞与收藏', noteCount: '笔记' };
  const number = '[0-9]+(?:[,.][0-9]+)*(?:万|亿|[kKwW])?';
  const rows = ocr.lines?.length ? ocr.lines.filter(l => l.confidence >= 0.25) : String(ocr.text || '').split('\n').map(text => ({ text }));
  const metric = (label) => {
    const values = new Set();
    for (const row of rows) {
      if (!row.text.includes(label)) continue;
      const before = row.text.match(new RegExp(`(?:^|\\s)(${number})\\s*${label}(?:\\s|$)`));
      const after = row.text.match(new RegExp(`(?:^|\\s)${label}\\s*(${number})(?:\\s|$)`));
      if (before || after) { values.add(normalize((before || after)[1])); continue; }
      // 标签与数字分行时，使用截图坐标关联其正上方唯一数字。
      if (normalize(row.text) !== label || !Number.isFinite(row.x)) continue;
      const candidates = rows.filter(n => new RegExp(`^${number}$`).test(n.text.trim())
        && Number.isFinite(n.x) && n.y < row.y && row.y - n.y < Math.max(row.height * 4, 0.12)
        && Math.abs(n.x + n.width / 2 - row.x - row.width / 2) < Math.max(row.width, n.width) * 0.6);
      if (candidates.length === 1) values.add(normalize(candidates[0].text));
    }
    return values.size === 1 ? [...values][0] : null;
  };
  const visible = normalize(rows.map(r => r.text).join('\n'));
  return Object.fromEntries(Object.entries(profile).filter(([key, value]) => normalize(value)
    && (labels[key] ? metric(labels[key]) === normalize(value) : String(value).split(/\n+/).filter(line => normalize(line)).every(line => visible.includes(normalize(line))))));
}

function avatarUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !(url.hostname.endsWith('.xhscdn.com') || url.hostname === 'xhscdn.com')) throw new Error('头像地址不是受支持的小红书图片域名');
  return url;
}
export async function downloadAvatar(value, { signal, fetcher = fetch } = {}) {
  let url = avatarUrl(value);
  const timeout = AbortSignal.timeout(8000);
  const stop = signal ? AbortSignal.any([signal, timeout]) : timeout;
  for (let i = 0; i < 3; i++) {
    const response = await fetcher(url.href, { redirect: 'manual', signal: stop });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      url = avatarUrl(new URL(response.headers.get('location'), url).href);
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`头像下载失败 HTTP ${response.status}`); }
    const reader = response.body.getReader();
    let size = 0; const chunks = [];
    try {
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        size += chunk.length;
        if (size > 2 * 1024 * 1024) throw new Error('头像超过 2MB');
        chunks.push(chunk);
      }
    } finally { await reader.cancel(); }
    const buffer = Buffer.concat(chunks);
    const ext = buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? '.png'
      : buffer[0] === 0xff && buffer[1] === 0xd8 ? '.jpg'
      : buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' ? '.webp' : '';
    if (!ext) throw new Error('头像响应不是图片');
    return { buffer, ext, sourceUrl: `${url.origin}${url.pathname}` };
  }
  throw new Error('头像重定向过多');
}
