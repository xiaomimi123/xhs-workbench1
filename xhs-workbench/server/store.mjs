// 数据层：所有业务数据都是数据目录下的 JSON / Markdown 文件，agent 可以直接读写
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { P, WORKSPACE, ACCOUNT_SUBDIRS, accountDir } from './paths.mjs';
import { search } from './search.mjs';

// ---------- 通用工具 ----------

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// 先写临时文件再改名，避免写一半被读到
export function writeJson(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function newId(prefix = '') {
  return prefix + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

// 把相对路径限制在 base 目录内，防止 ../ 越界。只收两个参数：多段路径先用 path.join 拼好再传，
// 多传的参数以前会被静默丢掉（删素材时因此把整个 files 目录移进了回收站）
export function safeJoin(base, rel, ...extra) {
  if (extra.length) throw new Error('safeJoin 只接受 (base, rel) 两个参数，多段路径请先 path.join');
  const target = path.resolve(base, rel || '');
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw httpError(400, '路径不合法');
  }
  return target;
}

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ---------- 回收站 ----------
// 删除一律移入 .trash，不做永久删除；index.json 记录原位置，供界面一键恢复

const trashIndexFile = () => path.join(P.trash, 'index.json');
const rel = (abs) => path.relative(WORKSPACE, abs).split(path.sep).join('/');

function recordTrash(entry) {
  const index = readJson(trashIndexFile(), { items: [] });
  index.items.unshift({ id: newId('tr_'), deletedAt: new Date().toISOString(), ...entry });
  writeJson(trashIndexFile(), index);
}

/** 把文件或目录移入回收站。meta: { label, account } */
export function moveToTrash(file, group, meta = {}) {
  const dest = path.join(P.trash, group, `${Date.now()}-${path.basename(file)}`);
  ensureDir(path.dirname(dest));
  fs.renameSync(file, dest);
  recordTrash({ kind: 'path', group, label: meta.label || path.basename(file), account: meta.account || null, original: rel(file), stored: path.relative(P.trash, dest).split(path.sep).join('/') });
  return dest;
}

/** 列表文件（{items: []}）中被删除的条目，整条存进回收站 */
const GROUP_LABEL = { topics: '选题', schedule: '发布排期', benchmarks: '对标账号' };

export function trashListItem(listFile, item, group, meta = {}) {
  recordTrash({ kind: 'item', group, label: meta.label || `${GROUP_LABEL[group] || group}：${item.title || item.name || item.id}`, account: meta.account || null, listFile: rel(listFile), item });
}

export function listTrash() {
  return readJson(trashIndexFile(), { items: [] }).items.map((e) => ({
    ...e,
    item: undefined,
    restorable: e.kind === 'item' || fs.existsSync(path.join(P.trash, e.stored || '')),
  }));
}

function freePath(target) {
  if (!fs.existsSync(target)) return target;
  const ext = fs.statSync(target).isDirectory() ? '' : path.extname(target);
  const base = target.slice(0, target.length - ext.length);
  for (let i = 1; ; i++) {
    const candidate = `${base}-恢复${i > 1 ? i : ''}${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
}

/** 恢复到原位置；原位置已被占用时加「-恢复」后缀 */
export function restoreTrash(id) {
  const index = readJson(trashIndexFile(), { items: [] });
  const entry = index.items.find((e) => e.id === id);
  if (!entry) throw httpError(404, '回收站里没有这一项');
  let restoredTo;
  if (entry.kind === 'path') {
    const from = safeJoin(P.trash, entry.stored);
    if (!fs.existsSync(from)) throw httpError(410, '文件已不在回收站里');
    const to = freePath(safeJoin(WORKSPACE, entry.original));
    ensureDir(path.dirname(to));
    fs.renameSync(from, to);
    restoredTo = rel(to);
  } else {
    const file = safeJoin(WORKSPACE, entry.listFile);
    const data = readJson(file, { items: [] });
    const items = Array.isArray(data.items) ? data.items : [];
    const item = { ...entry.item };
    if (items.some((x) => x.id === item.id)) item.id = newId(String(item.id).split('_')[0] + '_');
    items.unshift(item);
    writeJson(file, { ...data, items });
    restoredTo = entry.listFile;
  }
  index.items = index.items.filter((e) => e.id !== id);
  writeJson(trashIndexFile(), index);
  return { restoredTo, entry: { ...entry, item: undefined } };
}

// ---------- 数据目录初始化 ----------

export function ensureWorkspace() {
  for (const dir of [P.config, P.accountsDir, P.knowledge, P.chats, P.logs, P.run, P.trash]) ensureDir(dir);

  if (!fs.existsSync(P.settings)) {
    writeJson(P.settings, { version: 1, createdAt: new Date().toISOString() });
  }

  if (!fs.existsSync(P.accounts)) {
    writeJson(P.accounts, {
      defaultAccountId: 'default',
      accounts: [blankAccount('default', '我的账号')],
    });
  }
  for (const acc of listAccounts()) ensureAccountDirs(acc.id);

  // 知识库为空时放入初始模板
  if (fs.readdirSync(P.knowledge).filter((f) => !f.startsWith('.')).length === 0) seedKnowledge();
}

// 包内模板文件名是 ASCII（避免解压工具弄乱中文文件名），按 manifest 复制成中文路径
function seedKnowledge() {
  const dir = path.join(P.templates, 'knowledge');
  const manifest = readJson(path.join(dir, 'manifest.json'), { files: {} });
  for (const [src, dest] of Object.entries(manifest.files)) {
    const from = path.join(dir, src);
    const to = safeJoin(P.knowledge, dest);
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;
    ensureDir(path.dirname(to));
    fs.copyFileSync(from, to);
  }
}

// ---------- 账号 ----------

function blankAccount(id, name) {
  return { id, name, xhsId: '', positioning: '', audience: '', style: '', createdAt: new Date().toISOString() };
}

function ensureAccountDirs(id) {
  for (const sub of ACCOUNT_SUBDIRS) ensureDir(path.join(accountDir(id), sub));
  ensureDir(path.join(accountDir(id), 'benchmarks', 'checkpoints', 'pending'));
}

export function listAccounts() {
  return readJson(P.accounts, { accounts: [] }).accounts;
}

export function getAccounts() {
  return readJson(P.accounts, { defaultAccountId: null, accounts: [] });
}

export function getAccount(id) {
  const data = getAccounts();
  return data.accounts.find((a) => a.id === id) || data.accounts.find((a) => a.id === data.defaultAccountId) || data.accounts[0];
}

const ACCOUNT_FIELDS = ['name', 'xhsId', 'positioning', 'audience', 'style'];

export function saveAccount(input) {
  const data = getAccounts();
  const fields = {};
  for (const k of ACCOUNT_FIELDS) if (typeof input[k] === 'string') fields[k] = input[k].trim();
  if (input.id) {
    const acc = data.accounts.find((a) => a.id === input.id);
    if (!acc) throw httpError(404, '账号不存在');
    Object.assign(acc, fields, { updatedAt: new Date().toISOString() });
    writeJson(P.accounts, data);
    return acc;
  }
  if (!fields.name) throw httpError(400, '账号名称不能为空');
  const acc = { ...blankAccount(newId('acc_'), fields.name), ...fields };
  data.accounts.push(acc);
  writeJson(P.accounts, data);
  ensureAccountDirs(acc.id);
  return acc;
}

export function setDefaultAccount(id) {
  const data = getAccounts();
  if (!data.accounts.some((a) => a.id === id)) throw httpError(404, '账号不存在');
  data.defaultAccountId = id;
  writeJson(P.accounts, data);
}

// ---------- 知识库（Markdown + 简易 frontmatter） ----------

export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^\[.*\]$/.test(v)) {
      v = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      v = v.replace(/^["']|["']$/g, '');
    }
    meta[kv[1]] = v;
  }
  return { meta, body: text.slice(m[0].length) };
}

function docInfo(abs) {
  const rel = path.relative(P.knowledge, abs).split(path.sep).join('/');
  const text = fs.readFileSync(abs, 'utf8');
  const { meta, body } = parseFrontmatter(text);
  const heading = /^#\s+(.+)$/m.exec(body);
  const stat = fs.statSync(abs);
  return {
    path: rel,
    folder: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
    title: meta.title || (heading && heading[1].trim()) || path.basename(rel, '.md'),
    tags: Array.isArray(meta.tags) ? meta.tags : meta.tags ? String(meta.tags).split(/[,，]/).map((s) => s.trim()) : [],
    account: meta.account || '',
    size: stat.size,
    updatedAt: stat.mtime.toISOString(),
    _text: text,
  };
}

function walkMarkdown(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(abs, out);
    else if (entry.name.toLowerCase().endsWith('.md')) out.push(abs);
  }
  return out;
}

export function listKnowledge() {
  const docs = walkMarkdown(P.knowledge).map(docInfo).map(({ _text, ...d }) => d);
  const folders = new Set();
  const collect = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.')) {
        const abs = path.join(dir, e.name);
        folders.add(path.relative(P.knowledge, abs).split(path.sep).join('/'));
        collect(abs);
      }
    }
  };
  collect(P.knowledge);
  docs.sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'));
  return { docs, folders: [...folders].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')) };
}

function knowledgeFile(rel) {
  if (!rel || !rel.toLowerCase().endsWith('.md')) throw httpError(400, '只支持 .md 文件');
  return safeJoin(P.knowledge, rel);
}

export function readKnowledge(rel) {
  const abs = knowledgeFile(rel);
  if (!fs.existsSync(abs)) throw httpError(404, '文档不存在');
  const { _text, ...info } = docInfo(abs);
  return { ...info, content: _text };
}

export function writeKnowledge(rel, content) {
  const abs = knowledgeFile(rel);
  ensureDir(path.dirname(abs));
  fs.writeFileSync(abs, content ?? '');
  return readKnowledge(rel);
}

export function trashKnowledge(rel) {
  const abs = knowledgeFile(rel);
  if (!fs.existsSync(abs)) throw httpError(404, '文档不存在');
  return moveToTrash(abs, 'knowledge', { label: `知识库：${rel}` });
}

/** 知识库检索（BM25，见 search.mjs）；返回的 snippet 里用 \u0001 / \u0002 标出命中位置 */
export function searchKnowledge(q, limit = 20) {
  const all = walkMarkdown(P.knowledge).map(docInfo);
  const byPath = new Map(all.map((d) => [d.path, d]));
  const docs = all.map((d) => ({ id: d.path, title: d.title, tags: d.tags, body: parseFrontmatter(d._text).body }));
  return search(docs, q, limit).map((r) => {
    const { _text, ...info } = byPath.get(r.id);
    return { ...info, score: Math.round(r.score * 100) / 100, snippet: r.snippet };
  });
}

// ---------- 对话记录 ----------

function chatFile(id) {
  if (!/^[\w-]+$/.test(id)) throw httpError(400, '会话 id 不合法');
  return path.join(P.chats, `${id}.json`);
}

export function listChats() {
  if (!fs.existsSync(P.chats)) return [];
  return fs
    .readdirSync(P.chats)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(P.chats, f), null))
    .filter(Boolean)
    .map(({ messages, ...s }) => ({ ...s, messageCount: messages.length }))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export function loadChat(id) {
  return readJson(chatFile(id), null);
}

export function saveChat(session) {
  session.updatedAt = new Date().toISOString();
  writeJson(chatFile(session.id), session);
}

export function trashChat(id) {
  const file = chatFile(id);
  if (fs.existsSync(file)) moveToTrash(file, 'chats', { label: `对话：${readJson(file, {}).title || id}` });
}

// ---------- 配置 ----------

export function getBridgeConfig() {
  return readJson(P.bridge, null);
}

export function saveBridgeConfig(cfg) {
  writeJson(P.bridge, cfg);
}
