// Agent 桥接层
// - CLI 模式：本地服务直接以 headless 方式调用 agent 命令行，流式读取输出
// - 收件箱模式：任务进入队列，由 agent 在自己的会话里轮询领取、回写结果
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SKILL_DIR, WORKSPACE } from './paths.mjs';
import { getBridgeConfig } from './store.mjs';
import { mcpConfigFor } from './browser.mjs';

const IS_WIN = process.platform === 'win32';
const INBOX_ONLINE_MS = 45_000;

// ---------- 命令探测 ----------

const EXTRA_BIN_DIRS = [
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), '.npm-global', 'bin'),
  path.join(os.homedir(), '.bun', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
];

export function which(bin) {
  const res = IS_WIN
    ? spawnSync('where', [bin], { encoding: 'utf8' })
    : spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  const found = res.status === 0 && res.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  if (found) return found;
  if (!IS_WIN) {
    for (const dir of EXTRA_BIN_DIRS) {
      const p = path.join(dir, bin);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

// ---------- 运行一次 agent CLI ----------

function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

function childEnv() {
  const env = { ...process.env };
  // 从另一个 Claude Code 会话里启动时，需去掉这些变量，否则嵌套调用会被拒绝
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

function winQuote(arg) {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/**
 * 运行一次 agent，返回 { promise, cancel }。
 * promise 结果：{ text, agentSessionId }
 */
export function runCli(adapter, prompt, opts = {}) {
  const { agentSessionId, timeoutMs = 30 * 60_000, onText = () => {}, onTool = () => {}, onSession = () => {} } = opts;
  const vars = { prompt, workspace: WORKSPACE, skillDir: SKILL_DIR, agentSessionId: agentSessionId || '' };
  // 每个账号用自己的浏览器资料（登录状态隔离）
  if ((adapter.args || []).includes('{mcpConfig}')) vars.mcpConfig = mcpConfigFor(opts.accountId, adapter.playwrightMcp);
  let args = (adapter.args || []).map((a) => fill(a, vars));
  if (agentSessionId && adapter.resumeArgs) args = args.concat(adapter.resumeArgs.map((a) => fill(a, vars)));
  const command = adapter.command || adapter.bins[0];

  const useShell = IS_WIN && !/\.exe$/i.test(command);
  const child = spawn(useShell ? winQuote(command) : command, useShell ? args.map(winQuote) : args, {
    cwd: WORKSPACE,
    env: childEnv(),
    shell: useShell,
    detached: !IS_WIN, // 独立进程组，取消时能连同子进程一起结束
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let text = '';
  let stderr = '';
  let sessionId = agentSessionId || null;
  let cancelled = false;
  let timedOut = false;

  const emitText = (t) => {
    if (!t) return;
    text += t;
    onText(t);
  };

  // Claude Code stream-json：每行一个 JSON 事件
  let lineBuf = '';
  let resultText = null;
  let resultError = null;
  const handleClaudeLine = (line) => {
    if (!line.trim()) return;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.session_id && ev.session_id !== sessionId) {
      sessionId = ev.session_id;
      onSession(sessionId);
    }
    if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const block of ev.message.content) {
        if (block.type === 'text' && block.text) emitText((text ? '\n\n' : '') + block.text);
        if (block.type === 'tool_use') onTool(block.name, summarizeToolInput(block.input));
      }
    }
    if (ev.type === 'result') {
      resultText = typeof ev.result === 'string' ? ev.result : null;
      if (ev.is_error) resultError = resultText || ev.subtype || 'agent 返回错误';
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (adapter.parser === 'claude-stream-json') {
      lineBuf += chunk;
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop();
      lines.forEach(handleClaudeLine);
    } else {
      emitText(chunk);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });

  if (adapter.promptVia === 'stdin') child.stdin.write(prompt);
  child.stdin.end();

  const kill = () => {
    try {
      if (!IS_WIN && child.pid) process.kill(-child.pid, 'SIGTERM');
      else if (IS_WIN && child.pid)
        // .cmd shim 的外壳是 cmd.exe，直接 kill 只杀外壳，真正的 node 子进程会残留；taskkill /T 连整棵树一起结束
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else child.kill();
    } catch {
      /* 进程已结束 */
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);

  const promise = new Promise((resolve, reject) => {
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`无法启动 ${command}：${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (lineBuf) handleClaudeLine(lineBuf);
      if (cancelled) return reject(new Error('已取消'));
      if (timedOut) return reject(new Error(`超时（${Math.round(timeoutMs / 1000)} 秒）未完成`));
      if (resultError) return reject(new Error(resultError));
      if (!text && resultText) emitText(resultText);
      if (code !== 0 && !text.trim()) {
        return reject(new Error(`agent 退出码 ${code}${stderr ? `：${stderr.trim().slice(-800)}` : ''}`));
      }
      resolve({ text: text.trim(), agentSessionId: sessionId });
    });
  });

  return {
    promise,
    cancel() {
      cancelled = true;
      kill();
    },
  };
}

function summarizeToolInput(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.file_path || input.path || input.command || input.url || input.pattern || input.query || '';
  return String(v).slice(0, 120);
}

// ---------- 桥接调度 ----------

export class Bridge extends EventEmitter {
  constructor() {
    super();
    this.running = new Map(); // CLI 模式：taskId -> { cancel, accountId }
    this.cliQueue = []; // CLI 模式：同一账号的浏览器资料不能同时被两个任务打开，排队执行
    this.tasks = new Map(); // 收件箱模式：taskId -> task
    this.waiters = [];
    this.lastPoll = 0;
  }

  config() {
    return getBridgeConfig();
  }

  status() {
    const cfg = this.config();
    const inboxTasks = [...this.tasks.values()];
    return {
      configured: !!cfg,
      mode: cfg ? cfg.mode : null,
      adapter: cfg && cfg.adapter ? { id: cfg.adapter.id, name: cfg.adapter.name, command: cfg.adapter.command } : null,
      testedAt: cfg ? cfg.testedAt : null,
      browser: cfg ? cfg.browser || null : null,
      inboxOnline: Date.now() - this.lastPoll < INBOX_ONLINE_MS,
      lastPollAt: this.lastPoll ? new Date(this.lastPoll).toISOString() : null,
      pending: inboxTasks.filter((t) => t.state === 'pending').length + this.cliQueue.length,
      running: this.running.size + inboxTasks.filter((t) => t.state === 'claimed').length,
    };
  }

  /** task: { id, sessionId, prompt, agentSessionId } */
  submit(task) {
    const cfg = this.config();
    if (!cfg) throw new Error('尚未完成连接设置，请让 agent 运行连接自检');
    if (cfg.mode === 'cli') return this.#runCliTask(cfg, task);
    this.#queueInboxTask(task);
  }

  cancel(taskId) {
    const queued = this.cliQueue.findIndex((t) => t.id === taskId);
    if (queued >= 0) {
      this.cliQueue.splice(queued, 1);
      this.emit('error', { taskId, message: '已取消' });
      return true;
    }
    const run = this.running.get(taskId);
    if (run) {
      run.cancel();
      return true;
    }
    const t = this.tasks.get(taskId);
    if (t) {
      this.tasks.delete(taskId);
      this.emit('error', { taskId, message: '已取消' });
      return true;
    }
    return false;
  }

  #accountBusy(accountId) {
    return [...this.running.values()].some((r) => r.accountId === accountId);
  }

  #runCliTask(cfg, task) {
    // 启用了按账号隔离的浏览器时，同一账号的任务排队
    const exclusive = (cfg.adapter.args || []).includes('{mcpConfig}');
    if (exclusive && this.#accountBusy(task.accountId)) {
      this.cliQueue.push(task);
      return;
    }
    this.emit('claimed', { taskId: task.id });
    const run = runCli(cfg.adapter, task.prompt, {
      accountId: task.accountId,
      agentSessionId: task.agentSessionId,
      timeoutMs: cfg.timeoutMs,
      onText: (text) => this.emit('delta', { taskId: task.id, text }),
      onTool: (name, detail) => this.emit('tool', { taskId: task.id, name, detail }),
      onSession: (agentSessionId) => this.emit('session', { taskId: task.id, agentSessionId }),
    });
    this.running.set(task.id, { ...run, accountId: task.accountId });
    run.promise
      .then((res) => this.emit('done', { taskId: task.id, ...res }))
      .catch((err) => this.emit('error', { taskId: task.id, message: err.message }))
      .finally(() => {
        this.running.delete(task.id);
        const i = this.cliQueue.findIndex((t) => !this.#accountBusy(t.accountId));
        if (i >= 0) {
          const [next] = this.cliQueue.splice(i, 1);
          const cur = this.config();
          if (cur && cur.mode === 'cli') this.#runCliTask(cur, next);
          else this.emit('error', { taskId: next.id, message: '连接模式已变更，请重新发送' });
        }
      });
  }

  // ----- 收件箱模式 -----

  #queueInboxTask(task) {
    this.tasks.set(task.id, { ...task, state: 'pending', createdAt: new Date().toISOString() });
    this.#wakeWaiter();
  }

  #takePending() {
    for (const t of this.tasks.values()) {
      if (t.state === 'pending') {
        t.state = 'claimed';
        t.claimedAt = new Date().toISOString();
        this.emit('claimed', { taskId: t.id });
        return { id: t.id, sessionId: t.sessionId, prompt: t.prompt, createdAt: t.createdAt };
      }
    }
    return null;
  }

  #wakeWaiter() {
    while (this.waiters.length) {
      const w = this.waiters.shift();
      const task = this.#takePending();
      w(task);
      if (!task) break;
    }
  }

  /** agent 长轮询领取任务；超时返回 null */
  next(waitMs) {
    this.lastPoll = Date.now();
    const task = this.#takePending();
    if (task || waitMs <= 0) return Promise.resolve(task);
    return new Promise((resolve) => {
      const waiter = (t) => {
        clearTimeout(timer);
        this.lastPoll = Date.now();
        resolve(t);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        this.lastPoll = Date.now();
        resolve(null);
      }, waitMs);
      this.waiters.push(waiter);
    });
  }

  requeue(taskId) {
    const t = this.tasks.get(taskId);
    if (t) t.state = 'pending';
  }

  /** agent 回写：final=false 为进度（显示为进度行），final=true 为最终回复 */
  reply(taskId, { text = '', final = false, error = '' }) {
    this.lastPoll = Date.now();
    const t = this.tasks.get(taskId);
    if (!t) return false;
    if (error) {
      this.tasks.delete(taskId);
      this.emit('error', { taskId, message: error });
    } else if (final) {
      this.tasks.delete(taskId);
      this.emit('done', { taskId, text });
    } else if (text) {
      this.emit('tool', { taskId, name: '进度', detail: text.slice(0, 200) });
    }
    return true;
  }
}

// ---------- 连接自检 ----------

export const PING_PROMPT = '【连接测试】这是小红书运营工作台的连接测试。请只回复四个大写字母 PONG，不要做任何其他事情。';

/** 列出本机已安装的 agent CLI（带绝对路径） */
export function detectAdapters(adapters) {
  const found = [];
  for (const a of adapters) {
    for (const bin of a.bins) {
      const command = which(bin);
      if (command) {
        found.push({ ...a, command });
        break;
      }
    }
  }
  return found;
}

/** 用真实调用链路跑回声测试；模型偶尔不按要求回复，失败时再试一次 */
export async function pingAdapter(adapter, timeoutMs = 180_000, attempts = 2) {
  const started = Date.now();
  let last = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const { text } = await runCli(adapter, PING_PROMPT, { timeoutMs }).promise;
      const ok = /PONG/i.test(text);
      last = { ok, ms: Date.now() - started, output: text.slice(0, 300), error: ok ? null : `回复中没有 PONG（实际回复：${text.slice(0, 120) || '空'}）` };
    } catch (err) {
      last = { ok: false, ms: Date.now() - started, output: '', error: err.message };
    }
    if (last.ok) return last;
  }
  return last;
}
