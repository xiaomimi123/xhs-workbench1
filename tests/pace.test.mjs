// 采集节奏与额度（pace.mjs）：总开关、冷静期、时段、每日上限、采集间隔、账本、读太快、旧版冷静期迁移
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempWorkspace, server } from './helpers.mjs';

const WS = useTempWorkspace();
const store = await server('store.mjs'); store.ensureWorkspace();
const pace = await server('pace.mjs');
const acct = (name = '节奏') => store.saveAccount({ name }).id;
const at = (h, m = 0, day = 15) => new Date(2026, 9, day, h, m, 0, 0);   // 本地时间 2026-10-15 h:m

test('新账号默认总开关关着；打开后在时段内可以开始，今天还能读多少写得清楚', () => {
  const id = acct();
  const off = pace.paceSummary(id, at(10));
  assert.equal(off.status, 'block'); assert.match(off.reason, /总开关是关着的/);
  const s = pace.updatePolicy(id, { enabled: true }, at(10));
  assert.equal(s.status, 'go'); assert.match(s.reason, /笔记 10 篇、主页 3 个/);
  assert.deepEqual(s.limits, { ...pace.DEFAULT_LIMITS });
});

test('时段：不在 09:00–22:30 先别开始（wait）', () => {
  const id = acct();
  pace.updatePolicy(id, { enabled: true });
  assert.equal(pace.paceSummary(id, at(8, 59)).status, 'wait');
  assert.equal(pace.paceSummary(id, at(9, 0)).status, 'go');
  assert.equal(pace.paceSummary(id, at(22, 30)).status, 'go');
  const late = pace.paceSummary(id, at(22, 31));
  assert.equal(late.status, 'wait'); assert.match(late.reason, /09:00–22:30/);
});

test('冷静期：按天设，期间一律 block，到期后恢复；总开关不会被冷静期自动打开', () => {
  const id = acct();
  pace.updatePolicy(id, { enabled: true });
  const s = pace.updatePolicy(id, { cooldownDays: 7, cooldownReason: '收到平台提示' }, at(10, 0, 15));
  assert.equal(s.status, 'block'); assert.match(s.reason, /冷静期内（收到平台提示）.*7 天/);
  assert.equal(s.cooldown.active, true);
  assert.equal(pace.paceSummary(id, at(10, 0, 21)).status, 'block');      // 第 6 天
  assert.equal(pace.paceSummary(id, at(9, 59, 22)).status, 'block');      // 7×24 小时到点之前还在
  const after = pace.paceSummary(id, at(10, 1, 22));
  assert.equal(after.status, 'go'); assert.equal(after.cooldown.active, false);
  assert.equal(pace.updatePolicy(id, { clearCooldown: true }).cooldown, null);
  assert.throws(() => pace.updatePolicy(id, { cooldownDays: 0 }), /1–60 天/);
});

test('每日上限和采集间隔：用账本里工作台自己记的数', () => {
  const id = acct();
  pace.updatePolicy(id, { enabled: true });
  pace.recordSession(id, 'b_1', at(10, 0));
  const soon = pace.paceSummary(id, at(11, 0));
  assert.equal(soon.status, 'wait'); assert.match(soon.reason, /至少隔 180 分钟，还要等约 120 分钟/); assert.equal(soon.waitMin, 120);
  assert.equal(pace.paceSummary(id, at(13, 1)).status, 'go');
  // 读了 10 篇笔记 → 当天上限；第二天清零
  for (let i = 0; i < 10; i++) pace.recordObservation(id, { url: 'https://www.xiaohongshu.com/user/profile/x', notes: [{ url: `https://www.xiaohongshu.com/explore/n${i}?xsec_token=SECRET` }] }, at(14, i * 5));
  const full = pace.paceSummary(id, at(20, 0));
  assert.equal(full.status, 'block'); assert.match(full.reason, /笔记已读 10 篇，到了上限 10 篇/);
  assert.equal(full.today.notes, 10);
  assert.equal(pace.paceSummary(id, at(10, 0, 16)).status, 'go');
  // 主页上限
  const id2 = acct('主页上限');
  pace.updatePolicy(id2, { enabled: true });
  for (let i = 0; i < 3; i++) pace.recordObservation(id2, { url: `https://www.xiaohongshu.com/user/profile/p${i}`, profile: { bio: '简介' } }, at(10, i * 10));
  assert.match(pace.paceSummary(id2, at(20, 0)).reason, /主页已读 3 个，到了上限 3 个/);
});

test('账本只存去掉参数的链接（xsec_token 不落盘），对话里的浏览只记数不拦', () => {
  const id = acct();
  pace.updatePolicy(id, { enabled: true });
  pace.recordObservation(id, { notes: [{ url: 'https://www.xiaohongshu.com/explore/abc123?xsec_token=SECRET&xsec_source=pc' }] }, at(10));
  pace.recordChat(id, at(10, 30));
  const ledger = fs.readFileSync(path.join(WS, 'accounts', id, 'pace-ledger.jsonl'), 'utf8');
  assert.match(ledger, /explore\/abc123/); assert.doesNotMatch(ledger, /SECRET|xsec/);
  const s = pace.paceSummary(id, at(20));
  assert.equal(s.today.chats, 1); assert.equal(s.today.notes, 1);
});

test('读得太快：两篇笔记检查点相隔不到 20 秒就通知停手；间隔够、一份里装多篇、补合并的旧检查点都不触发', async () => {
  const id = acct();
  const events = [];
  pace.onPaceViolation((e) => events.push(e));
  const note = (n) => ({ notes: [{ url: `https://www.xiaohongshu.com/explore/${n}` }] });
  const t0 = Date.now();
  pace.recordObservation(id, note('a'), new Date(t0 - 60_000));
  assert.equal(pace.recordObservation(id, note('b'), new Date(t0 - 30_000)).violation, null);          // 间隔 30 秒：可以
  const fast = pace.recordObservation(id, note('c'), new Date(t0 - 20_000));                           // 间隔 10 秒：太快
  assert.deepEqual(fast.violation, { gapSec: 10, min: 20 });
  await new Promise((r) => setImmediate(r));
  assert.equal(events.length, 1); assert.equal(events[0].accountId, id);
  // 一份里装了多篇：看不出间隔
  assert.equal(pace.recordObservation(id, { notes: [{ url: 'https://www.xiaohongshu.com/explore/d' }, { url: 'https://www.xiaohongshu.com/explore/e' }] }, new Date(t0 - 19_000)).violation, null);
  // 补合并的旧检查点：账本里记违规，但不再叫停（事情是几个小时前发生的）
  const old = acct('旧检查点');
  pace.recordObservation(old, note('x'), new Date(t0 - 4 * 3600_000));
  assert.ok(pace.recordObservation(old, note('y'), new Date(t0 - 4 * 3600_000 + 3000)).violation);
  await new Promise((r) => setImmediate(r));
  assert.equal(events.length, 1);
  pace.onPaceViolation(null);
});

test('上限可以调，但有边界；时段格式要对', () => {
  const id = acct();
  const s = pace.updatePolicy(id, { limits: { notesPerDay: 6, gapMin: 240, windowStart: '10:00', windowEnd: '21:00' } });
  assert.equal(s.limits.notesPerDay, 6); assert.equal(s.limits.gapMin, 240); assert.equal(s.limits.profilesPerDay, 3);
  assert.throws(() => pace.updatePolicy(id, { limits: { notesPerDay: 99 } }), /1–30/);
  assert.throws(() => pace.updatePolicy(id, { limits: { gapMin: 5 } }), /30–1440/);
  assert.throws(() => pace.updatePolicy(id, { limits: { windowStart: '9点' } }), /09:00/);
  assert.throws(() => pace.updatePolicy(id, { limits: { windowStart: '22:00', windowEnd: '08:00' } }), /早于/);
  assert.equal(pace.readPolicy(id).limits.notesPerDay, 6);   // 失败的修改不改已有设置
});

test('策略文件损坏按「禁止」处理，不能因为文件坏了就放开', () => {
  const id = acct();
  pace.updatePolicy(id, { enabled: true });
  fs.writeFileSync(path.join(WS, 'accounts', id, 'pace-policy.json'), '{坏了');
  const s = pace.paceSummary(id, at(10));
  assert.equal(s.status, 'block'); assert.match(s.reason, /策略文件损坏/);
});

test('员工电脑上旧版本（本地补丁）的 browse-cooldown.json 升级后冷静期不丢；它里面的「开着」才算开', () => {
  const id = acct('旧冷静期');
  const dir = path.join(WS, 'accounts', id);
  fs.mkdirSync(dir, { recursive: true });
  const until = new Date(Date.now() + 5 * 86400_000).toISOString();
  fs.writeFileSync(path.join(dir, 'browse-cooldown.json'), JSON.stringify({ until, reason: '账号被平台提示', enabled: true }));
  const p = pace.readPolicy(id);
  assert.equal(p.cooldownUntil, until); assert.equal(p.cooldownReason, '账号被平台提示'); assert.equal(p.enabled, true);
  assert.ok(fs.existsSync(path.join(dir, 'browse-cooldown.json.migrated')) && !fs.existsSync(path.join(dir, 'browse-cooldown.json')));
  assert.equal(pace.paceSummary(id, at(10)).status, 'block');
  // 旧文件里没写 enabled（旧版本缺省算开）：新版本缺省是关，不替用户打开
  const id2 = acct('旧冷静期2');
  fs.mkdirSync(path.join(WS, 'accounts', id2), { recursive: true });
  fs.writeFileSync(path.join(WS, 'accounts', id2, 'browse-cooldown.json'), JSON.stringify({ until }));
  assert.equal(pace.readPolicy(id2).enabled, false);
});

test('不能开始就抛 409 并说明原因；给 agent 的提示词带着具体数字', () => {
  const id = acct();
  assert.throws(() => pace.assertCollectionAllowed(id, at(10)), (e) => e.status === 409 && /总开关/.test(e.message));
  pace.updatePolicy(id, { enabled: true });
  assert.equal(pace.assertCollectionAllowed(id, at(10)).status, 'go');
  const text = pace.paceInstructions(pace.DEFAULT_LIMITS);
  assert.match(text, /笔记最多 5 篇、主页最多 2 个/); assert.match(text, /至少隔 25 秒/); assert.match(text, /立刻停止/);
  assert.match(pace.paceText(pace.paceSummary(id, at(10))), /✅ 可以开始/);
});

test('接了中枢（HUB_APP_STATE_DIR）时策略和账本放在状态目录，agent 碰不到的那一边；账号数据目录里不留一份', () => {
  const state = fs.mkdtempSync(path.join(WS, 'state-'));
  const id = acct('状态目录');
  process.env.HUB_APP_STATE_DIR = state;
  try {
    pace.updatePolicy(id, { enabled: true });
    pace.recordSession(id, 'b_1');
    assert.ok(fs.existsSync(path.join(state, 'accounts', id, 'pace-policy.json')));
    assert.ok(fs.existsSync(path.join(state, 'accounts', id, 'pace-ledger.jsonl')));
    assert.ok(!fs.existsSync(path.join(WS, 'accounts', id, 'pace-policy.json')));
    assert.equal(pace.readPolicy(id).enabled, true);
  } finally { delete process.env.HUB_APP_STATE_DIR; }
});

test('命令行前置检查只读：退出码 0 / 2 / 3，不能改任何设置', async () => {
  const { spawnSync } = await import('node:child_process');
  const id = acct('命令行');
  const run = (...args) => spawnSync(process.execPath, [path.join(process.cwd(), 'xhs-workbench/scripts/pace-check.mjs'), '--account', id, ...args], { env: { ...process.env, XHS_WORKSPACE: WS }, encoding: 'utf8' });
  let r = run();
  assert.equal(r.status, 3); assert.match(r.stdout, /现在不能采集/);
  pace.updatePolicy(id, { enabled: true, limits: { windowStart: '00:00', windowEnd: '23:59' } });
  r = run('--json');
  assert.equal(r.status, 0); assert.equal(JSON.parse(r.stdout).status, 'go');
  pace.recordSession(id, 'b_1');
  assert.equal(run().status, 2);
  assert.equal(run('--clear-cooldown', '--yes').status, 2);   // 没有这类参数：照样只是检查，不会改任何东西
  assert.equal(pace.readPolicy(id).enabled, true);
});
