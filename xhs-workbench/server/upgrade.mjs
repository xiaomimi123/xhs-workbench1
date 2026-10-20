// 升级：数据版本记录、升级前自动备份、按序迁移。
// 数据目录与技能包目录是分开的（见 paths.mjs），升级 = 替换技能包目录；
// 这里负责保证“换了新版本后，旧数据仍然安全可用”。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { P, WORKSPACE } from './paths.mjs';
import { ensureWorkspace, readJson, writeJson } from './store.mjs';
import { readZip } from './zip.mjs';

/** 数据目录结构版本。只有在磁盘数据格式发生不兼容变化时才递增，并在 MIGRATIONS 里补一条迁移。 */
export const DATA_VERSION = 1;

/** 迁移列表：{ to: 目标数据版本, name, run({ workspace }) }。必须幂等（失败后会重试）。 */
export const MIGRATIONS = [];

export const VERSION_FILE = path.join(P.config, 'version.json');
const HISTORY_LIMIT = 20;

export function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function readVersionRecord(file = VERSION_FILE) {
  return readJson(file, null);
}

/**
 * 判断这次启动属于哪种情况（纯函数）：
 *  fresh     全新安装（没有旧数据）
 *  legacy    旧版安装，之前没有版本记录
 *  same      版本没变
 *  upgrade   技能包比记录的新（或有待执行的迁移）
 *  downgrade 技能包比记录的旧，但数据格式仍兼容
 *  blocked   数据来自更新的版本，旧代码不能安全读写
 */
export function planUpgrade({ appVersion, record, hadData, dataVersion = DATA_VERSION, migrations = MIGRATIONS }) {
  if (!record) {
    return hadData
      ? { kind: 'legacy', from: null, to: appVersion, pending: migrations.filter((m) => m.to > 1) }
      : { kind: 'fresh', from: null, to: appVersion, pending: [] };
  }
  if ((record.dataVersion || 1) > dataVersion) return { kind: 'blocked', from: record.appVersion, to: appVersion, pending: [] };
  const pending = migrations.filter((m) => m.to > (record.dataVersion || 1) && m.to <= dataVersion).sort((a, b) => a.to - b.to);
  const cmp = compareVersions(appVersion, record.appVersion);
  if (cmp < 0) return { kind: 'downgrade', from: record.appVersion, to: appVersion, pending };
  if (cmp > 0 || pending.length) return { kind: 'upgrade', from: record.appVersion, to: appVersion, pending };
  return { kind: 'same', from: record.appVersion, to: appVersion, pending: [] };
}

/**
 * 启动时调用。需要改动数据的情况（legacy / upgrade / downgrade）先备份，再迁移，最后写版本记录。
 * 迁移失败时不推进版本记录（下次启动会重试），备份保留，错误写入返回值供界面展示。
 */
export function runStartupUpgrade({ appVersion, hadData, backup, migrations = MIGRATIONS, dataVersion = DATA_VERSION, file = VERSION_FILE, workspace, now = () => new Date() }) {
  const record = readVersionRecord(file);
  const plan = planUpgrade({ appVersion, record, hadData, dataVersion, migrations });
  const stamp = (extra = {}) => {
    const history = [...(record?.history || []), ...(extra.entry ? [extra.entry] : [])].slice(-HISTORY_LIMIT);
    const next = { appVersion, dataVersion: extra.dataVersion ?? (record?.dataVersion || 1), firstSeenAt: record?.firstSeenAt || now().toISOString(), history };
    writeJson(file, next);
    return next;
  };

  if (plan.kind === 'blocked') {
    return { ...plan, ok: false, error: `数据目录来自更新的版本（数据格式 v${record.dataVersion}，当前程序只认识 v${dataVersion}）。请换回新版本的技能包，或从备份恢复。为避免损坏数据，本次不会修改任何内容。` };
  }
  if (plan.kind === 'fresh') return { ...plan, ok: true, record: stamp({ dataVersion }) };
  if (plan.kind === 'same') return { ...plan, ok: true, record };

  let backupName = null;
  try {
    backupName = backup ? backup(plan.kind).name : null;
  } catch (err) {
    // 备份失败时不继续迁移：宁可不升级也不冒数据丢失的风险
    return { ...plan, ok: false, error: `升级前自动备份失败：${err.message}。为保护数据，已跳过迁移；请先释放磁盘空间或手动备份后重试。` };
  }

  let reached = record?.dataVersion || 1;
  const ran = [];
  for (const m of plan.pending) {
    try {
      m.run({ workspace });
      reached = m.to;
      ran.push(m.name);
    } catch (err) {
      const entry = { at: now().toISOString(), kind: plan.kind, from: plan.from, to: appVersion, backup: backupName, migrations: ran, ok: false, error: String(err.message || err).slice(0, 300) };
      const failed = { appVersion: record?.appVersion || appVersion, dataVersion: reached, firstSeenAt: record?.firstSeenAt || now().toISOString(), history: [...(record?.history || []), entry].slice(-HISTORY_LIMIT) };
      writeJson(file, failed);
      return { ...plan, ok: false, backup: backupName, error: `迁移「${m.name}」失败：${entry.error}。数据已在升级前备份（${backupName}），可用 restore 恢复。` };
    }
  }
  const entry = { at: now().toISOString(), kind: plan.kind, from: plan.from, to: appVersion, backup: backupName, migrations: ran, ok: true };
  return { ...plan, ok: true, backup: backupName, migrated: ran, record: stamp({ entry, dataVersion: Math.max(reached, record?.dataVersion || 1) }) };
}

/**
 * 命令行用的初始化：全新安装时立刻登记版本。
 * 否则 setup 先创建了数据目录、服务再启动时就分不清“全新安装”和“旧版遗留数据”，会把全新安装误当成旧版升级。
 */
export function ensureWorkspaceStamped(appVersion) {
  const hadData = fs.existsSync(P.accounts);
  ensureWorkspace();
  if (!hadData && !readVersionRecord()) runStartupUpgrade({ appVersion, hadData: false, workspace: WORKSPACE });
}

/** 给界面和 doctor 用的摘要 */
export function upgradeSummary(appVersion, last = null) {
  const record = readVersionRecord();
  const lastEntry = record?.history?.at(-1) || null;
  return {
    appVersion,
    dataVersion: record?.dataVersion || DATA_VERSION,
    firstSeenAt: record?.firstSeenAt || null,
    lastUpgrade: lastEntry && lastEntry.kind !== 'fresh' ? lastEntry : null,
    startup: last ? { kind: last.kind, ok: last.ok, error: last.error || null, backup: last.backup || null } : null,
  };
}

// ---------- 技能包替换 ----------

const REQUIRED_IN_PACKAGE = ['SKILL.md', 'scripts/workbench.mjs', 'server/server.mjs', 'server/version.mjs'];

/** 检查新版本 zip：结构、版本号、路径安全。不写任何文件。 */
export function inspectPackage(buf) {
  const entries = readZip(buf);
  const bad = entries.find((e) => e.name.startsWith('/') || /^[A-Za-z]:/.test(e.name) || e.name.split('/').includes('..') || e.name.includes(String.fromCharCode(92)));
  if (bad) throw new Error(`安装包含不安全的路径：${bad.name}`);
  const skill = entries.find((e) => /^[^/]+\/SKILL\.md$/.test(e.name));
  if (!skill) throw new Error('这不是小红书运营工作台的安装包（找不到 SKILL.md）');
  const prefix = skill.name.slice(0, skill.name.indexOf('/') + 1);
  const rel = entries.filter((e) => e.name.startsWith(prefix)).map((e) => ({ path: e.name.slice(prefix.length), data: e.data }));
  for (const need of REQUIRED_IN_PACKAGE) if (!rel.some((e) => e.path === need)) throw new Error(`安装包不完整，缺少 ${need}`);
  const version = (/export const VERSION = '([\d.]+)'/.exec(rel.find((e) => e.path === 'server/version.mjs').data.toString('utf8')) || [])[1];
  if (!version) throw new Error('无法读取安装包的版本号');
  return { version, files: rel, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

/**
 * 用新包替换技能包目录：先解压到同级临时目录并校验，再把旧目录改名为 .bak-<旧版本>、新目录改名顶上。
 * 任何一步失败都回滚到旧目录，数据目录（用户资料）不在这个目录里，不受影响。
 * dryRun 只检查并返回计划。
 */
export function installPackage({ buf, skillDir, currentVersion, allowDowngrade = false, dryRun = false, rename = fs.renameSync }) {
  const pkg = inspectPackage(buf);
  const cmp = compareVersions(pkg.version, currentVersion);
  const parent = path.dirname(skillDir);
  const base = path.basename(skillDir);
  const plan = { from: currentVersion, to: pkg.version, sha256: pkg.sha256, files: pkg.files.length, kind: cmp > 0 ? 'upgrade' : cmp === 0 ? 'reinstall' : 'downgrade', oldCopy: path.join(parent, `${base}.bak-${currentVersion}`) };
  if (cmp <= 0 && !allowDowngrade) return { ...plan, ok: false, refused: cmp === 0 ? '安装包版本与当前相同' : '安装包比当前版本旧', needsFlag: '--allow-downgrade' };
  if (dryRun) return { ...plan, ok: true, dryRun: true };
  if (fs.existsSync(plan.oldCopy)) return { ...plan, ok: false, refused: `${plan.oldCopy} 已存在，请先移走或删除它（它是上一次升级留下的旧版本副本）` };

  const staging = path.join(parent, `.${base}.new-${pkg.version}`);
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    for (const f of pkg.files) {
      const to = path.join(staging, f.path);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, f.data);
    }
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(`解压新版本失败：${err.message}`);
  }
  try {
    rename(skillDir, plan.oldCopy);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(`无法移走旧版本（${err.code || err.message}）。请先关闭工作台，并确认没有终端或编辑器停留在技能包目录里，然后重试。旧版本未被改动。`);
  }
  try {
    rename(staging, skillDir);
  } catch (err) {
    try { rename(plan.oldCopy, skillDir); } catch { /* 回滚也失败时，旧版本仍完整保存在 oldCopy */ }
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(`替换失败并已回滚到旧版本：${err.code || err.message}`);
  }
  return { ...plan, ok: true };
}
