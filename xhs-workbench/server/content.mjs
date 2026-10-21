// M2 内容数据：对标账号、选题、笔记（文案 + 封面）。全部按账号存放在 accounts/<id>/ 下。
// 数据格式与 playbooks/ 中的手册保持一致，agent 可以直接读写这些文件。
import fs from 'node:fs';
import { enqueueCollection, recordCollectionObservation } from './benchmark-queue.mjs';
import { reportWork } from './hub-work.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import { P, accountDir } from './paths.mjs';
import { readJson, writeJson, ensureDir, newId, httpError, moveToTrash, trashListItem, safeJoin, listAccounts } from './store.mjs';
import { mergeObservation, readObservation, benchmarkAvatar, saveManualAvatar, stageCapturedAvatar } from './benchmark-observation.mjs';

export function accRoot(accountId) {
  if (!listAccounts().some((a) => a.id === accountId)) throw httpError(404, '账号不存在');
  return accountDir(accountId);
}

function checkId(id) {
  if (!/^[\w-]+$/.test(String(id || ''))) throw httpError(400, 'id 不合法');
  return id;
}

const now = () => new Date().toISOString();

// 读取 { items: [] } 结构的列表文件；agent 手写漏掉 id 时自动补上并写回
export function readItems(file, prefix) {
  const data = readJson(file, { items: [] });
  const items = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : [];
  let patched = false;
  for (const it of items) {
    if (!it.id) {
      it.id = newId(prefix);
      patched = true;
    }
  }
  if (patched || Array.isArray(data)) writeJson(file, Array.isArray(data) ? { items } : { ...data, items });
  return items;
}

export function upsertItem(file, prefix, input, allowed) {
  const items = readItems(file, prefix);
  const fields = {};
  for (const k of allowed) if (k in input) fields[k] = input[k];
  let item = input.id && items.find((x) => x.id === input.id);
  if (item) Object.assign(item, fields, { updatedAt: now() });
  else {
    item = { id: newId(prefix), ...fields, createdAt: now(), updatedAt: now() };
    items.unshift(item);
  }
  const data = readJson(file, { items: [] });
  writeJson(file, Array.isArray(data) ? { items } : { ...data, items });
  return item;
}

export function removeItem(file, prefix, id, trashGroup, meta = {}) {
  const items = readItems(file, prefix);
  const idx = items.findIndex((x) => x.id === id);
  if (idx < 0) throw httpError(404, '条目不存在');
  const [removed] = items.splice(idx, 1);
  trashListItem(file, removed, trashGroup, meta); // 整条存进回收站，可恢复
  const data = readJson(file, { items: [] });
  writeJson(file, Array.isArray(data) ? { items } : { ...data, items });
  return removed;
}

export function listFiles(dir, exts) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => !f.startsWith('.') && exts.includes(path.extname(f).toLowerCase()))
    .sort();
}

export const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
// 笔记配图：静态图（含 iPhone 的 HEIC）+ 实况图的动态视频
export const STILL_EXTS = [...IMAGE_EXTS, '.heic'];
export const VIDEO_EXTS = ['.mov', '.mp4'];
export const MAX_IMAGES = 18; // 小红书图文笔记的图片上限（含封面，以平台提示为准）

// 保存前端上传的文件（base64）。大文件（视频）用 saveNoteFileStream 走流式上传。
export function cleanUploadName(filename, exts, fallback = 'file') {
  const ext = path.extname(filename || '').toLowerCase();
  if (!exts.includes(ext)) throw httpError(400, `只支持 ${exts.map((e) => e.slice(1)).join(' / ')} 文件`);
  // 扩展名可能是大写（如 IMG_1234.HEIC），按长度去掉而不是按字符串匹配
  const base = path.basename(filename).slice(0, -ext.length).replace(/[^\w一-龥-]+/g, '_').slice(0, 40) || fallback;
  return { base, ext };
}

export function uniqueName(dir, base, ext) {
  ensureDir(dir);
  let name = `${base}${ext}`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base}-${i}${ext}`;
  return name;
}

export function saveUpload(dir, filename, dataBase64, exts = IMAGE_EXTS) {
  const { base, ext } = cleanUploadName(filename, exts, 'image');
  const buf = Buffer.from(String(dataBase64 || '').replace(/^data:[^,]+,/, ''), 'base64');
  if (!buf.length) throw httpError(400, '文件为空');
  const name = uniqueName(dir, base, ext);
  fs.writeFileSync(path.join(dir, name), buf);
  return name;
}

// 账号目录下的任意文件（供 <img> 显示）
export function accountFile(accountId, rel) {
  const file = safeJoin(accRoot(accountId), rel);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) throw httpError(404, '文件不存在');
  return file;
}

// ---------- 对标账号 ----------

const BENCH_FIELDS = ['name', 'xhsId', 'url', 'followers', 'positioning', 'remark', 'status', 'analyzedAt', 'summary',
  // 对标追踪（爆款雷达）：tracking 由用户开启；lastCheckedAt / newCount / radarNote 由 agent 追踪检查时回写
  'tracking', 'lastCheckedAt', 'newCount', 'radarNote'];

function benchIndex(accountId) {
  return path.join(accRoot(accountId), 'benchmarks', 'index.json');
}

function readableBenchIndex(accountId) {
  const file = benchIndex(accountId);
  const data = readJson(file, null);
  if (fs.existsSync(file) && !Array.isArray(data) && !Array.isArray(data?.items)) {
    throw httpError(500, '对标列表文件无法读取，请检查备份，不要覆盖原文件');
  }
  return file;
}

function checkpointDir(accountId) {
  return path.join(accRoot(accountId), 'benchmarks', 'checkpoints');
}

function checkpointText(value, max = 500) {
  if (typeof value !== 'string' || value.length > max) throw new Error('字段格式不合法');
  return value.trim();
}

function profileUrl(value) {
  const raw = checkpointText(value, 2048);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('主页链接不合法');
  }
  if (url.protocol !== 'https:' || !['www.xiaohongshu.com', 'xiaohongshu.com'].includes(url.hostname)
    || url.username || url.password || !/^\/user\/profile\/[\w-]+\/?$/.test(url.pathname)) {
    throw new Error('主页链接不是小红书账号主页');
  }
  return raw;
}

function profileKey(value) {
  return new URL(value).pathname.replace(/\/$/, '');
}

/** agent 每确认一条就写独立检查点；服务端合并到列表，任务超时不影响已合并的数据。 */
export function reconcileBenchmarkCheckpoints(accountId) {
  const root = checkpointDir(accountId);
  const pending = path.join(root, 'pending');
  const result = { candidates: 0, verified: 0, observations: 0, rejected: 0 };
  if (!fs.existsSync(pending)) return result;
  const tombstones = path.join(root, 'deleted.json');
  const old = readJson(tombstones, fs.existsSync(tombstones) ? null : { ids: [] });
  if (!old || !Array.isArray(old.ids)) return result; // 墓碑损坏时宁可不导入，也不能复活已删除账号
  const deleted = new Set(old.ids);
  const index = benchIndex(accountId);
  if (fs.existsSync(index)) {
    // 旧式 agent 直接编辑列表时可能留下半截 JSON；绝不能用空列表覆盖原文件。
    const raw = readJson(index, null);
    if (!Array.isArray(raw) && !Array.isArray(raw?.items)) return result;
  }
  const stageOf = (name) => name.split('.').at(-2).split('-')[0];
  const priority = { candidate: 0, verified: 1, observation: 2 };
  const files = fs.readdirSync(pending).filter((f) => /^b_[\w-]+\.(?:candidate|verified|observation(?:-[a-f0-9]{8}-[0-6])?)\.json$/.test(f))
    .sort((a, b) => a.split('.')[0].localeCompare(b.split('.')[0]) || priority[stageOf(a)] - priority[stageOf(b)] || a.localeCompare(b));
  for (const name of files) {
    const source = path.join(pending, name);
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(source, 'utf8'));
    } catch {
      continue; // 写入尚未完成：不能把残缺 JSON 当成空列表
    }
    const stage = stageOf(name);
    let reason = '';
    try {
      if (!entry || typeof entry !== 'object' || entry.id !== name.split('.')[0] || entry.stage !== stage) {
        throw new Error('检查点 id 或阶段不匹配');
      }
      const file = benchIndex(accountId);
      const items = readItems(file, 'b_');
      const current = readJson(file, { items: [] });
      const save = () => writeJson(file, Array.isArray(current) ? { items } : { ...current, items });
      const item = items.find((b) => b.id === entry.id);
      if (deleted.has(entry.id) && !item) throw new Error('账号已删除，不能从旧检查点恢复');
      if (stage === 'candidate') {
        const name = checkpointText(entry.name, 120);
        if (!name) throw new Error('候选缺少名称');
        if (item && item.name !== name) throw new Error('候选 id 已由其他账号占用');
        if (!item && items.some((b) => b.name === name && !b.url)) throw new Error('同名候选已存在，请先核实原条目');
        if (!item) {
          const remark = entry.remark === undefined ? '' : checkpointText(entry.remark);
          items.push({ id: entry.id, name, remark, status: 'pending', tracking: false,
            createdAt: now(), updatedAt: now() });
          save();
          result.candidates++;
        }
      } else if (stage === 'observation') {
        if (!item) throw new Error('对标账号不存在，不能写入观察');
        mergeObservation(accountId, item, entry);
        result.observations++;
      } else {
        if (!item) throw new Error('请先保存候选，再核实账号');
        const url = profileUrl(entry.url);
        const observedAt = checkpointText(entry.observedAt, 40);
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(observedAt)
          || !Number.isFinite(Date.parse(observedAt))) throw new Error('缺少有效的 ISO 核实时间');
        const xhsId = entry.xhsId === undefined ? '' : checkpointText(entry.xhsId, 120);
        const followers = entry.followers === undefined ? '' : checkpointText(entry.followers, 80);
        const profileName = entry.profileName === undefined ? '' : checkpointText(entry.profileName, 120);
        if (!profileName) throw new Error('缺少主页昵称，无法确认身份');
        if (item.url && profileKey(profileUrl(item.url)) !== profileKey(url)) throw new Error('主页与现有账号不一致');
        if (xhsId && item.xhsId && item.xhsId !== xhsId) throw new Error('小红书号与现有账号不一致');
        if (items.some((b) => {
          if (b.id === entry.id) return false;
          if (xhsId && b.xhsId === xhsId) return true;
          try {
            return b.url && profileKey(profileUrl(b.url)) === profileKey(url);
          } catch {
            return false; // 其他条目的无效手填链接，不阻断当前账号的核实
          }
        })) throw new Error('此主页或小红书号已登记为另一个对标账号');
        const next = { ...item };
        if (!next.url) next.url = url;
        if (!next.xhsId && xhsId) next.xhsId = xhsId;
        if (followers) {
          next.observedFollowers = followers; // 与用户手填值分开保留，避免把旧值误当成核实数据
          if (!next.followers || next.followers === '待核实') next.followers = followers;
        }
        next.profileName = profileName;
        if (entry.source !== undefined) {
          if (entry.source !== 'profile-visible') throw new Error('核实来源不合法');
          next.verificationSource = { kind: 'profile-visible', url, fields: followers ? ['profileName', 'xhsId', 'followers'] : ['profileName', 'xhsId'] };
        }
        next.verifiedAt = observedAt;
        next.updatedAt = now();
        Object.assign(item, next);
        save();
        result.verified++;
      }
    } catch (err) {
      reason = err.message;
      result.rejected++;
    }
    if (!reason && stage === 'observation') recordCollectionObservation(accountId, entry.id);
    if (!reason && ['candidate', 'verified'].includes(stage)) enqueueCollection(accountId, [entry.id]);
    // 已处理的文件移走；崩溃发生在写入列表之后、移走之前时，重放也是幂等的。
    const destination = path.join(root, reason ? 'rejected' : 'applied');
    ensureDir(destination);
    const target = path.join(destination, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${name}`);
    fs.renameSync(source, target);
    if (reason) fs.writeFileSync(`${target}.reason.txt`, reason);
  }
  return result;
}

export function benchmarkCheckpointIssues(accountId) {
  const dir = checkpointDir(accountId);
  const pending = path.join(dir, 'pending');
  const rejected = path.join(dir, 'rejected');
  return {
    incomplete: fs.existsSync(pending) ? fs.readdirSync(pending).filter((f) => f.endsWith('.json')).length : 0,
    rejected: fs.existsSync(rejected) ? fs.readdirSync(rejected).filter((f) => f.endsWith('.json')).length : 0,
  };
}

export function listBenchmarks(accountId) {
  reconcileBenchmarkCheckpoints(accountId);
  const index = readableBenchIndex(accountId);
  const dir = path.join(accRoot(accountId), 'benchmarks');
  return readItems(index, 'b_').map((b) => {
    const { snapshot, issue } = readObservation(accountId, b);
    return { ...b, avatar: benchmarkAvatar(accountId, b, snapshot),
      observation: snapshot ? { state: snapshot.state, observedAt: snapshot.observedAt,
        source: snapshot.source, noteCount: snapshot.notes.length, profile: snapshot.profile, reason: snapshot.reason } : null,
      observationIssue: issue,
      hasReport: fs.existsSync(path.join(dir, b.id, 'report.md')),
      noteCount: readJson(path.join(dir, b.id, 'notes.json'), []).length || 0 };
  });
}

const NOTE_REPORT = { draft: ['进行中', 30, '草稿'], ready: ['待审核', 90, '待发布'], published: ['已完成', 100, '已发布'] };

/** 把笔记的状态变化上报给企业中枢（没接入中枢时什么都不做）。只报标题和状态，不报正文。 */
function reportNote(accountId, meta, before) {
  const title = String(meta.title || meta.titleOptions?.[0] || '').trim() || '未命名笔记';
  if (before && before.status === meta.status && before.title === title) return;
  const [status, progress, label] = NOTE_REPORT[meta.status] || NOTE_REPORT.draft;
  reportWork({ key: `note:${accountId}:${meta.id}`, title: `笔记：${title}`, kind: '笔记', status, progress, note: label,
    link: meta.status === 'published' ? meta.publishedUrl : '' });
}

export function saveBenchmark(accountId, input) {
  if (!input.id && !String(input.name || '').trim()) throw httpError(400, '请填写对标账号名称');
  const index = readableBenchIndex(accountId);
  if (input.id && !readItems(index, 'b_').some((b) => b.id === input.id)) {
    throw httpError(404, '对标账号不存在');
  }
  const prevBench = input.id ? readItems(index, 'b_').find((b) => b.id === input.id) : null;
  const before = prevBench ? { status: prevBench.status, analyzedAt: prevBench.analyzedAt } : null;
  const item = upsertItem(index, 'b_', input.id ? input : { status: 'pending', ...input }, BENCH_FIELDS);
  if (item.status === 'analyzed' && (before?.status !== 'analyzed' || before.analyzedAt !== item.analyzedAt)) {
    reportWork({ key: `benchmark:${accountId}:${item.id}`, title: `对标拆解：${item.name}`, kind: '对标报告', status: '已完成' });
  }
  ensureDir(path.join(accRoot(accountId), 'benchmarks', item.id, 'screenshots'));
  return item;
}

export function benchmarkDetail(accountId, id) {
  checkId(id);
  const item = listBenchmarks(accountId).find((b) => b.id === id);
  if (!item) throw httpError(404, '对标账号不存在');
  const dir = path.join(accRoot(accountId), 'benchmarks', id);
  let report = '';
  try {
    report = fs.readFileSync(path.join(dir, 'report.md'), 'utf8');
  } catch {
    /* 尚未拆解 */
  }
  const notes = readJson(path.join(dir, 'notes.json'), []);
  const observed = readObservation(accountId, item);
  return {
    item,
    observation: observed.snapshot, observationIssue: observed.issue,
    report,
    notes: Array.isArray(notes) ? notes : notes.items || [],
    screenshots: listFiles(path.join(dir, 'screenshots'), IMAGE_EXTS).map((f) => `benchmarks/${id}/screenshots/${f}`),
  };
}

export function uploadBenchmarkAvatar(accountId, id, filename, dataBase64) {
  benchmarkDetail(accountId, id); // 不允许给不存在或已删除的对标账号添加头像
  return saveManualAvatar(accountId, id, filename, dataBase64);
}

export function stageBenchmarkAvatar(accountId, id, buffer) {
  benchmarkDetail(accountId, id);
  return stageCapturedAvatar(accountId, id, buffer);
}

export function uploadBenchmarkShot(accountId, id, filename, dataBase64) {
  checkId(id);
  const name = saveUpload(path.join(accRoot(accountId), 'benchmarks', id, 'screenshots'), filename, dataBase64);
  return `benchmarks/${id}/screenshots/${name}`;
}

export function deleteBenchmark(accountId, id) {
  checkId(id);
  const index = readableBenchIndex(accountId);
  if (!readItems(index, 'b_').some((b) => b.id === id)) throw httpError(404, '对标账号不存在');
  // 先记录墓碑，再移走条目；即使删除中途退出，旧检查点也不能把账号重新加回来。
  const file = path.join(checkpointDir(accountId), 'deleted.json');
  const data = readJson(file, fs.existsSync(file) ? null : { ids: [] });
  if (!data || !Array.isArray(data.ids)) throw httpError(500, '对标删除记录无法读取，请先检查备份');
  const ids = new Set(data.ids);
  ids.add(id);
  writeJson(file, { ids: [...ids] });
  const b = removeItem(index, 'b_', id, 'benchmarks', { account: accountId });
  const dir = path.join(accRoot(accountId), 'benchmarks', id);
  if (fs.existsSync(dir)) moveToTrash(dir, 'benchmarks', { account: accountId, label: `对标拆解资料：${b.name}` });
}

/** 用户看过追踪结果：清掉新笔记提醒（agent 下次检查再发现新笔记时会重新写上） */
export function markBenchmarkSeen(accountId, id) {
  checkId(id);
  const index = readableBenchIndex(accountId);
  const items = readItems(index, 'b_');
  const item = items.find((b) => b.id === id);
  if (!item) throw httpError(404, '对标账号不存在');
  item.newCount = 0;
  delete item.radarNote;
  const data = readJson(index, { items: [] });
  writeJson(index, Array.isArray(data) ? { items } : { ...data, items });
  return item;
}

// ---------- 选题 ----------

const TOPIC_FIELDS = ['title', 'angle', 'keywords', 'source', 'sourceRef', 'scores', 'score', 'status', 'reason', 'noteId', 'sources', 'basis', 'generationId', 'reviewId', 'reviewIndex', 'evidence'];

function topicsFile(accountId) {
  return path.join(accRoot(accountId), 'topics', 'topics.json');
}

export function listTopics(accountId) {
  return readItems(topicsFile(accountId), 't_');
}

export function saveTopic(accountId, input) {
  if (!input.id && !String(input.title || '').trim()) throw httpError(400, '请填写选题');
  return upsertItem(topicsFile(accountId), 't_', { ...(!input.id ? { status: 'idea', source: '手动添加' } : {}), ...input }, TOPIC_FIELDS);
}

export function deleteTopic(accountId, id) {
  removeItem(topicsFile(accountId), 't_', checkId(id), 'topics', { account: accountId });
}

// ---------- 笔记（文案 + 封面） ----------

const NOTE_FIELDS = ['title', 'titleOptions', 'tags', 'topicId', 'status', 'cover', 'coverOptions', 'publishedUrl', 'publishedAt', 'visibility', 'coverMode', 'sources', 'basis'];

function noteDir(accountId, id) {
  return path.join(accRoot(accountId), 'notes', checkId(id));
}

export function coverHash(cover) {
  return cover ? crypto.createHash('sha1').update(JSON.stringify(cover)).digest('hex').slice(0, 12) : '';
}

function readNote(dir) {
  const id = path.basename(dir);
  const meta = readJson(path.join(dir, 'meta.json'), null);
  if (!meta) return null;
  const hasCover = fs.existsSync(path.join(dir, 'cover.png'));
  let rendered = '';
  try {
    rendered = fs.readFileSync(path.join(dir, '.cover-hash'), 'utf8').trim();
  } catch {
    /* 尚未渲染 */
  }
  const hash = coverHash(meta.cover);
  return {
    titleOptions: [],
    tags: [],
    coverOptions: [],
    status: 'draft',
    ...meta,
    id,
    hasCover,
    coverHash: hash,
    coverStale: !!meta.cover && hash !== rendered,
  };
}

export function listNotes(accountId) {
  const root = path.join(accRoot(accountId), 'notes');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => readNote(path.join(root, e.name)))
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export function noteDetail(accountId, id) {
  const dir = noteDir(accountId, id);
  const meta = readNote(dir);
  if (!meta) throw httpError(404, '笔记不存在');
  let content = '';
  try {
    content = fs.readFileSync(path.join(dir, 'content.md'), 'utf8');
  } catch {
    /* 还没有正文 */
  }
  let videoScript = '';
  try {
    videoScript = fs.readFileSync(path.join(dir, 'video.md'), 'utf8');
  } catch {
    /* 还没有视频脚本 */
  }
  const imgDir = path.join(dir, 'images');
  // 视频笔记（meta.video 存在）：配图停用（meta.media 保留，切回图文时恢复），视频封面单独管理
  const media = meta.video ? [] : normalizeMedia(dir, meta.media);
  return {
    ...meta,
    content,
    videoScript,
    coverMode: meta.coverMode === 'first' ? 'first' : 'template',
    media,
    images: media.map((m) => m.file),
    looseVideos: meta.video ? [] : looseVideos(dir, media),
    video: meta.video ? { ...meta.video, coverCandidates: listFiles(imgDir, STILL_EXTS) } : null,
  };
}

/** 保存视频脚本（notes/<id>/video.md，分镜表 + 口播 + 素材清单） */
export function saveVideoScript(accountId, id, markdown) {
  const dir = noteDir(accountId, id);
  if (!fs.existsSync(path.join(dir, 'meta.json'))) throw httpError(404, '笔记不存在');
  fs.writeFileSync(path.join(dir, 'video.md'), String(markdown || ''));
  const meta = readJson(path.join(dir, 'meta.json'), {});
  meta.updatedAt = now();
  writeJson(path.join(dir, 'meta.json'), meta);
  return { ok: true };
}

/**
 * 配图顺序与实况图配对：meta.media = [{ file, video? }]
 * - 去掉已不存在的文件；images/ 里新出现的静态图追加到末尾
 * - 同名的静态图和视频（如 IMG_1234.HEIC + IMG_1234.MOV）自动配成实况图
 */
function normalizeMedia(dir, saved) {
  const imgDir = path.join(dir, 'images');
  const stills = listFiles(imgDir, STILL_EXTS);
  const videos = listFiles(imgDir, VIDEO_EXTS);
  const out = [];
  const seen = new Set();
  for (const m of Array.isArray(saved) ? saved : []) {
    if (!m || !stills.includes(m.file) || seen.has(m.file)) continue;
    seen.add(m.file);
    out.push({ file: m.file, ...(m.video && videos.includes(m.video) ? { video: m.video } : {}) });
  }
  for (const f of stills) if (!seen.has(f)) out.push({ file: f });
  const used = new Set(out.map((m) => m.video).filter(Boolean));
  for (const m of out) {
    if (m.video) continue;
    const base = path.basename(m.file, path.extname(m.file)).toLowerCase();
    const twin = videos.find((v) => !used.has(v) && path.basename(v, path.extname(v)).toLowerCase() === base);
    if (twin) {
      m.video = twin;
      used.add(twin);
    }
  }
  return out;
}

function looseVideos(dir, media) {
  const used = new Set(media.map((m) => m.video).filter(Boolean));
  return listFiles(path.join(dir, 'images'), VIDEO_EXTS).filter((v) => !used.has(v));
}

/** 保存配图顺序 / 实况图配对 */
export function saveMedia(accountId, id, media) {
  const dir = noteDir(accountId, id);
  const meta = readJson(path.join(dir, 'meta.json'), null);
  if (!meta) throw httpError(404, '笔记不存在');
  if (!Array.isArray(media)) throw httpError(400, 'media 应为数组');
  meta.media = normalizeMedia(dir, media.map((m) => ({ file: String(m.file || ''), video: m.video ? String(m.video) : undefined })));
  meta.updatedAt = now();
  writeJson(path.join(dir, 'meta.json'), meta);
  return noteDetail(accountId, id);
}

/** 删除一张配图（连同配对的视频）→ 回收站 */
export function deleteMedia(accountId, id, file) {
  const dir = noteDir(accountId, id);
  const detail = noteDetail(accountId, id);
  const item = detail.media.find((m) => m.file === file) || (detail.looseVideos.includes(file) ? { file } : null);
  if (!item) throw httpError(404, '配图不存在');
  for (const f of [item.file, item.video].filter(Boolean)) {
    moveToTrash(safeJoin(path.join(dir, 'images'), f), 'notes', { account: accountId, label: `配图：${detail.title || id} / ${f}` });
  }
  return saveMedia(accountId, id, detail.media.filter((m) => m.file !== file));
}

/** 裁剪：裁剪后的图另存为新文件替换原位置，原图进回收站（可恢复） */
export function cropMedia(accountId, id, file, dataBase64) {
  const dir = noteDir(accountId, id);
  const detail = noteDetail(accountId, id);
  const idx = detail.media.findIndex((m) => m.file === file);
  if (idx < 0) throw httpError(404, '配图不存在');
  if (detail.media[idx].video) throw httpError(400, '实况图裁剪后静态图会和动态视频对不上，不支持裁剪');
  const base = path.basename(file, path.extname(file)).replace(/-crop\d*$/, '');
  const name = saveUpload(path.join(dir, 'images'), `${base}-crop.jpg`, dataBase64);
  moveToTrash(safeJoin(path.join(dir, 'images'), file), 'notes', { account: accountId, label: `裁剪前的原图：${detail.title || id} / ${file}` });
  const media = detail.media.map((m, i) => (i === idx ? { file: name } : m));
  return saveMedia(accountId, id, media);
}

// ---------- 视频笔记 ----------

/** 设置视频笔记：file 为 images/ 里的视频（传空转为图文）；cover 可选，传空清除 */
export function setNoteVideo(accountId, id, input = {}) {
  const dir = noteDir(accountId, id);
  const meta = readJson(path.join(dir, 'meta.json'), null);
  if (!meta) throw httpError(404, '笔记不存在');
  const imgDir = path.join(dir, 'images');
  let video = meta.video && typeof meta.video === 'object' ? { ...meta.video } : null;
  if ('file' in input) {
    const file = String(input.file || '');
    if (!file) video = null;
    else {
      if (!listFiles(imgDir, VIDEO_EXTS).includes(file)) throw httpError(400, '视频文件不存在，请先上传');
      video = { file };
    }
  }
  if (video && 'cover' in input) {
    const cover = String(input.cover || '');
    if (cover) {
      if (!listFiles(imgDir, STILL_EXTS).includes(cover)) throw httpError(400, '封面文件不存在');
      video.cover = cover;
    } else delete video.cover;
  }
  meta.video = video;
  meta.updatedAt = now();
  writeJson(path.join(dir, 'meta.json'), meta);
  return noteDetail(accountId, id);
}

/** 删除视频或它的封面文件（进回收站，可恢复） */
export function deleteNoteVideoFile(accountId, id, file) {
  const dir = noteDir(accountId, id);
  const meta = readJson(path.join(dir, 'meta.json'), null);
  if (!meta || !meta.video) throw httpError(404, '这篇不是视频笔记');
  const isVideo = meta.video.file === file;
  const isCover = meta.video.cover === file;
  if (!isVideo && !isCover) throw httpError(404, '文件不属于这个视频');
  moveToTrash(safeJoin(path.join(dir, 'images'), file), 'notes', { account: accountId, label: `视频笔记素材：${meta.title || id} / ${file}` });
  if (isVideo) meta.video = null;
  else delete meta.video.cover;
  meta.updatedAt = now();
  writeJson(path.join(dir, 'meta.json'), meta);
  return noteDetail(accountId, id);
}

// 视频文件大，走流式上传（POST /api/notes/upload-file，请求体直接写盘）
export const MAX_VIDEO_BYTES = 1024 * 1024 * 1024; // 1GB

export function saveNoteFileStream(accountId, id, filename, req) {
  const dir = noteDir(accountId, id);
  if (!fs.existsSync(path.join(dir, 'meta.json'))) throw httpError(404, '笔记不存在');
  const imgDir = path.join(dir, 'images');
  const { base, ext } = cleanUploadName(filename, [...STILL_EXTS, ...VIDEO_EXTS]);
  const name = uniqueName(imgDir, base, ext);
  const out = path.join(imgDir, name);
  const cleanup = () => {
    try {
      fs.unlinkSync(out);
    } catch {
      /* 已经不存在 */
    }
  };
  return new Promise((resolve, reject) => {
    let size = 0;
    let failed = false;
    const ws = fs.createWriteStream(out);
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_VIDEO_BYTES) {
        failed = true;
        ws.destroy();
        cleanup();
        req.destroy();
        reject(httpError(413, '视频超过 1GB 上限'));
      }
    });
    req.on('error', () => {
      if (failed) return;
      failed = true;
      ws.destroy();
      cleanup();
      reject(httpError(400, '上传中断'));
    });
    ws.on('error', (err) => {
      if (failed) return;
      failed = true;
      cleanup();
      reject(err);
    });
    ws.on('finish', () => resolve(name));
    req.pipe(ws);
  });
}

/** 笔记素材打包：封面 + 按顺序编号的配图 / 实况视频（或视频笔记的视频）+ 文案，方便手动发布 */
export function noteBundle(accountId, id) {
  const dir = noteDir(accountId, id);
  const n = noteDetail(accountId, id);
  const entries = [];
  const pad = (i) => String(i).padStart(2, '0');
  let i = 1;
  if (n.video) {
    // 封面优先级：用户指定的视频封面（images/ 里）→ 模板封面（笔记根目录的 cover.png）→ 平台默认首帧（不打包）
    let coverPath = n.video.cover ? path.join(dir, 'images', n.video.cover) : n.coverMode !== 'first' ? path.join(dir, 'cover.png') : '';
    if (!coverPath || !fs.existsSync(coverPath)) coverPath = '';
    else entries.push({ name: `${pad(i++)}-封面${path.extname(coverPath)}`, file: coverPath });
    entries.push({ name: `${pad(i++)}-视频${path.extname(n.video.file)}`, file: path.join(dir, 'images', n.video.file) });
  } else {
    if (n.coverMode !== 'first' && fs.existsSync(path.join(dir, 'cover.png'))) entries.push({ name: `${pad(i++)}-封面.png`, file: path.join(dir, 'cover.png') });
    for (const m of n.media) {
      const k = pad(i++);
      entries.push({ name: `${k}${path.extname(m.file)}`, file: path.join(dir, 'images', m.file) });
      if (m.video) entries.push({ name: `${k}-实况${path.extname(m.video)}`, file: path.join(dir, 'images', m.video) });
    }
  }
  const text = `${n.title || ''}\n\n${(n.content || '').trim()}\n\n${(n.tags || []).map((t) => `#${t}`).join(' ')}\n`;
  const extra = [];
  if (n.videoScript && n.videoScript.trim()) extra.push({ name: '视频脚本.md', data: Buffer.from(n.videoScript) });
  return {
    title: n.title || id,
    entries: [...entries.map((e) => ({ name: e.name, data: fs.readFileSync(e.file) })), { name: '文案.txt', data: Buffer.from(text) }, ...extra],
  };
}

export function saveNote(accountId, input) {
  if (!input.id && input.topicId) {
    const topic = listTopics(accountId).find(t => t.id === input.topicId);
    if (!topic) throw httpError(404, '选题不存在');
    const existing = listNotes(accountId).find(n => n.id === topic.noteId || n.topicId === topic.id);
    if (existing) return noteDetail(accountId, existing.id);
  }
  const id = input.id ? checkId(input.id) : newId('n_');
  const dir = noteDir(accountId, id);
  const prev = readJson(path.join(dir, 'meta.json'), null);
  if (!prev && input.id && !input.create) throw httpError(404, '笔记不存在');
  const before = prev ? { status: prev.status, title: String(prev.title || prev.titleOptions?.[0] || '').trim() || '未命名笔记' } : null;
  const meta = prev || { id, status: 'draft', titleOptions: [], tags: [], createdAt: now() };
  for (const k of NOTE_FIELDS) if (k in input) meta[k] = input[k];
  meta.id = id;
  meta.updatedAt = now();
  ensureDir(path.join(dir, 'images'));
  writeJson(path.join(dir, 'meta.json'), meta);
  if (typeof input.content === 'string') fs.writeFileSync(path.join(dir, 'content.md'), input.content);
  else if (!fs.existsSync(path.join(dir, 'content.md'))) fs.writeFileSync(path.join(dir, 'content.md'), '');

  reportNote(accountId, meta, before);

  // 从选题创建笔记时，回写选题状态
  if (!prev && meta.topicId) {
    const t = listTopics(accountId).find((x) => x.id === meta.topicId);
    if (t) saveTopic(accountId, { id: t.id, status: 'writing', noteId: id });
  }
  return noteDetail(accountId, id);
}

export function saveCoverImage(accountId, id, dataBase64, hash) {
  const dir = noteDir(accountId, id);
  if (!fs.existsSync(path.join(dir, 'meta.json'))) throw httpError(404, '笔记不存在');
  const buf = Buffer.from(String(dataBase64 || '').replace(/^data:[^,]+,/, ''), 'base64');
  if (!buf.length) throw httpError(400, '封面为空');
  const current = readNote(dir);
  if (current.coverHash !== String(hash || '')) throw httpError(409, '封面方案已修改，请重新渲染');
  if (current.hasCover && !fs.readFileSync(path.join(dir, 'cover.png')).equals(buf)) {
    const backup = path.join(dir, 'cover-backups');ensureDir(backup);
    fs.copyFileSync(path.join(dir, 'cover.png'), path.join(backup, newId('cover_')+'.png'));
  }
  fs.writeFileSync(path.join(dir, 'cover.png'), buf);
  fs.writeFileSync(path.join(dir, '.cover-hash'), String(hash || ''));
  return { ok: true };
}

export function uploadNoteImage(accountId, id, filename, dataBase64) {
  const dir = noteDir(accountId, id);
  if (!fs.existsSync(path.join(dir, 'meta.json'))) throw httpError(404, '笔记不存在');
  return saveUpload(path.join(dir, 'images'), filename, dataBase64, [...STILL_EXTS, ...VIDEO_EXTS]);
}

export function deleteNote(accountId, id) {
  const dir = noteDir(accountId, id);
  if (!fs.existsSync(dir)) throw httpError(404, '笔记不存在');
  const meta = readJson(path.join(dir, 'meta.json'), {});
  moveToTrash(dir, 'notes', { account: accountId, label: `笔记：${meta.title || id}` });
}
