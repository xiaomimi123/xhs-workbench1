#!/usr/bin/env node
// 打包技能包：node tools/package.mjs [--allow-dirty]
// 用 git archive 从已提交的内容生成 dist/xhs-workbench-v<版本>.zip，保证包里只有仓库里的文件。
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = 'xhs-workbench';
const allowDirty = process.argv.includes('--allow-dirty');

function fail(msg) {
  console.error(`打包失败：${msg}`);
  process.exit(1);
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

// 1. 版本号：以 server.mjs 中的 VERSION 为准，并要求 CHANGELOG 有对应条目
const serverSrc = fs.readFileSync(path.join(ROOT, SKILL, 'server', 'server.mjs'), 'utf8');
const version = (/export const VERSION = '([\d.]+)'/.exec(serverSrc) || [])[1];
if (!version) fail('在 server/server.mjs 中找不到 VERSION');
const changelog = fs.readFileSync(path.join(ROOT, SKILL, 'CHANGELOG.md'), 'utf8');
if (!changelog.includes(`## v${version}`)) fail(`CHANGELOG.md 里没有 v${version} 的条目`);

// 2. 技能包目录必须已全部提交（包是从 git 生成的，未提交的修改不会进包）
const dirty = git('status', '--porcelain', '--', SKILL);
if (dirty && !allowDirty) fail(`${SKILL}/ 有未提交的修改，请先提交：\n${dirty}`);

// 3. 包内路径只允许 ASCII：部分解压工具（如 macOS 自带的 unzip）会把中文文件名弄乱
const nonAscii = git('-c', 'core.quotepath=false', 'ls-files', '--', SKILL).split('\n').filter((f) => /[^\x20-\x7e]/.test(f));
if (nonAscii.length) fail(`以下文件名含非 ASCII 字符，请改名（中文名可通过 manifest 映射）：\n${nonAscii.join('\n')}`);

// 4. 所有脚本语法检查
const jsFiles = git('ls-files', '--', `${SKILL}/*.js`, `${SKILL}/*.mjs`).split('\n').filter(Boolean);
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' });
  } catch (err) {
    fail(`${f} 语法错误：\n${err.stderr}`);
  }
}

// 5. 生成 zip
const dist = path.join(ROOT, 'dist');
fs.mkdirSync(dist, { recursive: true });
const out = path.join(dist, `${SKILL}-v${version}.zip`);
git('archive', '--format=zip', `--prefix=${SKILL}/`, '-o', out, `HEAD:${SKILL}`);

const buf = fs.readFileSync(out);
const sha = crypto.createHash('sha256').update(buf).digest('hex');
const files = git('ls-tree', '-r', '--name-only', `HEAD:${SKILL}`).split('\n').filter(Boolean).length;
console.log(`已生成：${path.relative(ROOT, out)}`);
console.log(`版本 v${version} · ${files} 个文件 · ${(buf.length / 1024).toFixed(0)} KB`);
console.log(`SHA-256：${sha}`);
if (dirty) console.log('注意：使用了 --allow-dirty，未提交的修改不在包内。');
