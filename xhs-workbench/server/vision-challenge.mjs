// 看图自检：生成一张随机排布的“四象限纯色块”图片，让 agent 报出每个象限的颜色。
// 用途：参考视频描述完全依赖 agent 的模型真的“看见”了抽帧。真实测试里，接入的本地模型把白色陶瓷杯说成“透明玻璃杯”、
// 还编出了不存在的手和字幕，而且语气非常肯定。随机色块没法靠猜或靠上下文蒙对（4 个象限、4 种颜色，全蒙对概率 1/24），
// 答不对就说明模型看不清图，那么它写的描述不可信，应当丢弃而不是展示给用户。
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export const COLORS = { 红: [220, 40, 40], 绿: [40, 170, 60], 蓝: [30, 90, 220], 黄: [245, 205, 30] };
export const QUADRANTS = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'];
const SIZE = 400;

const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** 400×400 RGB PNG，四个象限各一种纯色（无滤波，便于测试里的假 agent 直接解码） */
export function encodeQuadrantPng(colors) {
  const rows = [];
  for (let y = 0; y < SIZE; y++) {
    const row = Buffer.alloc(1 + SIZE * 3);
    for (let x = 0; x < SIZE; x++) {
      const name = colors[(y < SIZE / 2 ? 0 : 2) + (x < SIZE / 2 ? 0 : 1)];
      const [r, g, b] = COLORS[name];
      row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0); header.writeUInt32BE(SIZE, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

/** 随机生成题目：返回 { png, expected: { topLeft: '红', … } } */
export function createChallenge(random = crypto.randomInt) {
  const names = Object.keys(COLORS);
  for (let i = names.length - 1; i > 0; i--) { const j = random(0, i + 1); [names[i], names[j]] = [names[j], names[i]]; }
  const expected = Object.fromEntries(QUADRANTS.map((q, i) => [q, names[i]]));
  return { png: encodeQuadrantPng(names), expected };
}

/** 从 PNG 读出四个象限的颜色（测试里的假 agent 用它“看图”；生产代码不使用） */
export function readQuadrants(png) {
  let pos = 8; let idat = Buffer.alloc(0);
  while (pos < png.length) {
    const len = png.readUInt32BE(pos); const type = png.toString('ascii', pos + 4, pos + 8);
    if (type === 'IDAT') idat = Buffer.concat([idat, png.subarray(pos + 8, pos + 8 + len)]);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(idat);
  const pixel = (x, y) => { const o = y * (1 + SIZE * 3) + 1 + x * 3; return [raw[o], raw[o + 1], raw[o + 2]]; };
  const nearest = ([r, g, b]) => Object.entries(COLORS).sort(([, a], [, c]) => ((a[0] - r) ** 2 + (a[1] - g) ** 2 + (a[2] - b) ** 2) - ((c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2))[0][0];
  const q = SIZE / 4;
  return { topLeft: nearest(pixel(q, q)), topRight: nearest(pixel(3 * q, q)), bottomLeft: nearest(pixel(q, 3 * q)), bottomRight: nearest(pixel(3 * q, 3 * q)) };
}

/** 判分：返回 { passed, correct, wrong: [{ quadrant, expected, answered }] }；必须 4/4 才算通过 */
export function gradeAnswer(expected, answer) {
  const wrong = [];
  for (const q of QUADRANTS) {
    const said = typeof answer?.[q] === 'string' ? answer[q].trim() : '';
    if (said !== expected[q]) wrong.push({ quadrant: q, expected: expected[q], answered: said || '（没有回答）' });
  }
  return { passed: wrong.length === 0, correct: QUADRANTS.length - wrong.length, wrong };
}
