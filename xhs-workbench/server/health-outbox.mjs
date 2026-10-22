// 应用健康：工作台把运行中的错误写到企业中枢接入器指定的本机文件（HUB_HEALTH_OUTBOX，一行一条 JSON），
// 接入器去隐私后转发到中枢的「应用健康」页，管理员按版本 / 系统 / agent 看常见报错。
// 没接中枢（没有这个变量）或员工设置 HUB_HEALTH=off 时什么都不做；任何写入错误都不影响工作台。
// 只写错误码、去隐私后的报错原文和环境信息，不写提示词、对话、正文、账号资料。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VERSION } from './version.mjs';

const DEDUPE_MS = 10 * 60_000; // 同一个错误 10 分钟内只记一次
const seen = new Map();

const RULES = [
  [/自动访问已锁定/, 'ACCESS_LOCKED'],
  [/blocked for security|Command blocked/i, 'CMD_BLOCKED'],
  [/未登录|not logged in|login required|please log ?in|请先登录|\/login\b/i, 'CLI_NOT_LOGGED_IN'],
  [/ENOENT|command not found|不是内部或外部命令|is not recognized|本机未检测到|没有找到命令行/i, 'CLI_MISSING'],
  [/EADDRINUSE|address already in use/i, 'PORT_IN_USE'],
  [/EPERM|EACCES|Access is denied|拒绝访问|Permission denied/i, 'FILE_BLOCKED'],
];

export function classify(message, fallback = 'UNKNOWN') {
  for (const [rx, code] of RULES) if (rx.test(message || '')) return code;
  return fallback;
}

const REDACT = [
  [/\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"']+/g, '~'],
  [/\/(?:Users|home)\/[^/\s"']+/g, '~'],
  [/\b(bearer|token|password|passwd|pwd|secret|api[_-]?key|access_token|refresh_token)\b(\s*[:=]\s*|\s+)\S+/gi, '$1$2***'],
  [/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]*/g, '***'],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***'],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '***@***'],
  [/(?<!\d)1[3-9]\d{9}(?!\d)/g, '1**********'],
  [/(https?:\/\/[^\s?#"']+)[?#][^\s"']*/g, '$1'],
];

export function redact(text) {
  let s = String(text || '');
  for (const [rx, rep] of REDACT) s = s.replace(rx, rep);
  return s.trim().slice(0, 300);
}

function osInfo() {
  // 与接入器（Python platform）的写法对齐，控制台按设备聚合时不会把同一台电脑拆成两种系统
  if (process.platform === 'win32') return { os: `Windows ${os.release().split('.')[0]}`, arch: os.arch() === 'x64' ? 'amd64' : os.arch() };
  if (process.platform === 'darwin') return { os: 'macOS', arch: os.arch() === 'x64' ? 'x86_64' : os.arch() };
  return { os: os.type(), arch: os.arch() === 'x64' ? 'x86_64' : os.arch() };
}

/**
 * 记一条应用健康事件。stage：doctor（连接测试）/ task（运行任务）/ runtime。成功只在需要算成功率的地方记（连接测试）。
 * 返回是否写下。
 */
export function reportHealth({ stage, ok, code = '', message = '', agent = '' }, { env = process.env, now = Date.now() } = {}) {
  const file = env.HUB_HEALTH_OUTBOX;
  if (!file || /^(off|0|no)$/i.test(env.HUB_HEALTH || '')) return false;
  const msg = ok ? '' : redact(message);
  const c = ok ? 'OK' : (code || classify(msg));
  if (!ok) {
    const key = `${stage}|${c}|${msg.slice(0, 80)}`;
    const last = seen.get(key);
    if (last && now - last < DEDUPE_MS) return false;
    seen.set(key, now);
  }
  const ev = {
    at: new Date(now).toISOString(), stage, ok: !!ok, code: c, message: msg, app_id: 'xhs-workbench', app_version: VERSION,
    device_id: env.HUB_DEVICE_ID || '', agent: String(agent || '').slice(0, 40), ...osInfo(), os_version: os.release(), connector_version: '',
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(ev) + '\n');
    return true;
  } catch {
    return false;
  }
}
