// 登录核对时 agent 顺带分析账号主页，把「定位 / 目标人群 / 内容风格」的建议写进 accounts/<id>/profile-suggestion.json；
// 这里负责校验并填进账号里**还是空的**字段（不覆盖用户填的），写入时间和结果记回同一个文件，之后不会重复套用。
//
// 为什么不让 agent 直接改 config/accounts.json：建议内容来自网页上的文字（简介、笔记标题），属于不可信输入，
// 它们之后会进入给 agent 的提示词（「当前账号」的定位等）。所以统一在这里过滤：只留纯文字、去掉标记和控制字符、限长。
import path from 'node:path';
import { P } from './paths.mjs';
import { readJson, writeJson, getAccounts, saveAccount } from './store.mjs';

export const SUGGESTION_FILE = 'profile-suggestion.json';
const FIELDS = ['positioning', 'audience', 'style'];
const MAX_LEN = 80;

/** 纯文字、单行、去掉尖括号 / 反引号 / 花括号 / 控制字符，限长。不是字符串或清洗后为空返回 '' */
export function cleanText(v, max = MAX_LEN) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/[<>`{}\[\]\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function suggestionPath(accountId) {
  return path.join(P.accountsDir, accountId, SUGGESTION_FILE);
}

/**
 * 套用某个账号的主页分析建议。返回 { applied: [字段], skipped: [字段], reason? }。
 * - 文件不存在 / 内容还不是完整 JSON（agent 可能正在写）：什么都不做，不标记已处理，等下一次文件变化
 * - 已经有 appliedAt：不再处理
 * - 只填账号里为空的字段；用户已经填了的不覆盖
 */
export function applyProfileSuggestion(accountId) {
  if (!/^[\w-]+$/.test(String(accountId || ''))) return { applied: [], skipped: [], reason: 'bad-account' };
  // 严格按 id 找：store.getAccount 对不存在的 id 会回退成默认账号，这里不能那样
  const acc = getAccounts().accounts.find((a) => a.id === accountId);
  if (!acc) return { applied: [], skipped: [], reason: 'no-account' };
  const file = suggestionPath(accountId);
  const doc = readJson(file, null);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { applied: [], skipped: [], reason: 'not-ready' };
  if (doc.appliedAt) return { applied: [], skipped: [], reason: 'already-applied' };

  const fill = {};
  const skipped = [];
  for (const k of FIELDS) {
    const text = cleanText(doc[k]);
    if (!text) continue;
    if (acc[k] && String(acc[k]).trim()) skipped.push(k);
    else fill[k] = text;
  }
  const applied = Object.keys(fill);
  if (applied.length) saveAccount({ id: accountId, ...fill });
  writeJson(file, { ...doc, appliedAt: new Date().toISOString(), applied, skipped });
  return { applied, skipped };
}

/** 给账号列表附带的摘要：只含时间和字段名，不含建议原文 */
export function suggestionSummary(accountId) {
  const doc = readJson(suggestionPath(accountId), null);
  if (!doc || typeof doc !== 'object' || !doc.appliedAt) return null;
  return { appliedAt: String(doc.appliedAt), applied: Array.isArray(doc.applied) ? doc.applied.filter((k) => FIELDS.includes(k)) : [] };
}
