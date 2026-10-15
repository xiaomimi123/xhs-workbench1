// 数据层：所有业务数据都是数据目录下的 JSON / Markdown 文件，agent 可以直接读写
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { P, ACCOUNT_SUBDIRS, accountDir } from './paths.mjs';

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

// 把相对路径限制在 base 目录内，防止 ../ 越界
export function safeJoin(base, rel) {
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

// 删除一律移入 .trash，不做永久删除
export function moveToTrash(file, group) {
  const dest = path.join(P.trash, group, `${Date.now()}-${path.basename(file)}`);
  ensureDir(path.dirname(dest));
  fs.renameSync(file, dest);
  return dest;
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
  return moveToTrash(abs, 'knowledge');
}

export function searchKnowledge(q) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const results = [];
  for (const abs of walkMarkdown(P.knowledge)) {
    const { _text, ...info } = docInfo(abs);
    const lower = _text.toLowerCase();
    if (!words.every((w) => lower.includes(w) || info.title.toLowerCase().includes(w))) continue;
    const idx = lower.indexOf(words[0]);
    const start = Math.max(0, idx - 30);
    results.push({ ...info, snippet: _text.slice(start, start + 120).replace(/\s+/g, ' ') });
  }
  return results;
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
  if (fs.existsSync(file)) moveToTrash(file, 'chats');
}

// ---------- 配置 ----------

export function getBridgeConfig() {
  return readJson(P.bridge, null);
}

export function saveBridgeConfig(cfg) {
  writeJson(P.bridge, cfg);
}
