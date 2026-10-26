// 采集节奏与额度：给「自动读取小红书」设硬上限，并让人随时看得见、叫得停。
//
// 为什么要有：2026-10-23 员工的品牌号被平台提示「浏览行为与真人操作习惯不一致」。核对检查点后确认，当时是 agent 通过浏览器插件在
// 44 秒里连开 5 篇笔记（手册只写了「有界随机间隔」，没有数字）。这里把「能读多少、多久读一次、什么时段读、出了事停多久」写成代码里的数。
//
// 做什么：总开关 / 冷静期 / 时段 / 每天笔记和主页上限 / 两次采集的最小间隔，决定能不能开始（go / wait / block）；
//   账本由工作台自己写（派发采集、合并检查点时记），不靠 agent 自觉上报。
// 不做什么：这不是「让自动化更像真人」的东西，也不保证不触发平台风控——它只是把量压低、让人确认、出事能复盘。
//   agent 在一次会话里每一步怎么点，工作台管不到，能管的是「什么时候开始、一天读多少」和「两篇检查点来得太快就停手」。
//
// 放哪：和访问锁一样放在状态目录（HUB_APP_STATE_DIR，agent 碰不到）；没接中枢 / 测试时放账号数据目录。
import fs from 'node:fs';
import path from 'node:path';
import { accountDir } from './paths.mjs';
import { readJson, httpError } from './store.mjs';
import { stateRoot } from './access-policy.mjs';

export const DEFAULT_LIMITS = Object.freeze({
  notesPerDay: 10,        // 每天最多读几篇笔记
  profilesPerDay: 3,      // 每天最多读几个主页
  sessionNotes: 5,        // 一次会话（一个对标目标）最多读几篇笔记
  sessionProfiles: 2,     // 一次会话最多读几个主页
  gapMin: 180,            // 两次采集会话之间至少隔多少分钟
  windowStart: '09:00',   // 只在这个时段采集
  windowEnd: '22:30',
  minNoteGapSec: 20,      // 两篇笔记的检查点到达间隔低于这个秒数 = 读得太快，自动停手
});
const BOUNDS = {
  notesPerDay: [1, 30], profilesPerDay: [1, 10], sessionNotes: [1, 5], sessionProfiles: [1, 3], gapMin: [30, 1440], minNoteGapSec: [10, 600],
};
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_LEDGER_BYTES = 256 * 1024;

function safeId(id) {
  if (!/^[\w-]+$/.test(id || '')) throw httpError(400, '账号 id 不合法');
  return id;
}
function dirOf(id) {
  safeId(id);
  const root = stateRoot();
  return root ? path.join(root, 'accounts', id) : accountDir(id);
}
const policyFile = (id) => path.join(dirOf(id), 'pace-policy.json');
const ledgerFile = (id) => path.join(dirOf(id), 'pace-ledger.jsonl');

// ---------- 策略（总开关、冷静期、上限） ----------

function normalizeLimits(input = {}) {
  const out = { ...DEFAULT_LIMITS };
  for (const [key, [lo, hi]] of Object.entries(BOUNDS)) {
    if (input[key] === undefined) continue;
    const n = Number(input[key]);
    if (!Number.isInteger(n) || n < lo || n > hi) throw httpError(400, `「${key}」要在 ${lo}–${hi} 之间`);
    out[key] = n;
  }
  for (const key of ['windowStart', 'windowEnd']) {
    if (input[key] === undefined) continue;
    if (!HHMM.test(String(input[key]))) throw httpError(400, '时段格式要写成 09:00');
    out[key] = String(input[key]);
  }
  if (out.windowStart >= out.windowEnd) throw httpError(400, '开始时间要早于结束时间');
  return out;
}

/** 旧版（员工电脑上的本地补丁）把总开关和冷静期写在账号目录的 browse-cooldown.json：第一次读时搬过来，免得升级后冷静期悄悄没了 */
function migrateLegacy(id) {
  const legacy = path.join(accountDir(id), 'browse-cooldown.json');
  if (!fs.existsSync(legacy) || fs.existsSync(policyFile(id))) return;
  try {
    const old = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    const next = { enabled: old.enabled === true, cooldownUntil: typeof old.until === 'string' && old.until ? old.until : null,
      cooldownReason: String(old.reason || '').slice(0, 120), limits: {}, updatedAt: new Date().toISOString(), migratedFrom: 'browse-cooldown.json' };
    fs.mkdirSync(dirOf(id), { recursive: true });
    fs.writeFileSync(policyFile(id), JSON.stringify(next, null, 2));
    fs.renameSync(legacy, `${legacy}.migrated`);
  } catch { /* 搬不动就按默认值处理，不影响启动 */ }
}

/** 读策略。文件损坏时按「禁止」处理（宁可停，不能因为文件坏了就放开） */
export function readPolicy(id) {
  migrateLegacy(id);
  const file = policyFile(id);
  if (!fs.existsSync(file)) return { enabled: false, cooldownUntil: null, cooldownReason: '', limits: { ...DEFAULT_LIMITS }, updatedAt: null, broken: false };
  const raw = readJson(file, null);
  if (!raw || typeof raw !== 'object') {
    return { enabled: false, cooldownUntil: null, cooldownReason: '', limits: { ...DEFAULT_LIMITS }, updatedAt: null, broken: true };
  }
  let limits;
  try { limits = normalizeLimits(raw.limits || {}); } catch { limits = { ...DEFAULT_LIMITS }; }
  return {
    enabled: raw.enabled === true,
    cooldownUntil: typeof raw.cooldownUntil === 'string' && !Number.isNaN(Date.parse(raw.cooldownUntil)) ? raw.cooldownUntil : null,
    cooldownReason: String(raw.cooldownReason || '').slice(0, 120),
    limits, updatedAt: raw.updatedAt || null, broken: false,
  };
}

function writePolicyFile(id, policy) {
  fs.mkdirSync(dirOf(id), { recursive: true });
  const tmp = `${policyFile(id)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...policy, updatedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, policyFile(id));
}

/** 改策略：{enabled?, cooldownDays?, cooldownReason?, clearCooldown?, limits?}。冷静期按「天」设：从现在起算 N×24 小时 */
export function updatePolicy(id, patch = {}, now = new Date()) {
  const cur = readPolicy(id);
  const next = { enabled: cur.enabled, cooldownUntil: cur.cooldownUntil, cooldownReason: cur.cooldownReason, limits: { ...cur.limits } };
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') throw httpError(400, '总开关只能是开或关');
    next.enabled = patch.enabled;
  }
  if (patch.clearCooldown === true) { next.cooldownUntil = null; next.cooldownReason = ''; }
  if (patch.cooldownDays !== undefined) {
    const days = Number(patch.cooldownDays);
    if (!Number.isInteger(days) || days < 1 || days > 60) throw httpError(400, '冷静期要设 1–60 天');
    next.cooldownUntil = new Date(now.getTime() + days * 86400_000).toISOString();
    next.cooldownReason = String(patch.cooldownReason || '手动设置').slice(0, 120);
  }
  if (patch.limits !== undefined) next.limits = normalizeLimits({ ...cur.limits, ...patch.limits });
  writePolicyFile(id, next);
  return paceSummary(id, now);
}

// ---------- 账本（工作台自己记） ----------

function appendLedger(id, row) {
  try {
    const file = ledgerFile(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
    if (fs.statSync(file).size > MAX_LEDGER_BYTES) {
      const keep = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-1500);
      fs.writeFileSync(file, `${keep.join('\n')}\n`);
    }
  } catch { /* 账本写不进去不能挡住主流程 */ }
}

function readLedger(id) {
  try {
    return fs.readFileSync(ledgerFile(id), 'utf8').trim().split('\n').filter(Boolean).slice(-2000)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter((r) => r && r.at && r.kind);
  } catch { return []; }
}

/** 记一次采集会话开始（队列派发一个对标目标 / 用户点了「核实主页」）。ref 只放对标 id 这类内部标识 */
export function recordSession(id, ref = '', now = new Date()) {
  appendLedger(id, { at: now.toISOString(), kind: 'session', ref: String(ref).slice(0, 80) });
}

/** 记一次带浏览器能力的普通对话（只记、不拦；不一定真的访问了网页，界面上这么写） */
export function recordChat(id, now = new Date()) {
  appendLedger(id, { at: now.toISOString(), kind: 'chat' });
}

const noteKey = (url) => { try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return ''; } };  // 去掉 xsec_token 等参数再留痕

let listener = null;
/** 只给开发和自动测试用：关掉「时段 / 采集间隔 / 读得太快」三项（测试里检查点是一口气写出来的，也不会等 3 小时）；总开关、冷静期、每日上限仍然生效。生产里不要设 */
const relaxed = () => process.env.XHS_PACE_RELAX === '1';
/** 出事时的回调（读太快）。服务端注册：暂停队列、取消正在跑的 agent 任务 */
export function onPaceViolation(fn) { listener = typeof fn === 'function' ? fn : null; }

/**
 * 检查点合并成功后调用：按检查点里读到的内容记「主页 / 笔记」。
 * 逐篇写检查点的 agent，两篇之间的间隔就是它读一篇的时间：低于下限说明在连发，立刻通知停手。
 * 一份检查点里装了多篇（agent 读完再一起写）看不出间隔，只记数，不判断。
 * now 是检查点文件的写入时间（不是合并时间）：一次合并好几份时不会因为「同时处理」被当成连发。
 */
export function recordObservation(id, entry, now = new Date()) {
  const notes = Array.isArray(entry?.notes) ? entry.notes : [];
  const policy = readPolicy(id);
  const rows = readLedger(id);
  let violation = null;
  if (entry?.profile && typeof entry.profile === 'object') {
    appendLedger(id, { at: now.toISOString(), kind: 'profile', ref: noteKey(entry.url) });
  }
  if (notes.length) {
    // 前一篇 = 到达时间不晚于这一份的最近一篇（重启后补合并的旧检查点按它们自己的写入时间排，不是按合并时间）
    const lastNote = rows.filter((r) => r.kind === 'note' && new Date(r.at) <= now).sort((a, b) => a.at.localeCompare(b.at)).at(-1);
    if (notes.length === 1 && lastNote && !relaxed()) {
      const gapSec = (now.getTime() - new Date(lastNote.at).getTime()) / 1000;
      if (gapSec >= 0 && gapSec < policy.limits.minNoteGapSec) violation = { gapSec: Math.round(gapSec), min: policy.limits.minNoteGapSec };
    }
    for (const note of notes) appendLedger(id, { at: now.toISOString(), kind: 'note', ref: noteKey(note?.url) });
  }
  if (violation) {
    appendLedger(id, { at: now.toISOString(), kind: 'violation', ref: `笔记间隔 ${violation.gapSec} 秒 < ${violation.min} 秒` });
    // 只有刚刚发生的才叫停：服务重启后补合并的旧检查点（哪怕当时就读得快）不该再触发一次停手。
    // 回调放到下一轮事件循环：它会取消 agent 任务，而取消又会触发一次检查点合并——不能在正在合并的循环里重入
    if (Date.now() - now.getTime() < 120_000 && !relaxed()) {
      const event = { accountId: id, ...violation };
      setImmediate(() => { try { listener?.(event); } catch { /* 回调出错不影响检查点 */ } });
    }
  }
  return { violation };
}

// ---------- 判定 ----------

const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
function agoText(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  if (m < 1440) return `${Math.floor(m / 60)} 小时 ${m % 60} 分钟前`;
  return `${Math.floor(m / 1440)} 天前`;
}

/** 现在这个账号能不能开始采集。status: go 可以 / wait 过一会儿 / block 现在不行（要人处理） */
export function paceSummary(id, now = new Date()) {
  const policy = readPolicy(id);
  const L = policy.limits;
  const rows = readLedger(id);
  const today = dayKey(now);
  let notes = 0; let profiles = 0; let chats = 0; let last = null; const days = new Map();
  for (const r of rows) {
    const t = new Date(r.at);
    if (Number.isNaN(t.getTime())) continue;
    const key = dayKey(t);
    const bucket = days.get(key) || { notes: 0, profiles: 0 };
    if (r.kind === 'note') { bucket.notes++; if (key === today) notes++; }
    if (r.kind === 'profile') { bucket.profiles++; if (key === today) profiles++; }
    if (r.kind === 'chat' && key === today) chats++;
    if (['session', 'note', 'profile'].includes(r.kind) && (!last || t > last)) last = t;
    days.set(key, bucket);
  }
  const cooldownActive = policy.cooldownUntil && new Date(policy.cooldownUntil).getTime() > now.getTime();
  const base = {
    account: id, enabled: policy.enabled, limits: L,
    cooldown: policy.cooldownUntil ? { until: policy.cooldownUntil, reason: policy.cooldownReason, active: !!cooldownActive } : null,
    lastAt: last ? last.toISOString() : null, lastAgoText: last ? agoText(now - last) : '没有记录',
    today: { notes, profiles, chats }, week: [...days.entries()].sort().slice(-7).map(([day, v]) => ({ day, ...v })),
  };
  const out = (status, reason, extra = {}) => ({ ...base, status, reason, ...extra });

  if (policy.broken) return out('block', '采集策略文件损坏，已按「禁止」处理；请在网页里重新设置总开关');
  // 冷静期先说：设冷静期会同时关掉总开关，这时「为什么不能采集」的答案是冷静期，不是开关
  if (cooldownActive) {
    const left = Math.max(1, Math.ceil((new Date(policy.cooldownUntil) - now) / 86400000));
    return out('block', `冷静期内（${policy.cooldownReason || '账号被平台提示'}），还有约 ${left} 天，期间不做任何自动采集`);
  }
  if (!policy.enabled) return out('block', '采集总开关是关着的：要采集先在「采集状态」里打开');
  const mins = now.getHours() * 60 + now.getMinutes();
  if (!relaxed() && (mins < minutesOf(L.windowStart) || mins > minutesOf(L.windowEnd))) {
    return out('wait', `现在不在允许的采集时段（${L.windowStart}–${L.windowEnd}），时段内再点开始`);
  }
  if (notes >= L.notesPerDay) return out('block', `今天笔记已读 ${notes} 篇，到了上限 ${L.notesPerDay} 篇，明天再继续`);
  if (profiles >= L.profilesPerDay) return out('block', `今天主页已读 ${profiles} 个，到了上限 ${L.profilesPerDay} 个，明天再继续`);
  if (last && !relaxed()) {
    const sinceMin = (now - last) / 60000;
    if (sinceMin < L.gapMin) {
      const wait = Math.ceil(L.gapMin - sinceMin);
      return out('wait', `距上次访问才 ${Math.floor(sinceMin)} 分钟，两次采集之间至少隔 ${L.gapMin} 分钟，还要等约 ${wait} 分钟`, { waitMin: wait });
    }
  }
  return out('go', `今天还能读：笔记 ${L.notesPerDay - notes} 篇、主页 ${L.profilesPerDay - profiles} 个`);
}

/** 不能开始就抛 409，说明原因 */
export function assertCollectionAllowed(id, now = new Date()) {
  const s = paceSummary(id, now);
  if (s.status !== 'go') throw httpError(409, s.reason);
  return s;
}

/** 给 agent 的采集提示词里带上的数字（手册里也写了一份，这里保证每一次任务都带着） */
export function paceInstructions(limits = DEFAULT_LIMITS) {
  return `本轮读取的硬上限：笔记最多 ${limits.sessionNotes} 篇、主页最多 ${limits.sessionProfiles} 个；`
    + `读完一篇笔记、写好检查点后，至少隔 ${Math.max(25, limits.minNoteGapSec)} 秒再打开下一篇，不要连着开；`
    + '读完要的内容就返回，不要为了凑数多打开页面；遇到验证码、滑块或「操作频繁」类提示立刻停止，写好检查点说明原因，不要重试。';
}

/** 给人看的一段话（命令行和日志用） */
export function paceText(s) {
  const head = s.status === 'go' ? '✅ 可以开始' : s.status === 'wait' ? '⏳ 先别开始' : '⛔ 现在不能采集';
  return [
    `${head}｜${s.reason}`,
    `上次访问：${s.lastAgoText}`,
    `今天已读：笔记 ${s.today.notes} 篇、主页 ${s.today.profiles} 个`,
    `上限：笔记 ${s.limits.notesPerDay}/天、主页 ${s.limits.profilesPerDay}/天、两次采集间隔 ≥ ${s.limits.gapMin} 分钟、时段 ${s.limits.windowStart}–${s.limits.windowEnd}`,
    ...(s.cooldown ? [`冷静期：至 ${s.cooldown.until.slice(0, 10)}${s.cooldown.active ? '（生效中）' : '（已结束）'}`] : []),
  ].join('\n');
}
