// M2 内容数据：对标账号、选题、笔记（文案 + 封面）。全部按账号存放在 accounts/<id>/ 下。
// 数据格式与 playbooks/ 中的手册保持一致，agent 可以直接读写这些文件。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { P, accountDir } from './paths.mjs';
import { readJson, writeJson, ensureDir, newId, httpError, moveToTrash, safeJoin, listAccounts } from './store.mjs';

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
  if (patched || Array.isArray(data)) writeJson(file, { items });
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
  writeJson(file, { items });
  return item;
}

export function removeItem(file, prefix, id, trashGroup) {
  const items = readItems(file, prefix);
  const idx = items.findIndex((x) => x.id === id);
  if (idx < 0) throw httpError(404, '条目不存在');
  const [removed] = items.splice(idx, 1);
  // 被删条目追加到回收站日志，便于找回
  const trashFile = path.join(P.trash, `${trashGroup}.jsonl`);
  ensureDir(path.dirname(trashFile));
  fs.appendFileSync(trashFile, JSON.stringify({ ...removed, deletedAt: now() }) + '\n');
  writeJson(file, { items });
}

export function listFiles(dir, exts) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => !f.startsWith('.') && exts.includes(path.extname(f).toLowerCase()))
    .sort();
}

export const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

// 保存前端上传的文件（base64）
export function saveUpload(dir, filename, dataBase64, exts = IMAGE_EXTS) {
  const ext = path.extname(filename || '').toLowerCase();
  if (!exts.includes(ext)) throw httpError(400, `只支持 ${exts.map((e) => e.slice(1)).join(' / ')} 文件`);
  const base = path.basename(filename, ext).replace(/[^\w一-龥-]+/g, '_').slice(0, 40) || 'image';
  ensureDir(dir);
  let name = `${base}${ext}`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base}-${i}${ext}`;
  const buf = Buffer.from(String(dataBase64 || '').replace(/^data:[^,]+,/, ''), 'base64');
  if (!buf.length) throw httpError(400, '文件为空');
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

const BENCH_FIELDS = ['name', 'xhsId', 'url', 'followers', 'positioning', 'remark', 'status', 'analyzedAt', 'summary'];

function benchIndex(accountId) {
  return path.join(accRoot(accountId), 'benchmarks', 'index.json');
}

export function listBenchmarks(accountId) {
  const dir = path.join(accRoot(accountId), 'benchmarks');
  return readItems(benchIndex(accountId), 'b_').map((b) => ({
    ...b,
    hasReport: fs.existsSync(path.join(dir, b.id, 'report.md')),
    noteCount: readJson(path.join(dir, b.id, 'notes.json'), []).length || 0,
  }));
}

export function saveBenchmark(accountId, input) {
  if (!input.id && !String(input.name || '').trim()) throw httpError(400, '请填写对标账号名称');
  const item = upsertItem(benchIndex(accountId), 'b_', { status: 'pending', ...input }, BENCH_FIELDS);
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
  return {
    item,
    report,
    notes: Array.isArray(notes) ? notes : notes.items || [],
    screenshots: listFiles(path.join(dir, 'screenshots'), IMAGE_EXTS).map((f) => `benchmarks/${id}/screenshots/${f}`),
  };
}

export function uploadBenchmarkShot(accountId, id, filename, dataBase64) {
  checkId(id);
  const name = saveUpload(path.join(accRoot(accountId), 'benchmarks', id, 'screenshots'), filename, dataBase64);
  return `benchmarks/${id}/screenshots/${name}`;
}

export function deleteBenchmark(accountId, id) {
  checkId(id);
  removeItem(benchIndex(accountId), 'b_', id, 'benchmarks');
  const dir = path.join(accRoot(accountId), 'benchmarks', id);
  if (fs.existsSync(dir)) moveToTrash(dir, 'benchmarks');
}

// ---------- 选题 ----------

const TOPIC_FIELDS = ['title', 'angle', 'keywords', 'source', 'sourceRef', 'scores', 'score', 'status', 'reason', 'noteId'];

function topicsFile(accountId) {
  return path.join(accRoot(accountId), 'topics', 'topics.json');
}

export function listTopics(accountId) {
  return readItems(topicsFile(accountId), 't_');
}

export function saveTopic(accountId, input) {
  if (!input.id && !String(input.title || '').trim()) throw httpError(400, '请填写选题');
  return upsertItem(topicsFile(accountId), 't_', { status: 'idea', source: '手动添加', ...input }, TOPIC_FIELDS);
}

export function deleteTopic(accountId, id) {
  removeItem(topicsFile(accountId), 't_', checkId(id), 'topics');
}

// ---------- 笔记（文案 + 封面） ----------

const NOTE_FIELDS = ['title', 'titleOptions', 'tags', 'topicId', 'status', 'cover', 'coverOptions', 'publishedUrl', 'publishedAt', 'visibility'];

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
  return { ...meta, content, images: listFiles(path.join(dir, 'images'), IMAGE_EXTS) };
}

export function saveNote(accountId, input) {
  const id = input.id ? checkId(input.id) : newId('n_');
  const dir = noteDir(accountId, id);
  const prev = readJson(path.join(dir, 'meta.json'), null);
  if (!prev && input.id && !input.create) throw httpError(404, '笔记不存在');
  const meta = prev || { id, status: 'draft', titleOptions: [], tags: [], createdAt: now() };
  for (const k of NOTE_FIELDS) if (k in input) meta[k] = input[k];
  meta.id = id;
  meta.updatedAt = now();
  ensureDir(path.join(dir, 'images'));
  writeJson(path.join(dir, 'meta.json'), meta);
  if (typeof input.content === 'string') fs.writeFileSync(path.join(dir, 'content.md'), input.content);
  else if (!fs.existsSync(path.join(dir, 'content.md'))) fs.writeFileSync(path.join(dir, 'content.md'), '');

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
  fs.writeFileSync(path.join(dir, 'cover.png'), buf);
  fs.writeFileSync(path.join(dir, '.cover-hash'), String(hash || ''));
  return { ok: true };
}

export function uploadNoteImage(accountId, id, filename, dataBase64) {
  const dir = noteDir(accountId, id);
  if (!fs.existsSync(path.join(dir, 'meta.json'))) throw httpError(404, '笔记不存在');
  return saveUpload(path.join(dir, 'images'), filename, dataBase64);
}

export function deleteNote(accountId, id) {
  const dir = noteDir(accountId, id);
  if (!fs.existsSync(dir)) throw httpError(404, '笔记不存在');
  moveToTrash(dir, 'notes');
}
