// 外部程序（ffmpeg / ffprobe 等）的定位：先查 PATH，再查各系统常见的安装位置。
// 这样用户刚装完、还没重开终端（PATH 未刷新）时，工作台也能找到。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 各平台的常见安装目录（含通配的一级子目录，如 C:\Users\x\ffmpeg\ffmpeg-9.0-essentials_build\bin） */
export function commonBinDirs({ platform = process.platform, env = process.env, home = os.homedir(), exists = fs.existsSync, list = (d) => fs.readdirSync(d) } = {}) {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const dirs = [
      path.join(local, 'Microsoft', 'WinGet', 'Links'),
      path.join(home, 'scoop', 'shims'),
      path.join(env.ProgramData || 'C:\ProgramData', 'chocolatey', 'bin'),
      'C:\ffmpeg\bin',
      path.join(env.ProgramFiles || 'C:\Program Files', 'ffmpeg', 'bin'),
    ];
    for (const root of [path.join(home, 'ffmpeg'), 'C:\ffmpeg']) {
      try { if (exists(root)) for (const sub of list(root)) dirs.push(path.join(root, sub, 'bin')); } catch { /* 忽略不可读目录 */ }
    }
    return dirs;
  }
  return [path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
}

/** 返回可执行文件的绝对路径；找不到返回 null。所有外部依赖可注入，便于测试。 */
export function findBinary(name, opts = {}) {
  const { platform = process.platform, exists = fs.existsSync, run = spawnSync } = opts;
  const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const res = platform === 'win32' ? run('where', [name], { encoding: 'utf8' }) : run('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  const onPath = res && res.status === 0 && String(res.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  if (onPath) return onPath;
  for (const dir of commonBinDirs(opts)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      if (exists(file)) return file;
    }
  }
  return null;
}
