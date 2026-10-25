// 素材库：用户剪辑的参考素材（视频片段 / 图片截图 / 文案稿字幕），供 agent 学习模仿。
// 每条素材一张卡片：文件 + 标签 + 批注（为什么好、学什么）。规律由知识库管家提炼进知识库。
import fs from 'node:fs';
import path from 'node:path';
import { accRoot, cleanUploadName, uniqueName, IMAGE_EXTS } from './content.mjs';
import { readJson, writeJson, ensureDir, httpError, moveToTrash, safeJoin } from './store.mjs';

const now = () => new Date().toISOString();

export const MATERIAL_EXTS = ['.mp4', '.mov', '.webm', ...IMAGE_EXTS, '.heic', '.srt', '.txt', '.md'];
const MATERIAL_FILE_FIELDS = ['title', 'tags', 'note', 'source', 'type'];
export const MATERIAL_TYPES = ['video', 'image', 'script'];

function libraryDir() {
  return path.join(accRoot('default'), 'materials');
}
function indexFile() {
  return path.join(libraryDir(), 'index.json');
}

function detectType(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (['.mp4', '.mov', '.webm'].includes(ext)) return 'video';
  if (['.srt', '.txt', '.md'].includes(ext)) return 'script';
  return 'image';
}

function normalize(item) {
  return {
    id: item.id,
    title: item.title || '',
    type: MATERIAL_TYPES.includes(item.type) ? item.type : 'image',
    file: item.file || '',
    tags: Array.isArray(item.tags) ? item.tags : [],
    note: item.note || '',
    source: item.source || '',
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function readIndex() {
  const data = readJson(indexFile(), { items: [] });
  const items = Array.isArray(data.items) ? data.items : [];
  // 文件被手动删掉的条目自动去掉
  const alive = items.filter((it) => it.file && fs.existsSync(path.join(libraryDir(), 'files', it.file)));
  if (alive.length !== items.length) writeJson(indexFile(), { items: alive });
  return alive;
}

export function listMaterials() {
  return readIndex().map(normalize);
}

export function saveMaterial(input) {
  const items = readIndex();
  let item;
  if (input.id) {
    item = items.find((x) => x.id === input.id);
    if (!item) throw httpError(404, '素材不存在');
    for (const k of MATERIAL_FILE_FIELDS) if (k in input && input[k] !== undefined) item[k] = input[k];
    if (input.tags !== undefined) item.tags = Array.isArray(input.tags) ? input.tags : String(input.tags || '').split(/[,，\s]+/).filter(Boolean);
    item.updatedAt = now();
  } else {
    const title = String(input.title || '').trim();
    if (!title) throw httpError(400, '请填写素材标题');
    const type = MATERIAL_TYPES.includes(input.type) ? input.type : detectType(input.file);
    item = {
      id: `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      title,
      type,
      file: String(input.file || ''),
      tags: Array.isArray(input.tags) ? input.tags : String(input.tags || '').split(/[,，\s]+/).filter(Boolean),
      note: String(input.note || ''),
      source: String(input.source || ''),
      createdAt: now(),
      updatedAt: now(),
    };
    if (!item.file) throw httpError(400, '请先上传素材文件');
    items.unshift(item);
  }
  writeJson(indexFile(), { items });
  return normalize(item);
}

/** 上传素材文件（走 base64，剪辑片段一般 < 55MB；更大的建议压缩后再传） */
export function uploadMaterial(filename, dataBase64) {
  const { base, ext } = cleanUploadName(filename, MATERIAL_EXTS, 'material');
  const name = uniqueName(path.join(libraryDir(), 'files'), base, ext);
  // saveUpload 校验扩展名 + 解 base64；这里直接复用它的解析
  const buf = Buffer.from(String(dataBase64 || '').replace(/^data:[^,]+,/, ''), 'base64');
  if (!buf.length) throw httpError(400, '文件为空');
  ensureDir(path.join(libraryDir(), 'files'));
  fs.writeFileSync(path.join(libraryDir(), 'files', name), buf);
  return name;
}

export function deleteMaterial(id) {
  const items = readIndex();
  const idx = items.findIndex((x) => x.id === id);
  if (idx < 0) throw httpError(404, '素材不存在');
  const [removed] = items.splice(idx, 1);
  // 只移走这一个素材的文件：文件名必须是单个文件名，空名字时不能落到 files 目录本身
  const file = typeof removed.file === 'string' && removed.file && path.basename(removed.file) === removed.file
    ? safeJoin(libraryDir(), path.join('files', removed.file)) : null;
  if (file && fs.existsSync(file) && fs.lstatSync(file).isFile()) moveToTrash(file, 'materials', { label: `素材：${removed.title || removed.file}` });
  writeJson(indexFile(), { items });
  return removed;
}

/** 素材库给 agent 的摘要：写进提示词的「素材库」段（只含卡片信息，不含文件本体） */
export function materialsSummary() {
  const items = listMaterials();
  if (!items.length) return '';
  return items
    .map((m) => `- [${m.type === 'video' ? '视频' : m.type === 'script' ? '文稿' : '图片'}] ${m.title}${m.tags.length ? `（标签：${m.tags.join('、')}）` : ''}${m.note ? `：${m.note}` : ''}`)
    .join('\n');
}
