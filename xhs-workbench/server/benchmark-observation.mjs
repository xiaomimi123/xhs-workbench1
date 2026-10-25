// 对标主页的原始观察记录；与 agent 写的拆解报告和 notes.json 分开存放。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { P } from './paths.mjs';
import { ensureDir, readJson, writeJson } from './store.mjs';
import { canonicalProfileUrl, canonicalNoteUrl } from './browser-read.mjs';

const PROFILE_FIELDS = { bio: 500, followers: 80, following: 80, likesAndCollects: 80, noteCount: 80 };
const NOTE_FIELDS = { title: 200, type: 30, publishedAt: 80, description: 400, likes: 80, collects: 80, comments: 80 };
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const STATES = new Set(['profile', 'partial', 'complete', 'unavailable']);
const SOURCES = new Set(['worker-visible', 'agent-visible', 'worker-ocr']);

function text(value, max, required = false) {
  if (typeof value !== 'string' || value.length > max) throw new Error('观察字段格式不合法');
  const trimmed = value.trim();
  if (required && !trimmed) throw new Error('观察字段不能为空');
  return trimmed;
}

function iso(value) {
  const result = text(value, 40, true);
  if (!ISO.test(result) || !Number.isFinite(Date.parse(result))) throw new Error('观察时间不合法');
  return result;
}

function dirFor(accountId, id) {
  if (!/^[\w-]+$/.test(accountId || '') || !/^b_[\w-]+$/.test(id || '')) throw new Error('对标账号或工作台账号 id 不合法');
  return path.join(P.accountsDir, accountId, 'benchmarks', id);
}

function png(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_AVATAR_BYTES
    || buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    || buffer.toString('ascii', 12, 16) !== 'IHDR') throw new Error('头像必须是有效的 PNG 图片（不超过 2MB）');
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (!width || !height || width > 2048 || height > 2048) throw new Error('头像尺寸不合法');
}

function image(buffer, ext) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_AVATAR_BYTES) throw new Error('头像文件为空或超过 2MB');
  if (ext === '.png') return png(buffer);
  if (ext === '.jpg' || ext === '.jpeg') {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer.at(-2) !== 0xff || buffer.at(-1) !== 0xd9) throw new Error('JPEG 文件格式不合法');
    return;
  }
  if (ext === '.webp' && buffer.length >= 16 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return;
  throw new Error('仅支持 PNG / JPEG / WebP 头像');
}

function atomicBuffer(file, buffer) {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, buffer);
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

/** worker 的截图只暂存在本对标目录；检查点合并成功后才公开其路径。 */
export function stageCapturedAvatar(accountId, id, buffer) {
  png(buffer);
  const name = `avatar-source-${crypto.randomBytes(8).toString('hex')}.png`;
  atomicBuffer(path.join(dirFor(accountId, id), name), buffer);
  return name;
}

export function stageDownloadedAvatar(accountId, id, buffer, ext) {
  image(buffer, ext);
  const name = `avatar-download-${crypto.randomBytes(8).toString('hex')}${ext}`;
  atomicBuffer(path.join(dirFor(accountId, id), name), buffer);
  return name;
}

export function stageVisualEvidence(accountId, id, evidence) {
  const buffer = evidence.png;
  if (!Buffer.isBuffer(buffer) || buffer.length > 12 * 1024 * 1024
    || !buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('证据截图不是 PNG 或超过 12MB');
  const ocr = JSON.stringify(evidence.ocr);
  if (!ocr || ocr.length > 1024 * 1024) throw new Error('OCR 结果过大或缺失');
  const stem = `evidence-${crypto.randomBytes(8).toString('hex')}`;
  const dir = dirFor(accountId, id);
  atomicBuffer(path.join(dir, `${stem}.png`), buffer);
  atomicBuffer(path.join(dir, `${stem}.json`), Buffer.from(ocr));
  return { screenshot: `benchmarks/${id}/${stem}.png`, ocr: `benchmarks/${id}/${stem}.json` };
}

function checkedEvidence(value, accountId, id) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw new Error('证据路径不合法');
  const result = {};
  for (const [key, ext] of [['screenshot', 'png'], ['ocr', 'json']]) {
    const relative = value[key];
    if (typeof relative !== 'string' || !relative.startsWith(`benchmarks/${id}/`)
      || !new RegExp(`^evidence-[a-f0-9]{16}\\.${ext}$`).test(path.basename(relative))
      || relative !== `benchmarks/${id}/${path.basename(relative)}`) throw new Error('证据路径不合法');
    if (!fs.lstatSync(path.join(P.accountsDir, accountId, relative)).isFile()) throw new Error('证据文件不存在或为符号链接');
    result[key] = relative;
  }
  return result;
}

/** 用户明确上传的头像与页面截图分开，永远标注为手动提供。 */
export function saveManualAvatar(accountId, id, filename, data) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) throw new Error('仅支持 PNG / JPEG / WebP 头像');
  if (typeof data !== 'string' || data.length > MAX_AVATAR_BYTES * 1.5 + 100) throw new Error('头像文件超过 2MB');
  const buffer = Buffer.from(data.replace(/^data:[^,]+,/, ''), 'base64');
  image(buffer, ext);
  const name = `avatar-manual-${crypto.randomBytes(5).toString('hex')}${ext}`;
  atomicBuffer(path.join(dirFor(accountId, id), name), buffer);
  return `benchmarks/${id}/${name}`;
}

function recorded(fields, limits, observedAt, source) {
  if (fields === undefined) return {};
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('观察数据格式不合法');
  const result = {};
  for (const [key, max] of Object.entries(limits)) {
    if (fields[key] === undefined) continue;
    const value = text(fields[key], max);
    if (value) result[key] = { value, observedAt, source };
  }
  return result;
}

function validatedNotes(notes, observedAt, source) {
  if (notes === undefined) return [];
  if (!Array.isArray(notes) || notes.length > 5) throw new Error('每次最多记录 5 篇主页笔记');
  const seen = new Set();
  return notes.map((note) => {
    if (!note || typeof note !== 'object' || Array.isArray(note)) throw new Error('笔记观察格式不合法');
    const url = canonicalNoteUrl(note.url);
    if (!url || seen.has(url)) throw new Error('笔记链接不是唯一的小红书笔记页');
    seen.add(url);
    if (note.position !== undefined && (!Number.isInteger(note.position) || note.position < 0 || note.position > 4)) throw new Error('笔记排序不合法');
    return { url, position: note.position, fields: recorded(note, NOTE_FIELDS, observedAt, source), observedAt, source };
  });
}

const sameName = (value) => String(value || '').replace(/\s+/g, '').toLowerCase();

// 身份以主页链接为准（/user/profile/<id> 是账号唯一 id，比可改的小红书号稳定）；小红书号和昵称是附加核对：
// 双方都有小红书号时必须一致；没读到（手册允许留空）或已核实记录里没有时，昵称必须和已核实记录一致。
// 身份字段一律取已核实记录，检查点不能改写身份。
function verifiedIdentity(entry, item) {
  if (!item || !item.verifiedAt || !item.url) throw new Error('请先核实对标主页，再保存观察数据');
  const url = canonicalProfileUrl(entry.url);
  if (!url || url !== canonicalProfileUrl(item.url)) throw new Error('观察主页与已核实主页不一致');
  const reported = entry.xhsId === undefined || entry.xhsId === null ? '' : text(entry.xhsId, 120);
  if (reported && item.xhsId) {
    if (reported !== item.xhsId) throw new Error('观察的小红书号与已核实账号不一致');
  } else {
    const name = sameName(entry.profileName);
    if (!name || ![item.profileName, item.name].map(sameName).filter(Boolean).includes(name)) {
      throw new Error(`${reported ? '已核实记录里没有小红书号' : '没有读到小红书号'}，且主页昵称与已核实账号不一致，无法确认是同一个账号`);
    }
  }
  return { url, xhsId: item.xhsId };
}

function capturedAvatar(dir, id, name, observedAt, source) {
  const downloaded = /^avatar-download-[a-f0-9]{16}\.(?:png|jpe?g|webp)$/.test(name || '');
  if (!downloaded && !/^avatar-source-[a-f0-9]{16}\.png$/.test(name || '')) throw new Error('头像截图路径不合法');
  const original = path.join(dir, name);
  if (fs.lstatSync(original).isSymbolicLink()) throw new Error('头像截图不能是符号链接');
  const stat = fs.statSync(original);
  if (stat.size > MAX_AVATAR_BYTES) throw new Error('头像截图超过 2MB');
  const buffer = fs.readFileSync(original);
  image(buffer, path.extname(name));
  if (downloaded) return { path: `benchmarks/${id}/${name}`, kind: 'downloaded', observedAt, source };
  const target = `avatar-captured-${crypto.randomBytes(8).toString('hex')}.png`;
  atomicBuffer(path.join(dir, target), buffer);
  return { path: `benchmarks/${id}/${target}`, observedAt, source };
}

function snapshotFile(accountId, id) {
  return path.join(dirFor(accountId, id), 'snapshot.json');
}

/** 每个完整检查点合并一次；失败时旧 snapshot 完全不变。 */
export function mergeObservation(accountId, item, entry) {
  if (!entry || entry.stage !== 'observation' || entry.id !== item?.id) throw new Error('观察检查点 id 或阶段不匹配');
  const { url, xhsId } = verifiedIdentity(entry, item);
  const observedAt = iso(entry.observedAt);
  const source = text(entry.source, 30, true);
  if (!SOURCES.has(source)) throw new Error('观察来源不合法');
  const state = text(entry.state, 20, true);
  if (!STATES.has(state)) throw new Error('观察状态不合法');
  const reason = entry.reason === undefined ? '' : text(entry.reason, 240);
  const profile = recorded(entry.profile, PROFILE_FIELDS, observedAt, entry.profileEvidence ? 'worker-ocr' : source);
  const notes = validatedNotes(entry.notes, observedAt, source);
  for (let i = 0; i < notes.length; i++) {
    const evidence = checkedEvidence(entry.notes[i].evidence, accountId, item.id);
    if (evidence) notes[i].evidence = evidence;
  }
  const profileEvidence = checkedEvidence(entry.profileEvidence, accountId, item.id);
  const file = snapshotFile(accountId, item.id);
  const exists = fs.existsSync(file);
  const previous = readJson(file, null);
  if (exists && !validSnapshot(previous, item)) throw new Error('已有观察文件无法读取或身份冲突，请检查备份');
  const count = (name, max) => {
    if (entry[name] === undefined) return previous?.[name] || 0;
    if (!Number.isInteger(entry[name]) || entry[name] < 0 || entry[name] > max) throw new Error('观察数量不合法');
    return entry[name];
  };
  const discoveredCount = count('discoveredCount', 50);
  const attemptedCount = count('attemptedCount', 5);
  const manualName = text(entry.profileName, 120, true);
  const priorNotes = new Map((previous?.notes || []).map((n) => [n.url, n]));
  const latest = notes.map((n) => {
    const old = priorNotes.get(n.url);
    priorNotes.delete(n.url);
    // 每个字段保留各自的观察时间：缺失的新值不会把旧值伪装成刚抓到。
    return { ...old, ...n, fields: { ...(old?.fields || {}), ...n.fields } };
  });
  const visibleNoteUrls = entry.visibleNoteUrls ?? previous?.visibleNoteUrls;
  if (visibleNoteUrls !== undefined && (!Array.isArray(visibleNoteUrls) || visibleNoteUrls.length > 5
    || new Set(visibleNoteUrls).size !== visibleNoteUrls.length || visibleNoteUrls.some(u => canonicalNoteUrl(u) !== u))) throw new Error('本轮笔记名单不合法');
  const currentSet = visibleNoteUrls && new Set(visibleNoteUrls);
  const mergedNotes = [...latest, ...priorNotes.values()].filter(n => !currentSet || currentSet.has(n.url)).slice(0, 5);
  const collectionStartedAt = entry.visibleNoteUrls !== undefined ? observedAt : previous?.collectionStartedAt;
  mergedNotes.sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
  const avatar = entry.avatarFile === undefined ? previous?.avatar : capturedAvatar(dirFor(accountId, item.id), item.id,
    text(entry.avatarFile, 100, true), observedAt, source);
  const snapshot = { schema: 1, id: item.id, url, xhsId,
    profileName: manualName, observedAt, source,
    ...(profileEvidence || previous?.profileEvidence ? { profileEvidence: profileEvidence || previous.profileEvidence } : {}),
    profile: { ...(previous?.profile || {}), ...profile },
    notes: mergedNotes,
    ...(visibleNoteUrls ? { visibleNoteUrls, collectionStartedAt } : {}),
    discoveredCount, attemptedCount,
    listObserved: entry.discoveredCount !== undefined || previous?.listObserved === true,
    state, reason, ...(avatar ? { avatar } : {}) };
  if (snapshot.state === 'complete') {
    const missing = [];
    if (!avatar) missing.push('头像缺失');
    if (!Object.keys(snapshot.profile).length) missing.push('主页字段缺失');
    if (!snapshot.listObserved) missing.push('未观察到笔记列表');
    if (attemptedCount < Math.min(discoveredCount, 5) || mergedNotes.length < Math.min(discoveredCount, 5)) missing.push('可见笔记尚未全部处理');
    if (visibleNoteUrls && visibleNoteUrls.some(u => !mergedNotes.some(n => n.url === u && n.observedAt >= collectionStartedAt))) missing.push('本轮笔记尚未全部重新观察');
    if (missing.length) { snapshot.state = 'partial'; snapshot.reason = [reason, ...missing].filter(Boolean).join('；').slice(0, 240); }
  }
  writeJson(file, snapshot);
  return snapshot;
}

function validRecorded(fields, limits) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return false;
  return Object.entries(fields).every(([key, field]) => Object.hasOwn(limits, key) && field && typeof field.value === 'string'
    && field.value.length <= limits[key] && ISO.test(field.observedAt || '') && SOURCES.has(field.source));
}

function validEvidence(value, id) {
  return value === undefined || !!value && ['screenshot', 'ocr'].every((key) => {
    const ext = key === 'screenshot' ? 'png' : 'json';
    return typeof value[key] === 'string' && value[key] === `benchmarks/${id}/${path.basename(value[key])}`
      && new RegExp(`^evidence-[a-f0-9]{16}\\.${ext}$`).test(path.basename(value[key]));
  });
}
function validSnapshot(data, item) {
  return !!data && data.schema === 1 && data.id === item.id && data.url === canonicalProfileUrl(item.url)
    && data.xhsId === item.xhsId && ISO.test(data.observedAt || '') && SOURCES.has(data.source)
    && typeof data.profileName === 'string' && data.profileName.length <= 120
    && STATES.has(data.state) && typeof data.reason === 'string' && data.reason.length <= 240
    && Number.isInteger(data.discoveredCount) && data.discoveredCount >= 0 && data.discoveredCount <= 50
    && Number.isInteger(data.attemptedCount) && data.attemptedCount >= 0 && data.attemptedCount <= 5
    && validRecorded(data.profile, PROFILE_FIELDS) && validEvidence(data.profileEvidence, item.id)
    && Array.isArray(data.notes) && data.notes.length <= 5 && new Set(data.notes.map((n) => n?.url)).size === data.notes.length
    && data.notes.every((note) => note && note.url === canonicalNoteUrl(note.url)
      && (note.position === undefined || Number.isInteger(note.position) && note.position >= 0 && note.position <= 4)
      && ISO.test(note.observedAt || '') && SOURCES.has(note.source) && validRecorded(note.fields, NOTE_FIELDS) && validEvidence(note.evidence, item.id))
    && (!data.avatar || data.avatar.path?.startsWith(`benchmarks/${item.id}/`)
      && /^benchmarks\/b_[\w-]+\/avatar-(?:captured|download)-[a-f0-9]{16}\.(?:png|jpe?g|webp)$/.test(data.avatar.path)
      && ISO.test(data.avatar.observedAt || '') && SOURCES.has(data.avatar.source));
}

export function readObservation(accountId, item) {
  const file = snapshotFile(accountId, item.id);
  if (!fs.existsSync(file)) return { snapshot: null, issue: '' };
  const data = readJson(file, null);
  if (!validSnapshot(data, item)) {
    return { snapshot: null, issue: '观察文件无法读取或账号身份已改变' };
  }
  let avatar = null;
  if (data.avatar && /^benchmarks\/b_[\w-]+\/avatar-(?:captured|download)-[a-f0-9]{16}\.(?:png|jpe?g|webp)$/.test(data.avatar.path)
    && data.avatar.path.startsWith(`benchmarks/${item.id}/`)
    && fs.existsSync(path.join(P.accountsDir, accountId, data.avatar.path))
    && fs.lstatSync(path.join(P.accountsDir, accountId, data.avatar.path)).isFile()) avatar = data.avatar;
  return { snapshot: { ...data, avatar }, issue: '' };
}

export function benchmarkAvatar(accountId, item, snapshot) {
  if (snapshot?.avatar) return { ...snapshot.avatar, kind: snapshot.avatar.kind === 'downloaded' ? 'downloaded' : 'captured' };
  const dir = dirFor(accountId, item.id);
  if (!fs.existsSync(dir)) return null;
  const manual = fs.readdirSync(dir).filter((name) => /^avatar-manual-[a-f0-9]{10}\.(?:png|jpe?g|webp)$/.test(name))
    .filter((name) => fs.lstatSync(path.join(dir, name)).isFile())
    .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  return manual ? { path: `benchmarks/${item.id}/${manual.name}`, kind: 'manual' } : null;
}
