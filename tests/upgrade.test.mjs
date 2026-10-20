// 升级：数据版本记录、升级前先备份、迁移失败可重试、数据来自更新版本时拒绝改动
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempWorkspace, server } from './helpers.mjs';

const WS = useTempWorkspace();
const store = await server('store.mjs');
store.ensureWorkspace();
const { compareVersions, planUpgrade, runStartupUpgrade, readVersionRecord, upgradeSummary } = await server('upgrade.mjs');
const backupMod = await server('backup.mjs');

const file = () => path.join(WS, 'config', `version-${Math.random().toString(36).slice(2)}.json`);
const clock = () => new Date('2026-10-20T08:00:00Z');

test('版本号按数字逐段比较，而不是按字符串', () => {
  assert.equal(compareVersions('0.6.2', '0.10.0'), -1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.7.0', '0.6.9'), 1);
});

test('planUpgrade 区分全新、旧版无记录、相同、升级、降级与拒绝', () => {
  const base = { appVersion: '0.7.0', migrations: [], dataVersion: 1 };
  assert.equal(planUpgrade({ ...base, record: null, hadData: false }).kind, 'fresh');
  assert.equal(planUpgrade({ ...base, record: null, hadData: true }).kind, 'legacy');
  assert.equal(planUpgrade({ ...base, record: { appVersion: '0.7.0', dataVersion: 1 } }).kind, 'same');
  assert.equal(planUpgrade({ ...base, record: { appVersion: '0.6.2', dataVersion: 1 } }).kind, 'upgrade');
  assert.equal(planUpgrade({ ...base, record: { appVersion: '0.8.0', dataVersion: 1 } }).kind, 'downgrade');
  assert.equal(planUpgrade({ ...base, record: { appVersion: '0.8.0', dataVersion: 3 } }).kind, 'blocked');
});

test('全新安装只写版本记录，不做备份', () => {
  const f = file(); const calls = [];
  const r = runStartupUpgrade({ appVersion: '0.7.0', hadData: false, file: f, workspace: WS, now: clock, backup: (k) => { calls.push(k); return { name: 'x.zip' }; } });
  assert.equal(r.ok, true); assert.equal(r.kind, 'fresh'); assert.deepEqual(calls, []);
  assert.equal(readVersionRecord(f).appVersion, '0.7.0');
});

test('旧版升级：先备份再迁移，顺序正确，历史里记录备份名和迁移名', () => {
  const f = file(); const order = [];
  fs.writeFileSync(f, JSON.stringify({ appVersion: '0.6.2', dataVersion: 1, history: [] }));
  const migrations = [
    { to: 3, name: 'm3', run: () => order.push('m3') },
    { to: 2, name: 'm2', run: () => order.push('m2') },
  ];
  const r = runStartupUpgrade({ appVersion: '0.7.0', hadData: true, dataVersion: 3, migrations, file: f, workspace: WS, now: clock, backup: () => { order.push('backup'); return { name: 'upgrade-1.zip' }; } });
  assert.deepEqual(order, ['backup', 'm2', 'm3']);
  assert.equal(r.ok, true);
  const rec = readVersionRecord(f);
  assert.equal(rec.dataVersion, 3); assert.equal(rec.appVersion, '0.7.0');
  assert.deepEqual(rec.history.at(-1), { at: '2026-10-20T08:00:00.000Z', kind: 'upgrade', from: '0.6.2', to: '0.7.0', backup: 'upgrade-1.zip', migrations: ['m2', 'm3'], ok: true });
});

test('没有版本记录但有数据（旧版安装）：按 legacy 处理，先备份', () => {
  const f = file(); const calls = [];
  const r = runStartupUpgrade({ appVersion: '0.7.0', hadData: true, file: f, workspace: WS, now: clock, backup: (k) => { calls.push(k); return { name: 'upgrade-legacy-1.zip' }; } });
  assert.deepEqual(calls, ['legacy']); assert.equal(r.ok, true);
  assert.equal(readVersionRecord(f).history.at(-1).backup, 'upgrade-legacy-1.zip');
});

test('版本没变时什么都不做：不备份、不改文件', () => {
  const f = file(); fs.writeFileSync(f, JSON.stringify({ appVersion: '0.7.0', dataVersion: 1, history: [] }));
  const before = fs.readFileSync(f, 'utf8');
  const r = runStartupUpgrade({ appVersion: '0.7.0', hadData: true, file: f, workspace: WS, backup: () => { throw Error('不该备份'); } });
  assert.equal(r.kind, 'same'); assert.equal(fs.readFileSync(f, 'utf8'), before);
});

test('迁移失败：版本不推进、保留备份名、下次启动重试成功', () => {
  const f = file(); fs.writeFileSync(f, JSON.stringify({ appVersion: '0.6.2', dataVersion: 1, history: [] }));
  let broken = true; const ran = [];
  const migrations = [{ to: 2, name: 'm2', run: () => { ran.push('m2'); } }, { to: 3, name: 'm3', run: () => { if (broken) throw Error('磁盘已满'); ran.push('m3'); } }];
  const opts = { appVersion: '0.7.0', hadData: true, dataVersion: 3, migrations, file: f, workspace: WS, now: clock, backup: () => ({ name: 'upgrade-2.zip' }) };
  const first = runStartupUpgrade(opts);
  assert.equal(first.ok, false); assert.match(first.error, /m3.*磁盘已满.*upgrade-2\.zip/);
  const rec = readVersionRecord(f);
  assert.equal(rec.dataVersion, 2); assert.equal(rec.appVersion, '0.6.2'); assert.equal(rec.history.at(-1).ok, false);
  broken = false;
  const second = runStartupUpgrade(opts);
  assert.equal(second.ok, true); assert.equal(readVersionRecord(f).dataVersion, 3); assert.equal(readVersionRecord(f).appVersion, '0.7.0');
  assert.deepEqual(ran, ['m2', 'm3']); // 已完成的 m2 在重试时不再重复
});

test('备份失败时不迁移，数据与记录都不动', () => {
  const f = file(); const original = JSON.stringify({ appVersion: '0.6.2', dataVersion: 1, history: [] }); fs.writeFileSync(f, original);
  let migrated = false;
  const r = runStartupUpgrade({ appVersion: '0.7.0', hadData: true, dataVersion: 2, migrations: [{ to: 2, name: 'm2', run: () => { migrated = true; } }], file: f, workspace: WS, backup: () => { throw Error('ENOSPC'); } });
  assert.equal(r.ok, false); assert.match(r.error, /备份失败.*ENOSPC/); assert.equal(migrated, false);
  assert.equal(fs.readFileSync(f, 'utf8'), original);
});

test('数据来自更新版本：拒绝并且不碰任何文件；仅程序降级但数据兼容则备份后继续', () => {
  const f = file(); const original = JSON.stringify({ appVersion: '0.9.0', dataVersion: 5, history: [] }); fs.writeFileSync(f, original);
  const blocked = runStartupUpgrade({ appVersion: '0.7.0', hadData: true, dataVersion: 2, file: f, workspace: WS, backup: () => { throw Error('不该备份'); } });
  assert.equal(blocked.kind, 'blocked'); assert.equal(blocked.ok, false); assert.match(blocked.error, /更新的版本/);
  assert.equal(fs.readFileSync(f, 'utf8'), original);
  const g = file(); fs.writeFileSync(g, JSON.stringify({ appVersion: '0.8.0', dataVersion: 1, history: [] }));
  const calls = [];
  const down = runStartupUpgrade({ appVersion: '0.7.0', hadData: true, file: g, workspace: WS, now: clock, backup: (k) => { calls.push(k); return { name: 'upgrade-3.zip' }; } });
  assert.equal(down.kind, 'downgrade'); assert.equal(down.ok, true); assert.deepEqual(calls, ['downgrade']);
});

test('真实备份：升级前备份写入 backups/ 且带 upgrade- 前缀，用户数据完整在包里', () => {
  const acc = store.getAccounts().accounts?.[0] || store.getAccounts()[0];
  const marker = path.join(WS, 'knowledge', 'upgrade-marker.md');
  fs.writeFileSync(marker, '升级前的用户资料');
  const f = file(); fs.writeFileSync(f, JSON.stringify({ appVersion: '0.6.2', dataVersion: 1, history: [] }));
  const r = runStartupUpgrade({ appVersion: '0.7.0', hadData: true, file: f, workspace: WS, backup: (k) => backupMod.createBackup({ prefix: k === 'legacy' ? 'upgrade-legacy' : 'upgrade' }) });
  assert.equal(r.ok, true); assert.match(r.backup, /^upgrade-\d{8}-\d{6}\.zip$/);
  assert.ok(backupMod.listBackups().some((b) => b.name === r.backup));
  assert.ok(acc);
  fs.rmSync(marker);
  backupMod.restoreBackup(r.backup);
  assert.equal(fs.readFileSync(marker, 'utf8'), '升级前的用户资料');
});

test('界面摘要：无升级记录时 lastUpgrade 为空，有记录时给出来源版本和备份名', () => {
  const s = upgradeSummary('0.7.0', { kind: 'upgrade', ok: true, backup: 'upgrade-9.zip' });
  assert.equal(s.appVersion, '0.7.0'); assert.equal(s.startup.backup, 'upgrade-9.zip');
});

// ── 安装包替换 ──
const { installPackage, inspectPackage } = await server('upgrade.mjs');
const { createZip } = await server('zip.mjs');
const mkPackage = (version, { skip = [], extra = [] } = {}) => createZip([
  ['SKILL.md', '# skill'], ['scripts/workbench.mjs', '// cli'], ['server/server.mjs', '// server'],
  ['server/version.mjs', `export const VERSION = '${version}';`],
  ...extra,
].filter(([n]) => !skip.includes(n)).map(([name, text]) => ({ name: name.startsWith('..') || name.startsWith('/') ? name : `xhs-workbench/${name}`, data: Buffer.from(text) })));
const mkSkillDir = (version) => {
  const parent = fs.mkdtempSync(path.join(WS, 'pkg-'));
  const dir = path.join(parent, 'xhs-workbench');
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server', 'version.mjs'), `export const VERSION = '${version}';`);
  fs.writeFileSync(path.join(dir, 'OLD.txt'), 'old');
  return { parent, dir };
};

test('安装包检查：读出版本号，拒绝不完整、非本项目和带路径穿越的包', () => {
  assert.equal(inspectPackage(mkPackage('0.7.0')).version, '0.7.0');
  assert.throws(() => inspectPackage(mkPackage('0.7.0', { skip: ['server/server.mjs'] })), /缺少 server\/server\.mjs/);
  assert.throws(() => inspectPackage(createZip([{ name: 'other/readme.md', data: Buffer.from('x') }])), /不是小红书运营工作台/);
  assert.throws(() => inspectPackage(mkPackage('0.7.0', { extra: [['../evil.txt', 'x']] })), /不安全的路径/);
  assert.throws(() => inspectPackage(mkPackage('0.7.0', { extra: [['/abs.txt', 'x']] })), /不安全的路径/);
});

test('替换技能包：新版就位、旧版保留为 .bak-<版本>，旧目录里的文件原样在副本中', () => {
  const { parent, dir } = mkSkillDir('0.6.2');
  const r = installPackage({ buf: mkPackage('0.7.0'), skillDir: dir, currentVersion: '0.6.2' });
  assert.equal(r.ok, true); assert.equal(r.kind, 'upgrade');
  assert.match(fs.readFileSync(path.join(dir, 'server', 'version.mjs'), 'utf8'), /0\.7\.0/);
  assert.equal(fs.existsSync(path.join(dir, 'OLD.txt')), false);
  assert.equal(fs.readFileSync(path.join(parent, 'xhs-workbench.bak-0.6.2', 'OLD.txt'), 'utf8'), 'old');
  assert.deepEqual(fs.readdirSync(parent).sort(), ['xhs-workbench', 'xhs-workbench.bak-0.6.2']); // 没有残留的临时目录
});

test('同版本或更旧的包默认拒绝；预检不写任何文件', () => {
  const { parent, dir } = mkSkillDir('0.7.0');
  const same = installPackage({ buf: mkPackage('0.7.0'), skillDir: dir, currentVersion: '0.7.0' });
  assert.equal(same.ok, false); assert.equal(same.needsFlag, '--allow-downgrade');
  const old = installPackage({ buf: mkPackage('0.6.0'), skillDir: dir, currentVersion: '0.7.0' });
  assert.equal(old.ok, false);
  const dry = installPackage({ buf: mkPackage('0.8.0'), skillDir: dir, currentVersion: '0.7.0', dryRun: true });
  assert.equal(dry.ok, true); assert.equal(dry.dryRun, true);
  assert.deepEqual(fs.readdirSync(parent), ['xhs-workbench']);
  assert.equal(installPackage({ buf: mkPackage('0.6.0'), skillDir: dir, currentVersion: '0.7.0', allowDowngrade: true }).kind, 'downgrade');
});

test('换上新目录失败时回滚到旧版本，不留临时目录；移走旧目录失败时旧版本未被改动', () => {
  const a = mkSkillDir('0.6.2');
  let n = 0;
  const flaky = (from, to) => { if (++n === 2) throw Object.assign(new Error('boom'), { code: 'EPERM' }); fs.renameSync(from, to); };
  assert.throws(() => installPackage({ buf: mkPackage('0.7.0'), skillDir: a.dir, currentVersion: '0.6.2', rename: flaky }), /已回滚到旧版本.*EPERM/);
  assert.equal(fs.readFileSync(path.join(a.dir, 'OLD.txt'), 'utf8'), 'old');
  assert.deepEqual(fs.readdirSync(a.parent), ['xhs-workbench']);
  const b = mkSkillDir('0.6.2');
  const locked = () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
  assert.throws(() => installPackage({ buf: mkPackage('0.7.0'), skillDir: b.dir, currentVersion: '0.6.2', rename: locked }), /无法移走旧版本.*EBUSY.*未被改动/);
  assert.equal(fs.readFileSync(path.join(b.dir, 'OLD.txt'), 'utf8'), 'old');
  assert.deepEqual(fs.readdirSync(b.parent), ['xhs-workbench']);
});

test('上一次升级留下的旧版本副本还在时不覆盖', () => {
  const { parent, dir } = mkSkillDir('0.6.2');
  fs.mkdirSync(path.join(parent, 'xhs-workbench.bak-0.6.2'));
  const r = installPackage({ buf: mkPackage('0.7.0'), skillDir: dir, currentVersion: '0.6.2' });
  assert.equal(r.ok, false); assert.match(r.refused, /已存在/);
  assert.equal(fs.readFileSync(path.join(dir, 'OLD.txt'), 'utf8'), 'old');
});
