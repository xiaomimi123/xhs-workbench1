// 企业中枢（enterprise-hub）接入：由中枢的本机接入器启动工作台时，通过环境变量 HUB_MCP_SERVERS_FILE
// 指向一个 {"mcpServers": {...}} 文件，工作台把里面的 MCP 服务并入底层 agent 的配置，
// 这样工作台里的 agent 能用公司知识库、岗位技能和 GPU 出图出视频（权限、额度、审计都在中枢侧强制执行）。
// 约定见中枢仓库 docs/superpowers/specs/2026-10-19-app-launcher-design.md 第 4.5 节。
//
// 原则：没有这个环境变量、文件不存在或内容不合法时，一切照旧，绝不因此报错或影响工作台本身。
import fs from 'node:fs';
import path from 'node:path';

export const HUB_ENV = 'HUB_MCP_SERVERS_FILE';
const MAX_BYTES = 64 * 1024;
const MAX_SERVERS = 8;
const RESERVED = new Set(['playwright']); // 工作台自己的浏览器控制，中枢不能覆盖

const isStringMap = (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');

/** 只保留已知字段并校验类型；不合法返回 null */
export function sanitizeServer(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const out = {};
  if (typeof entry.command === 'string' && entry.command.trim()) {
    out.command = entry.command;
    if (entry.args !== undefined) {
      if (!Array.isArray(entry.args) || !entry.args.every((a) => typeof a === 'string')) return null;
      out.args = entry.args;
    }
    if (entry.env !== undefined) {
      if (!isStringMap(entry.env)) return null;
      out.env = entry.env;
    }
  } else if (typeof entry.url === 'string' && /^https?:\/\//i.test(entry.url)) {
    out.url = entry.url;
    if (typeof entry.type === 'string' && /^[a-z-]{1,20}$/.test(entry.type)) out.type = entry.type;
    if (entry.headers !== undefined) {
      if (!isStringMap(entry.headers)) return null;
      out.headers = entry.headers;
    }
  } else {
    return null;
  }
  return out;
}

/** 读取中枢提供的 MCP 服务；永不抛错。返回 { servers, file, problem } */
export function readHubServers(env = process.env) {
  const file = env[HUB_ENV];
  if (!file) return { servers: {}, file: null, problem: '' };
  try {
    if (!path.isAbsolute(file)) return { servers: {}, file, problem: '中枢配置文件路径必须是绝对路径' };
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) return { servers: {}, file, problem: '中枢配置文件不是普通文件或超过 64KB' };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const raw = parsed && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers) ? parsed.mcpServers : null;
    if (!raw) return { servers: {}, file, problem: '中枢配置文件里没有 mcpServers' };
    const servers = {};
    const skipped = [];
    for (const [name, entry] of Object.entries(raw)) {
      if (!/^[\w-]{1,40}$/.test(name) || RESERVED.has(name) || Object.keys(servers).length >= MAX_SERVERS) { skipped.push(name); continue; }
      const clean = sanitizeServer(entry);
      if (clean) servers[name] = clean; else skipped.push(name);
    }
    return { servers, file, problem: skipped.length ? `已忽略不合法或保留的条目：${skipped.join('、')}` : '' };
  } catch (err) {
    return { servers: {}, file, problem: `读取中枢配置失败：${err.code || err.message}` };
  }
}

/** 并入 mcpServers（已有同名条目，尤其 playwright，不会被覆盖） */
export function mergeHubServers(want, env = process.env) {
  const { servers } = readHubServers(env);
  for (const [name, entry] of Object.entries(servers)) if (!(name in want.mcpServers)) want.mcpServers[name] = entry;
  return want;
}

/**
 * 给 Claude Code 的启动参数加上中枢 MCP：
 *  - 已经带 --mcp-config（浏览器控制）时，中枢服务已由 mcpConfigFor 并进同一个文件，这里只放行它们的工具；
 *  - 没有时，写一个只含中枢服务的配置文件并加上 --mcp-config；
 *  - 带 --strict-mcp-config 的任务（本地描述助手等）是刻意收紧的，绝不加。
 * 返回新的参数数组；没有可加的内容就原样返回。
 */
export function withHubMcp(args, { adapterId, useHub, servers, hubFile }) {
  const names = Object.keys(servers || {});
  if (!useHub || !['claude-code', 'codebuddy'].includes(adapterId) || !names.length || args.includes('--strict-mcp-config')) return args;
  const next = [...args];
  if (!next.includes('--mcp-config')) next.push('--mcp-config', hubFile);
  const tools = names.map((n) => `mcp__${n}`);
  const i = next.indexOf('--allowedTools');
  if (adapterId === 'codebuddy') {
    // CodeBuddy 的 --allowedTools 是多值参数（每个工具单独一项，逗号拼成一项不生效）；-p 非交互模式下白名单外的工具直接被拒，
    // 中枢的知识库、技能、出图出视频工具不在白名单里就一个都用不了（员工电脑上踩过）
    if (i < 0) return [...next, '--allowedTools', ...tools];
    let j = i + 1;
    while (j < next.length && !String(next[j]).startsWith('-')) j++;
    const have = next.slice(i + 1, j);
    next.splice(j, 0, ...tools.filter((t) => !have.includes(t)));
    return next;
  }
  if (i >= 0) {
    const have = String(next[i + 1] || '').split(',').filter(Boolean);
    next[i + 1] = [...have, ...tools.filter((t) => !have.includes(t))].join(',');
  } else {
    next.push('--allowedTools', tools.join(','));
  }
  return next;
}

/** 只含中枢服务的配置文件（内容没变就不重写） */
export function writeHubConfig(dir, servers) {
  const file = path.join(dir, 'hub.json');
  const want = JSON.stringify({ mcpServers: servers }, null, 2);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== want) fs.writeFileSync(file, want);
  return file;
}
