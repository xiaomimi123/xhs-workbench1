// 本机没有 ffprobe 时的 MP4 基础校验（纯 JS，不解码画面）：
// 顶层盒子链完整（下载被截断会被发现）、第一个是 ftyp、有 mdat/moof 数据、moov 里 mvhd 给出时长、视频轨（hdlr=vide）的 tkhd/stsd 给出宽高。
// 只能证明「结构像一个完整的 MP4」，不能证明画面能解码；调用方要把 checkedBy 标成 mp4-header，让界面提示用户播放确认。
import fs from 'node:fs';
const MAX_MOOV = 64 * 1024 * 1024;
const bad = (msg) => { const e = Error(msg); e.mp4 = true; return e; };

function boxes(buf, start = 0, end = buf.length) {
  const out = [];
  for (let at = start; at + 8 <= end;) {
    let size = buf.readUInt32BE(at), head = 8;
    const type = buf.toString('latin1', at + 4, at + 8);
    if (size === 1) { if (at + 16 > end) throw bad('MP4 盒子头不完整'); size = Number(buf.readBigUInt64BE(at + 8)); head = 16; }
    else if (size === 0) size = end - at;
    if (size < head || at + size > end) throw bad('MP4 盒子长度越界');
    out.push({ type, start: at + head, end: at + size });
    at += size;
  }
  return out;
}
const child = (buf, box, type) => boxes(buf, box.start, box.end).find((b) => b.type === type);
const children = (buf, box, type) => boxes(buf, box.start, box.end).filter((b) => b.type === type);

/** 解析 moov 盒子内容（不含盒子头），返回 {width,height,duration}；任何一项缺失都抛错。 */
export function parseMoov(buf) {
  const moov = { start: 0, end: buf.length };
  const mvhd = child(buf, moov, 'mvhd');
  if (!mvhd) throw bad('MP4 缺少 mvhd');
  const v = buf[mvhd.start], p = mvhd.start + 4;
  if (mvhd.end - mvhd.start < (v === 1 ? 32 : 20)) throw bad('MP4 mvhd 不完整');
  const timescale = buf.readUInt32BE(v === 1 ? p + 16 : p + 8);
  let ticks = v === 1 ? Number(buf.readBigUInt64BE(p + 20)) : buf.readUInt32BE(p + 12);
  if (!ticks) { // 分片 MP4：总时长在 mvex/mehd
    const mehd = (() => { const mvex = child(buf, moov, 'mvex'); return mvex && child(buf, mvex, 'mehd'); })();
    if (mehd) ticks = buf[mehd.start] === 1 ? Number(buf.readBigUInt64BE(mehd.start + 4)) : buf.readUInt32BE(mehd.start + 4);
  }
  const duration = timescale ? ticks / timescale : NaN;
  for (const trak of children(buf, moov, 'trak')) {
    const mdia = child(buf, trak, 'mdia'), hdlr = mdia && child(buf, mdia, 'hdlr');
    if (!hdlr || hdlr.end - hdlr.start < 12 || buf.toString('latin1', hdlr.start + 8, hdlr.start + 12) !== 'vide') continue;
    let width = 0, height = 0;
    const tkhd = child(buf, trak, 'tkhd');
    if (tkhd) { const at = tkhd.start + (buf[tkhd.start] === 1 ? 88 : 76); if (at + 8 <= tkhd.end) { width = buf.readUInt32BE(at) / 65536; height = buf.readUInt32BE(at + 4) / 65536; } }
    if (!width || !height) { // 少数文件 tkhd 宽高为 0，退回到 stsd 里第一个视觉样本描述
      const minf = child(buf, mdia, 'minf'), stbl = minf && child(buf, minf, 'stbl'), stsd = stbl && child(buf, stbl, 'stsd');
      // stsd：版本/标志 4 + 条目数 4；样本描述：盒子头 8 + 保留 6 + 数据引用 2 + 预留 16，然后是 宽 2、高 2
      const at = stsd && stsd.start + 8 + 8 + 8 + 16;
      if (stsd && at + 4 <= stsd.end) { width = buf.readUInt16BE(at); height = buf.readUInt16BE(at + 2); }
    }
    width = Math.round(width); height = Math.round(height);
    if (!width || !height || width > 16384 || height > 16384) throw bad('MP4 视频轨缺少有效尺寸');
    if (!Number.isFinite(duration) || duration <= 0) throw bad('MP4 缺少有效时长');
    return { width, height, duration };
  }
  throw bad('MP4 没有视频轨');
}

/** 校验磁盘上的 MP4 文件；失败抛带 mp4=true 的错误。 */
export function checkMp4File(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, head = Buffer.alloc(16);
    let at = 0, first = true, moov = null, data = false;
    while (at < size) {
      if (size - at < 8) throw bad('MP4 结尾有残缺数据');
      fs.readSync(fd, head, 0, 16, at);
      let len = head.readUInt32BE(0), hl = 8;
      const type = head.toString('latin1', 4, 8);
      if (len === 1) { if (size - at < 16) throw bad('MP4 盒子头不完整'); len = Number(head.readBigUInt64BE(8)); hl = 16; }
      else if (len === 0) len = size - at;
      if (len < hl || at + len > size) throw bad('MP4 文件不完整（可能下载被截断）');
      if (first && type !== 'ftyp') throw bad('生成文件不是MP4视频');
      first = false;
      if (type === 'moov') {
        if (moov) throw bad('MP4 有多个 moov');
        if (len - hl > MAX_MOOV) throw bad('MP4 元数据过大');
        moov = Buffer.alloc(len - hl); fs.readSync(fd, moov, 0, moov.length, at + hl);
      }
      if ((type === 'mdat' && len > hl) || type === 'moof') data = true;
      at += len;
    }
    if (first) throw bad('生成文件不是MP4视频');
    if (!moov) throw bad('MP4 缺少 moov');
    if (!data) throw bad('MP4 没有画面数据');
    return parseMoov(moov);
  } finally { fs.closeSync(fd); }
}
