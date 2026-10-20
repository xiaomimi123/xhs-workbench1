// 收件箱模式的文本编码兜底。
// 真实测试（WorkBuddy 值守，Windows）里，网页发出的中文任务经 inbox-next 的标准输出传给 agent 时出现乱码——
// Windows 终端/PowerShell 常用 GBK 或 UTF-16，agent 的命令行工具按它自己的编码去读 UTF-8 字节，中文就坏了；
// 回写时同理（PowerShell 的重定向默认写 UTF-16）。所以：
//   1. 任务正文另存成 UTF-8（带 BOM，Windows 工具会据此识别编码）文件，agent 用读文件的工具去读，不依赖终端编码；
//   2. 回写时自动识别 UTF-8 / UTF-16 / GBK，不要求 agent 先把编码弄对。
import fs from 'node:fs';
import path from 'node:path';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** 按字节判断编码并解码：UTF-8（含 BOM）→ UTF-16（含 BOM）→ 严格 UTF-8 → GBK 回退 */
export function decodeText(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input ?? '');
  if (buf.length >= 3 && buf.subarray(0, 3).equals(BOM)) return buf.subarray(3).toString('utf8');
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) { const swapped = Buffer.from(buf.subarray(2)); swapped.swap16(); return swapped.toString('utf16le'); }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try { return new TextDecoder('gbk').decode(buf); } catch { return buf.toString('latin1'); }
  }
}

/** 把任务正文写成 UTF-8（带 BOM）文件，返回路径；顺手清理超过 keepMs 的旧文件 */
export function writeTaskFile(task, { dir, now = Date.now, keepMs = 7 * 24 * 3600 * 1000 } = {}) {
  if (!/^[\w-]+$/.test(String(task.id))) throw new Error('任务编号无效');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    try { if (now() - fs.statSync(p).mtimeMs > keepMs) fs.rmSync(p, { force: true }); } catch { /* 清理失败不影响领取 */ }
  }
  const file = path.join(dir, `${task.id}.md`);
  fs.writeFileSync(file, Buffer.concat([BOM, Buffer.from(String(task.prompt ?? ''), 'utf8')]));
  return file;
}
