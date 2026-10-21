// 企业中枢的能力预检结果：中枢接入器在打开本应用前检查 app.json 里声明的依赖（命令行 agent、中枢模型、浏览器等），
// 把结果写进文件并用环境变量 HUB_CAPABILITIES_FILE 交给应用。缺能力时只让对应功能（浏览器自动化）不可用，不影响打开和其他功能。
// 每次用到都重新读文件：员工装好依赖后不用重启工作台。没有环境变量 / 文件不存在 / 内容不合法时一切照旧（不拦任何功能）。
import fs from 'node:fs';
import { httpError } from './store.mjs';

export const CAP_ENV = 'HUB_CAPABILITIES_FILE';
const MAX_BYTES = 64 * 1024;

const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const list = (v, max, n) => (Array.isArray(v) ? v.slice(0, max).map((x) => str(x, n)).filter(Boolean) : []);

function cap(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  return { ready: c.ready === true, missing: list(c.missing, 8, 60), fixes: list(c.fixes, 8, 300) };
}

/** 读取并校验能力文件，返回精简后的结构：{ present, problem, checkedAt, browser, agentCli }。 */
export function readHubCapabilities(env = process.env) {
  const file = env[CAP_ENV];
  if (!file) return { present: false, problem: '' };
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_BYTES) return { present: false, problem: '中枢的能力文件过大或不是文件，已忽略' };
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!doc || doc.schema !== 1 || !doc.capabilities || typeof doc.capabilities !== 'object') {
      return { present: false, problem: '中枢的能力文件格式不对，已忽略' };
    }
    return { present: true, problem: '', checkedAt: str(doc.checkedAt, 40), browser: cap(doc.capabilities.browser), agentCli: cap(doc.capabilities.agent_cli) };
  } catch (err) {
    return { present: false, problem: err && err.code === 'ENOENT' ? '' : '中枢的能力文件不是合法 JSON，已忽略' };
  }
}

/** 浏览器自动化被中枢判定为不可用时返回原因，否则返回空串。 */
export function browserBlockedReason(env = process.env) {
  const c = readHubCapabilities(env);
  if (!c.present || !c.browser || c.browser.ready !== false) return '';
  const missing = c.browser.missing.length ? c.browser.missing.join('、') : '必要的能力';
  const fix = c.browser.fixes[0] ? ` 处理方法：${c.browser.fixes[0]}` : '';
  return `浏览器自动化不可用（中枢能力检查）：缺少 ${missing}。${fix} 让 agent 运行 app-doctor 或自行装好后无需重启工作台；写笔记、看数据等不需要浏览器的功能不受影响。`;
}

export function assertBrowserCapability(env = process.env) {
  const why = browserBlockedReason(env);
  if (why) throw httpError(409, why);
}
