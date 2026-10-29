// 任务用时统计：页面据此告诉用户「这类任务通常要多久」。
// 只记成功完成的任务，按类别（chat / copy / cover / topic / engage / analytics）各留最近 30 次；样本不到 3 次不给估计。
// 用时 = 从 agent 开始处理（不含排队）到完成。存在数据目录的 run/durations.json，只是个参考值，丢了也无所谓。
import path from 'node:path';
import { P } from './paths.mjs';
import { readJson, writeJson } from './store.mjs';

const KEEP = 30;
const MIN_SAMPLES = 3;
const MIN_MS = 3_000;          // 几秒钟的不算（多半是秒回或失败重试），会把估计拉得过低
const MAX_MS = 40 * 60_000;    // 超过 40 分钟多半是卡住后才结束，不能代表通常情况
const defaultFile = () => path.join(P.run, 'durations.json');

export function recordDuration(cls, ms, file = defaultFile()) {
  if (!cls || !Number.isFinite(ms) || ms < MIN_MS || ms > MAX_MS) return false;
  try {
    const all = readJson(file, {}) || {};
    const arr = Array.isArray(all[cls]) ? all[cls] : [];
    arr.push(Math.round(ms / 1000));
    all[cls] = arr.slice(-KEEP);
    writeJson(file, all);
    return true;
  } catch { return false; }  // 统计写不进去不能影响任务
}

function pct(sorted, p) {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i];
}

/** { 类别: { n, low, mid, high } }，单位秒：low / high 是 25% / 80% 分位，mid 是中位数 */
export function typicalDurations(file = defaultFile()) {
  const all = readJson(file, {}) || {};
  const out = {};
  for (const [cls, arr] of Object.entries(all)) {
    if (!Array.isArray(arr) || arr.length < MIN_SAMPLES) continue;
    const s = arr.filter(Number.isFinite).sort((a, b) => a - b);
    if (s.length < MIN_SAMPLES) continue;
    out[cls] = { n: s.length, low: pct(s, 0.25), mid: pct(s, 0.5), high: pct(s, 0.8) };
  }
  return out;
}
