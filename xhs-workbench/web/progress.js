// 任务进度提示：让用户知道「在做什么、做了多久、通常要多久」，而不是只看到一个「处理中」。
// - 用时每秒走字（页面上带 data-elapsed-from / data-ago-from 的元素，由一个定时器统一刷新，不用重新渲染整块内容）
// - 「通常要多久」来自服务端按最近完成的同类任务统计（/api/timing）；样本不够就不给估计，不瞎猜
// - 比平时久（超过 80% 分位的 1.5 倍）时多说一句，并提示可以停止重试
import { icon } from './icons.js';
import { esc } from './md.js';
import { S, api } from './core.js';

export function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${String(s % 60).padStart(2, '0')} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

function num(n) { return String(Math.round(n * 2) / 2); }   // 取到 0.5：1 / 1.5 / 2

/** 区间写法：同单位合并（20–30 秒、1–2 分钟），跨单位写两个（30 秒–1 分钟） */
function fmtRange(low, high) {
  const sec = (v) => `${Math.max(5, Math.round(v / 5) * 5)}`;
  const min = (v) => num(v / 60);
  if (high < 60) return low === high ? `${sec(high)} 秒` : `${sec(low)}–${sec(high)} 秒`;
  if (low >= 60) { const a = min(low), b = min(high); return a === b ? `${a} 分钟` : `${a}–${b} 分钟`; }
  return `${sec(low)} 秒–${min(high)} 分钟`;
}

/** 「通常约 1–2 分钟（最近 12 次）」；样本不够返回空串 */
export function typicalText(cls) {
  const t = S.timing && S.timing[cls];
  if (!t) return '';
  return `通常约 ${fmtRange(t.low, t.high)}（最近 ${t.n} 次）`;
}

function slowAfterSec(cls) {
  const t = S.timing && S.timing[cls];
  return t ? Math.max(60, Math.round(t.high * 1.5)) : 0;
}

export async function refreshTiming() {
  try { S.timing = await api('GET', '/api/timing'); } catch { /* 没有估计就只显示用时 */ }
}

const TOOL_NAMES = {
  Read: '读取文件', Write: '保存文件', Edit: '修改文件', MultiEdit: '修改文件', Glob: '查找文件', Grep: '搜索内容', LS: '查看目录',
  Bash: '执行命令', WebSearch: '搜索网页', WebFetch: '读取网页', TodoWrite: '规划步骤', Task: '委派子任务', NotebookEdit: '修改笔记本',
};
/** 工具名换成人话：Read → 读取文件；中枢和浏览器的 MCP 工具按类别说 */
export function humanTool(name) {
  const n = String(name || '');
  if (TOOL_NAMES[n]) return TOOL_NAMES[n];
  if (/^mcp__.*(hub|enterprise)/i.test(n)) return '调用公司中枢';
  if (/^mcp__.*(browser|ego|playwright)/i.test(n)) return '操作浏览器';
  if (/^mcp__/i.test(n)) return '调用外部工具';
  return n;
}

/** 正在处理的对话消息：用时、通常多久、当前在做什么 */
export function workingHtml(m, cls = 'chat') {
  const queued = m.status === 'pending';
  const from = queued ? m.createdAt : (m.startedAt || m.createdAt);
  const typ = queued ? '' : typicalText(cls);
  const slow = queued ? 0 : slowAfterSec(cls);
  const ph = m.phase;
  let phase = '';
  if (!queued && ph) {
    const label = ph.kind === 'thinking' ? `正在想：${esc(ph.detail)}` : `${esc(humanTool(ph.name))}${ph.detail ? `：${esc(ph.detail)}` : ''}`;
    phase = `<div class="progress-phase">${icon(ph.kind === 'thinking' ? 'bulb' : 'wrench')} ${label}<span class="muted"> · <span data-ago-from="${esc(ph.at || m.lastActivityAt || '')}">刚刚</span></span></div>`;
  }
  return `<div class="progress">
    <div class="progress-line">${icon('clock')} ${queued ? '排队中' : 'agent 正在处理'} · ${queued ? '已等待' : '已用'} <b data-elapsed-from="${esc(from || '')}">${from ? fmtElapsed(Date.now() - Date.parse(from)) : '0 秒'}</b>${typ ? ` · <span class="muted">${esc(typ)}</span>` : ''}</div>
    ${phase}
    ${slow ? `<div class="progress-slow" data-slow-from="${esc(from || '')}" data-slow-after="${slow}" hidden>比平时久一些，可能在处理比较复杂的内容。如果一直没有新动作，可以点「停止」后重试。</div>` : ''}
  </div>`;
}

/** 文案 / 封面 / 选题等任务卡片里的用时：排队或处理中显示「已用 / 通常」，完成后显示「用时」 */
export function jobTimingHtml(j, cls) {
  if (!j || !j.createdAt) return '';
  const active = ['queued', 'running', 'ready_pending', 'preparing'].includes(j.status);
  if (active) {
    const typ = j.status === 'queued' ? '' : typicalText(cls);
    return ` · ${j.status === 'queued' ? '已等待' : '已用'} <b data-elapsed-from="${esc(j.createdAt)}">${fmtElapsed(Date.now() - Date.parse(j.createdAt))}</b>${typ ? ` · ${esc(typ)}` : ''}`;
  }
  if (j.finishedAt) {
    const ms = Date.parse(j.finishedAt) - Date.parse(j.createdAt);
    if (ms >= 0 && ms < 24 * 3600_000) return ` · 用时 ${fmtElapsed(ms)}`;
  }
  return '';
}

let ticker = null;
export function startProgressTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    const now = Date.now();
    document.querySelectorAll('[data-elapsed-from]').forEach((el) => {
      const t = Date.parse(el.dataset.elapsedFrom);
      if (Number.isFinite(t)) el.textContent = fmtElapsed(now - t);
    });
    document.querySelectorAll('[data-ago-from]').forEach((el) => {
      const t = Date.parse(el.dataset.agoFrom);
      if (Number.isFinite(t)) { const s = Math.floor((now - t) / 1000); el.textContent = s < 3 ? '刚刚' : s < 60 ? `${s} 秒前` : `${Math.floor(s / 60)} 分钟前`; }
    });
    document.querySelectorAll('[data-slow-from]').forEach((el) => {
      const t = Date.parse(el.dataset.slowFrom);
      if (Number.isFinite(t)) el.hidden = (now - t) / 1000 < Number(el.dataset.slowAfter);
    });
  }, 1000);
}
