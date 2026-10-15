// M3 运营自动化：发布排期、评论私信、数据复盘，以及驱动它们的定时调度器。
// 数据格式与 playbooks/publish.md、engage.md、analytics.md 保持一致。
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, httpError, listAccounts } from './store.mjs';
import { accRoot, readItems, upsertItem, removeItem, listFiles, saveUpload, noteDetail, saveNote, IMAGE_EXTS } from './content.mjs';

const now = () => new Date().toISOString();
const MISSED_AFTER_MS = 2 * 3600_000; // 超过计划时间 2 小时还没执行，视为错过，不再自动发布
const STUCK_AFTER_MS = 60 * 60_000; // 自动任务运行超过 1 小时没有结果，提醒用户检查

// ---------- 自动化设置 ----------

export const DEFAULT_AUTOMATION = {
  publish: { defaultMode: 'remind', dailyLimit: 3, minIntervalMin: 60 },
  engage: { autoSend: false, maxPerRun: 20, checkEveryHours: 0 },
  analytics: { dailyAt: '' },
  sessionId: null,
  lastRuns: {},
};

function automationFile(acc) {
  return path.join(accRoot(acc), 'automation.json');
}

export function getAutomation(acc) {
  const saved = readJson(automationFile(acc), {});
  const out = { ...DEFAULT_AUTOMATION, ...saved, lastRuns: { ...(saved.lastRuns || {}) } };
  for (const k of ['publish', 'engage', 'analytics']) out[k] = { ...DEFAULT_AUTOMATION[k], ...(saved[k] || {}) };
  return out;
}

export function saveAutomation(acc, patch) {
  const cur = getAutomation(acc);
  for (const k of ['publish', 'engage', 'analytics']) if (patch[k]) Object.assign(cur[k], patch[k]);
  if ('sessionId' in patch) cur.sessionId = patch.sessionId;
  if (patch.lastRuns) Object.assign(cur.lastRuns, patch.lastRuns);
  // 基本取值校验
  cur.publish.dailyLimit = Math.max(1, Math.min(20, Number(cur.publish.dailyLimit) || 3));
  cur.publish.minIntervalMin = Math.max(0, Math.min(1440, Number(cur.publish.minIntervalMin) || 0));
  cur.publish.defaultMode = cur.publish.defaultMode === 'auto' ? 'auto' : 'remind';
  cur.engage.maxPerRun = Math.max(1, Math.min(100, Number(cur.engage.maxPerRun) || 20));
  cur.engage.checkEveryHours = Math.max(0, Math.min(72, Number(cur.engage.checkEveryHours) || 0));
  cur.engage.autoSend = !!cur.engage.autoSend;
  if (cur.analytics.dailyAt && !/^\d{2}:\d{2}$/.test(cur.analytics.dailyAt)) throw httpError(400, '时间格式应为 HH:MM');
  writeJson(automationFile(acc), cur);
  return cur;
}

// ---------- 发布排期 ----------

const SCHEDULE_FIELDS = ['noteId', 'title', 'publishAt', 'mode', 'status', 'taskId', 'publishedUrl', 'publishedAt', 'error', 'startedAt'];
const ACTIVE = ['scheduled', 'due', 'running', 'check', 'published'];

function scheduleFile(acc) {
  return path.join(accRoot(acc), 'schedule.json');
}

export function listSchedule(acc) {
  return readItems(scheduleFile(acc), 's_').sort((a, b) => String(a.publishAt).localeCompare(String(b.publishAt)));
}

const dayKey = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()}`;
};

// 发布频率限制：每日上限 + 两次发布最小间隔
function checkLimits(acc, publishAt, ignoreId) {
  const { publish } = getAutomation(acc);
  const t = new Date(publishAt).getTime();
  const others = listSchedule(acc).filter((s) => s.id !== ignoreId && ACTIVE.includes(s.status));
  const sameDay = others.filter((s) => dayKey(s.publishedAt || s.publishAt) === dayKey(publishAt));
  if (sameDay.length >= publish.dailyLimit) throw httpError(400, `当天已安排 ${sameDay.length} 篇，达到每日上限 ${publish.dailyLimit} 篇（可在排期设置里调整）`);
  const gap = publish.minIntervalMin * 60_000;
  const close = others.find((s) => Math.abs(new Date(s.publishedAt || s.publishAt).getTime() - t) < gap);
  if (close) throw httpError(400, `和「${close.title || close.noteId}」间隔不足 ${publish.minIntervalMin} 分钟`);
}

export function scheduleNote(acc, { noteId, publishAt, mode }) {
  const note = noteDetail(acc, noteId);
  const t = new Date(publishAt);
  if (Number.isNaN(t.getTime())) throw httpError(400, '发布时间无效');
  if (t.getTime() < Date.now() - 60_000) throw httpError(400, '发布时间不能早于现在');
  if (listSchedule(acc).some((s) => s.noteId === noteId && ['scheduled', 'due', 'running'].includes(s.status))) {
    throw httpError(400, '这篇笔记已经在排期中');
  }
  checkLimits(acc, t.toISOString());
  const item = upsertItem(scheduleFile(acc), 's_', {
    noteId,
    title: note.title || '（无标题）',
    publishAt: t.toISOString(),
    mode: mode === 'auto' ? 'auto' : mode === 'remind' ? 'remind' : getAutomation(acc).publish.defaultMode,
    status: 'scheduled',
  }, SCHEDULE_FIELDS);
  if (note.status === 'draft') saveNote(acc, { id: noteId, status: 'ready' });
  return item;
}

export function updateSchedule(acc, input) {
  const item = listSchedule(acc).find((s) => s.id === input.id);
  if (!item) throw httpError(404, '排期不存在');
  const patch = { id: item.id };
  if (input.publishAt && input.publishAt !== item.publishAt) {
    const t = new Date(input.publishAt);
    if (Number.isNaN(t.getTime())) throw httpError(400, '发布时间无效');
    checkLimits(acc, t.toISOString(), item.id);
    patch.publishAt = t.toISOString();
    patch.status = 'scheduled';
    patch.error = '';
  }
  if (input.mode) patch.mode = input.mode === 'auto' ? 'auto' : 'remind';
  if (input.status) patch.status = input.status;
  if (input.status === 'published') {
    patch.publishedAt = input.publishedAt || now();
    patch.publishedUrl = input.publishedUrl || item.publishedUrl || '';
    patch.error = '';
    try {
      saveNote(acc, { id: item.noteId, status: 'published', publishedUrl: patch.publishedUrl, publishedAt: patch.publishedAt });
    } catch {
      /* 笔记已被删除 */
    }
  }
  if (input.status === 'scheduled' && !patch.publishAt) {
    // 重试：时间已过的改到 1 分钟后
    if (new Date(item.publishAt).getTime() < Date.now()) patch.publishAt = new Date(Date.now() + 60_000).toISOString();
    patch.error = '';
  }
  return upsertItem(scheduleFile(acc), 's_', patch, SCHEDULE_FIELDS);
}

export function deleteSchedule(acc, id) {
  removeItem(scheduleFile(acc), 's_', id, 'schedule', { account: acc });
}

// ---------- 评论私信 ----------

const ENGAGE_FIELDS = ['type', 'noteTitle', 'noteUrl', 'user', 'content', 'time', 'status', 'draft', 'sentAt', 'error'];

function engageFile(acc) {
  return path.join(accRoot(acc), 'engage', 'items.json');
}

export function listEngage(acc) {
  return readItems(engageFile(acc), 'e_');
}

export function saveEngage(acc, input) {
  if (!input.id) throw httpError(400, '缺少 id');
  if (!listEngage(acc).some((x) => x.id === input.id)) throw httpError(404, '条目不存在');
  const patch = { id: input.id };
  if (typeof input.draft === 'string') patch.draft = input.draft;
  if (input.status) {
    if (!['new', 'drafted', 'approved', 'ignored', 'sent', 'failed'].includes(input.status)) throw httpError(400, '状态无效');
    patch.status = input.status;
  }
  return upsertItem(engageFile(acc), 'e_', patch, ENGAGE_FIELDS);
}

// ---------- 数据复盘 ----------

const IMPORT_EXTS = ['.csv', '.xlsx', '.xls', '.txt', '.json', ...IMAGE_EXTS];

function analyticsDir(acc) {
  return path.join(accRoot(acc), 'analytics');
}

export function getAnalytics(acc) {
  const dir = analyticsDir(acc);
  const notes = readJson(path.join(dir, 'notes.json'), { items: [] });
  const account = readJson(path.join(dir, 'account.json'), { history: [] });
  const reports = listFiles(path.join(dir, 'reports'), ['.md'])
    .map((f) => ({ name: f, updatedAt: fs.statSync(path.join(dir, 'reports', f)).mtime.toISOString() }))
    .sort((a, b) => b.name.localeCompare(a.name));
  return {
    updatedAt: notes.updatedAt || null,
    notes: Array.isArray(notes.items) ? notes.items : [],
    account: Array.isArray(account.history) ? account.history : [],
    reports,
    imports: listFiles(path.join(dir, 'imports'), IMPORT_EXTS),
  };
}

export function readReport(acc, name) {
  if (!/^[^/\\]+\.md$/.test(name || '')) throw httpError(400, '报告名不合法');
  const file = path.join(analyticsDir(acc), 'reports', name);
  if (!fs.existsSync(file)) throw httpError(404, '报告不存在');
  return { name, content: fs.readFileSync(file, 'utf8') };
}

export function uploadImport(acc, filename, data) {
  return saveUpload(path.join(analyticsDir(acc), 'imports'), filename, data, IMPORT_EXTS);
}

// ---------- 提醒汇总（顶栏铃铛） ----------

export function alerts() {
  const out = [];
  for (const a of listAccounts()) {
    let schedule = [];
    let engage = [];
    try {
      schedule = listSchedule(a.id);
      engage = listEngage(a.id);
    } catch {
      continue;
    }
    const base = { account: a.id, accountName: a.name };
    for (const s of schedule) {
      const map = { due: '到点了，请手动发布', missed: '错过了发布时间', failed: '自动发布失败', check: '自动发布结果待确认' };
      if (map[s.status]) out.push({ ...base, kind: 'publish', status: s.status, id: s.id, title: s.title, text: map[s.status], at: s.publishAt });
    }
    const fresh = engage.filter((e) => e.status === 'new' || e.status === 'drafted').length;
    if (fresh) out.push({ ...base, kind: 'engage', status: 'new', text: `${fresh} 条评论私信待处理`, at: now() });
    const approved = engage.filter((e) => e.status === 'approved').length;
    if (approved) out.push({ ...base, kind: 'engage', status: 'approved', text: `${approved} 条回复已确认，待发送`, at: now() });
  }
  return out;
}

// ---------- 定时调度器 ----------

const PROMPTS = {
  publish: (acc, s) =>
    `【自动任务 · 定时发布】请按 playbooks/publish.md 发布笔记 ${s.noteId}（文件在 accounts/${acc}/notes/${s.noteId}/），排期 id：${s.id}。` +
    `完成后按手册更新 accounts/${acc}/schedule.json 中该条目的 status、publishedUrl 或 error。`,
  engage: (acc, cfg) =>
    `【自动任务 · 检查评论私信】请按 playbooks/engage.md 检查新的评论和私信，写入 accounts/${acc}/engage/items.json 并起草回复` +
    (cfg.autoSend ? `，然后直接发送回复（本次最多 ${cfg.maxPerRun} 条，用户已开启自动发送）。` : '，只起草、不要发送（等用户在工作台确认）。'),
  analytics: (acc) => `【自动任务 · 数据抓取】请按 playbooks/analytics.md 抓取最新的笔记数据和账号数据，更新 accounts/${acc}/analytics/ 下的 notes.json 和 account.json。`,
};

export class Scheduler {
  /**
   * runTask(accountId, text) => taskId | null（会话忙时返回 null，下次再试）
   * notify(event) 推送给前端
   */
  constructor({ runTask, notify, log }) {
    this.runTask = runTask;
    this.notify = notify;
    this.log = log;
    this.tasks = new Map(); // taskId -> { acc, kind, id }
  }

  start() {
    this.timer = setInterval(() => this.tick(), 30_000);
    this.timer.unref();
    setTimeout(() => this.tick(), 3_000).unref();
  }

  tick() {
    for (const a of listAccounts()) {
      try {
        this.#tickAccount(a.id);
      } catch (err) {
        this.log(`调度出错（账号 ${a.id}）：${err.stack || err.message}`);
      }
    }
  }

  #run(acc, kind, text, ref) {
    const taskId = this.runTask(acc, text);
    if (taskId) this.tasks.set(taskId, { acc, kind, id: ref });
    return taskId;
  }

  #tickAccount(acc) {
    const t = Date.now();
    const cfg = getAutomation(acc);

    // 1. 发布排期
    for (const s of listSchedule(acc)) {
      const at = new Date(s.publishAt).getTime();
      if (s.status === 'scheduled' && at <= t) {
        if (t - at > MISSED_AFTER_MS) {
          updateSchedule(acc, { id: s.id, status: 'missed' });
          this.notify({ type: 'alert', account: acc, text: `「${s.title}」错过了发布时间` });
        } else if (s.mode === 'auto') {
          const taskId = this.#run(acc, 'publish', PROMPTS.publish(acc, s), s.id);
          if (taskId) {
            upsertItem(scheduleFile(acc), 's_', { id: s.id, status: 'running', taskId, startedAt: now() }, SCHEDULE_FIELDS);
            this.notify({ type: 'alert', account: acc, text: `agent 开始发布「${s.title}」` });
          }
        } else {
          updateSchedule(acc, { id: s.id, status: 'due' });
          this.notify({ type: 'alert', account: acc, text: `到点了：请发布「${s.title}」`, urgent: true });
        }
      } else if (s.status === 'running' && s.startedAt && t - new Date(s.startedAt).getTime() > STUCK_AFTER_MS && !this.tasks.has(s.taskId)) {
        upsertItem(scheduleFile(acc), 's_', { id: s.id, status: 'check', error: '自动发布超过 1 小时没有结果，请检查是否已发布' }, SCHEDULE_FIELDS);
      }
    }

    // 2. 定时检查评论私信
    const every = cfg.engage.checkEveryHours;
    const lastEngage = cfg.lastRuns.engage ? new Date(cfg.lastRuns.engage).getTime() : 0;
    if (every > 0 && t - lastEngage >= every * 3600_000) {
      if (this.#run(acc, 'engage', PROMPTS.engage(acc, cfg.engage))) saveAutomation(acc, { lastRuns: { engage: now() } });
    }

    // 3. 每天定点抓取数据
    if (cfg.analytics.dailyAt) {
      const [h, m] = cfg.analytics.dailyAt.split(':').map(Number);
      const today = new Date();
      const due = new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, m).getTime();
      const last = cfg.lastRuns.analytics ? new Date(cfg.lastRuns.analytics).getTime() : 0;
      if (t >= due && last < due && t - due < MISSED_AFTER_MS) {
        if (this.#run(acc, 'analytics', PROMPTS.analytics(acc))) saveAutomation(acc, { lastRuns: { analytics: now() } });
      }
    }
  }

  /** agent 任务结束：如果 agent 没按手册回写发布结果，标记为待确认 / 失败 */
  onTaskFinished(taskId, ok, message) {
    const ref = this.tasks.get(taskId);
    if (!ref) return;
    this.tasks.delete(taskId);
    if (ref.kind !== 'publish') return;
    const s = listSchedule(ref.acc).find((x) => x.id === ref.id);
    if (!s || s.status !== 'running') return;
    if (ok) {
      upsertItem(scheduleFile(ref.acc), 's_', { id: s.id, status: 'check', error: 'agent 已结束，但没有回写发布结果，请到对话里查看并确认' }, SCHEDULE_FIELDS);
    } else {
      upsertItem(scheduleFile(ref.acc), 's_', { id: s.id, status: 'failed', error: message || '自动发布失败' }, SCHEDULE_FIELDS);
    }
    this.notify({ type: 'alert', account: ref.acc, text: `「${s.title}」自动发布需要你确认` });
  }
}


/** 防休眠「自动」模式：未来 3 小时内有排期，或开启了定时检查评论 / 每日抓数据 */
export function needsAwake() {
  const soon = Date.now() + 3 * 3600_000;
  for (const a of listAccounts()) {
    try {
      if (listSchedule(a.id).some((s) => (s.status === 'scheduled' && new Date(s.publishAt).getTime() <= soon) || s.status === 'running')) return true;
      const cfg = getAutomation(a.id);
      if (cfg.engage.checkEveryHours > 0 || cfg.analytics.dailyAt) return true;
    } catch {
      /* 账号目录异常时跳过 */
    }
  }
  return false;
}
