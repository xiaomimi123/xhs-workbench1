// 备份与恢复：把数据目录打成 zip（不含浏览器登录资料、日志、临时文件、回收站）
import fs from 'node:fs';
import path from 'node:path';
import { P, WORKSPACE } from './paths.mjs';
import { ensureDir, httpError, moveToTrash } from './store.mjs';
import { createZip, readZip } from './zip.mjs';

export const BACKUP_DIR = path.join(WORKSPACE, 'backups');
const KEEP_AUTO = 7;

// 备份范围：顶层目录白名单
const INCLUDE = ['config', 'accounts', 'knowledge', 'chats'];
// 恢复时保留本机的连接配置（agent 路径因电脑而异）
const MACHINE_SPECIFIC = [/^config\/bridge\.json$/, /^config\/mcp(\/|\.json$)/];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else if (e.isFile() && !e.name.endsWith('.tmp')) out.push(abs);
  }
  return out;
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 生成备份，返回 { name, size, files } */
export function createBackup({ auto = false } = {}) {
  const files = INCLUDE.flatMap((d) => walk(path.join(WORKSPACE, d)));
  const entries = files.map((abs) => ({
    name: path.relative(WORKSPACE, abs).split(path.sep).join('/'),
    data: fs.readFileSync(abs),
    mtime: fs.statSync(abs).mtime,
  }));
  entries.push({ name: 'backup.json', data: Buffer.from(JSON.stringify({ app: 'xhs-workbench', createdAt: new Date().toISOString(), auto, files: entries.length }, null, 2)) });
  ensureDir(BACKUP_DIR);
  const name = `${auto ? 'auto' : 'backup'}-${stamp()}.zip`;
  const buf = createZip(entries);
  fs.writeFileSync(path.join(BACKUP_DIR, name), buf);
  if (auto) pruneAuto();
  return { name, size: buf.length, files: entries.length - 1 };
}

function pruneAuto() {
  const autos = listBackups().filter((b) => b.name.startsWith('auto-'));
  for (const b of autos.slice(KEEP_AUTO)) moveToTrash(path.join(BACKUP_DIR, b.name), 'backups', { label: `自动备份：${b.name}` });
}

export function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.zip'))
    .map((f) => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      return { name: f, size: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function backupFile(name) {
  if (!/^[\w.-]+\.zip$/.test(name || '')) throw httpError(400, '备份文件名不合法');
  const file = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(file)) throw httpError(404, '备份不存在');
  return file;
}

/** 到期就做一次自动备份（每天一次） */
export function autoBackupIfDue() {
  const last = listBackups().find((b) => b.name.startsWith('auto-'));
  if (last && Date.now() - new Date(last.createdAt).getTime() < 24 * 3600_000) return null;
  return createBackup({ auto: true });
}

/**
 * 从备份恢复：当前数据先整体移入回收站（可撤销），再解压备份；本机连接配置保留。
 * source：backups/ 下的文件名，或一个 zip 文件的绝对路径
 */
export function restoreBackup(source) {
  const file = path.isAbsolute(source) ? source : backupFile(source);
  const entries = readZip(fs.readFileSync(file));
  const meta = entries.find((e) => e.name === 'backup.json');
  if (!meta || JSON.parse(meta.data.toString('utf8')).app !== 'xhs-workbench') throw httpError(400, '这不是小红书运营工作台的备份文件');

  // 先保存本机配置
  const keep = new Map();
  for (const f of walk(P.config)) {
    const rel = path.relative(WORKSPACE, f).split(path.sep).join('/');
    if (MACHINE_SPECIFIC.some((re) => re.test(rel))) keep.set(rel, fs.readFileSync(f));
  }
  for (const d of INCLUDE) {
    const abs = path.join(WORKSPACE, d);
    if (fs.existsSync(abs)) moveToTrash(abs, 'restore', { label: `恢复备份前的 ${d}/（${path.basename(file)}）` });
  }
  let count = 0;
  for (const e of entries) {
    if (e.name === 'backup.json' || MACHINE_SPECIFIC.some((re) => re.test(e.name))) continue;
    const top = e.name.split('/')[0];
    if (!INCLUDE.includes(top) || e.name.split('/').includes('..')) continue;
    const to = path.join(WORKSPACE, e.name);
    ensureDir(path.dirname(to));
    fs.writeFileSync(to, e.data);
    count++;
  }
  for (const [rel, data] of keep) {
    const to = path.join(WORKSPACE, rel);
    ensureDir(path.dirname(to));
    fs.writeFileSync(to, data);
  }
  return { restored: count, from: path.basename(file) };
}

