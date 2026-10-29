// 新版本提示与「重启升级」。
// 背景：中枢上发了新版本后，员工电脑上已经在运行的工作台不会自己换版本（接入器为了不打断任务，只下载、不重启），
// 员工刷新网页看到的还是旧进程里的旧界面。这里让工作台自己发现「中枢上有更高版本」，并在没有任务在跑时，
// 由员工点一下完成：停掉自己，再调本机接入器的 open-app（它会下载并启动新版本）。
// 不是由中枢接入器启动的工作台（找不到接入器）只提示，不提供重启。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { locateConnector } from './hub-gen.mjs';
import { sanitizeAgentEnv } from './agent-env.mjs';

export const APP_ID = 'xhs-workbench';
const CHECK_TTL_MS = 10 * 60 * 1000;

/** 点分版本号比较：a>b 返回 1，相等 0，a<b -1；非数字段当 0 */
export function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** 没有任务在跑才允许重启：对话任务（含排队、已领取）。返回 { ok, reason } */
export function restartBlocker(bridgeStatus) {
  if (!bridgeStatus) return { ok: true, reason: '' };
  const n = (bridgeStatus.running || 0) + (bridgeStatus.pending || 0);
  return n > 0 ? { ok: false, reason: `还有 ${n} 个任务在处理或排队，等它们完成后再升级` } : { ok: true, reason: '' };
}

export class UpdateChecker {
  constructor({ hubGen, current, env = process.env, now = () => Date.now() }) {
    this.hubGen = hubGen; this.current = current; this.env = env; this.now = now; this.cache = null;
  }

  /** 查中枢上的最新版本；缓存 10 分钟；中枢连不上或版本较旧的中枢没有这个接口时静默返回 unknown */
  async check({ force = false } = {}) {
    const connector = locateConnector(this.env);
    const base = { current: this.current, latest: null, available: false, canRestart: !!connector, checkedAt: null };
    if (!this.hubGen.available()) return { ...base, canRestart: false, reason: '这个工作台没有接上企业中枢' };
    if (!force && this.cache && this.now() - this.cache.at < CHECK_TTL_MS) return this.cache.value;
    let value;
    try {
      const r = await this.hubGen.request('GET', '/apps');
      const app = (r.apps || []).find((a) => a.id === APP_ID);
      const latest = app ? String(app.version) : null;
      value = { ...base, latest, available: !!latest && compareVersions(latest, this.current) > 0, checkedAt: new Date(this.now()).toISOString() };
    } catch (e) {
      value = { ...base, reason: `没查到新版本：${e.message}` };
    }
    this.cache = { at: this.now(), value };
    return value;
  }
}

/** 拉起「等旧进程退出再 open-app」的独立辅助进程。返回 { ok, error } */
export function spawnRestartHelper({ env = process.env, pid = process.pid, logFile, spawnImpl = spawn } = {}) {
  const connector = locateConnector(env);
  if (!connector) return { ok: false, error: '找不到本机的中枢接入器：请关闭工作台后，双击桌面上的「小红书运营工作台」打开' };
  const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'restart-self.mjs');
  const out = fs.openSync(logFile, 'a');
  const child = spawnImpl(process.execPath, [helper, String(pid), JSON.stringify({ command: connector.command, args: [...connector.pre, connector.script, 'open-app', APP_ID] })], {
    detached: true, windowsHide: true, stdio: ['ignore', out, out], env: sanitizeAgentEnv(env),
  });
  child.unref();
  return { ok: true };
}
