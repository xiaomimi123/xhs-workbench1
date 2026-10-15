#!/usr/bin/env node
// 小红书运营工作台 · 统一命令入口（给 agent 调用）
//
//   node scripts/workbench.mjs setup                         初始化数据目录
//   node scripts/workbench.mjs bridge-test [--prefer <id>] [--only <id>] [--all] [--inbox]
//                                                            探测本机 agent 并跑连接测试，写入配置
//   node scripts/workbench.mjs start [--open]                启动工作台（已运行则复用）
//   node scripts/workbench.mjs open                          在浏览器打开工作台
//   node scripts/workbench.mjs status                        查看运行与连接状态
//   node scripts/workbench.mjs stop                          停止工作台
//   node scripts/workbench.mjs browser-setup [--engine playwright|chrome] [--yes]
//                                                            让 CLI 模式的 agent 能控制浏览器（自动发布 / 抓评论 / 抓数据需要）
//   node scripts/workbench.mjs lint --account <账号id> --note <笔记id>
//                                                            检查笔记字数与违禁词
//   node scripts/workbench.mjs inbox-next [--wait 110]       收件箱模式：领取下一条任务
//   node scripts/workbench.mjs inbox-reply <taskId> [--final] [--error <msg>] [--file <path>]
//                                                            收件箱模式：回写结果（正文从 --file 或标准输入读取）
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { P, SKILL_DIR, WORKSPACE } from '../server/paths.mjs';
import { ensureWorkspace, readJson, saveBridgeConfig, getBridgeConfig } from '../server/store.mjs';
import { ADAPTERS } from '../server/adapters.mjs';
import { detectAdapters, pingAdapter } from '../server/bridge.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);

function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

function fail(msg) {
  console.error(`错误：${msg}`);
  process.exit(1);
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) fail(`需要 Node.js 18 或更高版本，当前是 ${process.versions.node}`);
}

// ---------- 服务状态 ----------

function serverInfo() {
  return readJson(P.serverInfo, null);
}

function token() {
  try {
    return fs.readFileSync(P.token, 'utf8').trim();
  } catch {
    return '';
  }
}

async function health(info) {
  if (!info) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/api/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok && (await res.json()).name === 'xhs-workbench';
  } catch {
    return false;
  }
}

async function api(method, pathname, body, timeoutMs = 15_000) {
  const info = serverInfo();
  if (!(await health(info))) fail('工作台未运行，请先执行 start');
  const res = await fetch(`http://127.0.0.1:${info.port}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': token() },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(data.error || `HTTP ${res.status}`);
  return data;
}

function openBrowser(url) {
  const [bin, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  spawn(bin, args, { detached: true, stdio: 'ignore' }).unref();
}

// ---------- 命令 ----------

const commands = {
  async setup() {
    checkNode();
    ensureWorkspace();
    console.log(`数据目录已就绪：${WORKSPACE}`);
    console.log(`技能包目录：${SKILL_DIR}`);
    console.log(`Node.js 版本：${process.versions.node}`);
    console.log(getBridgeConfig() ? '连接配置：已存在（可直接 start）' : '连接配置：尚未配置，下一步运行 bridge-test');
  },

  async 'bridge-test'() {
    checkNode();
    ensureWorkspace();
    if (flags.inbox) {
      saveBridgeConfig({ ...(getBridgeConfig() || {}), mode: 'inbox', testedAt: new Date().toISOString() });
      console.log('已设置为收件箱模式。');
      console.log('RESULT: inbox');
      return;
    }

    let candidates = detectAdapters(ADAPTERS);
    console.log(`本机检测到的 agent 命令行：${candidates.map((a) => `${a.name}(${a.command})`).join('，') || '无'}`);
    if (flags.only) candidates = candidates.filter((a) => a.id === flags.only);
    if (flags.prefer) candidates.sort((a, b) => (b.id === flags.prefer) - (a.id === flags.prefer));

    const results = [];
    let chosen = null;
    for (const adapter of candidates) {
      process.stdout.write(`测试 ${adapter.name} … `);
      const r = await pingAdapter(adapter);
      results.push({ id: adapter.id, command: adapter.command, ok: r.ok, ms: r.ms, error: r.error });
      console.log(r.ok ? `通过（${(r.ms / 1000).toFixed(1)} 秒）` : `失败：${r.error}`);
      if (r.ok && !chosen) {
        chosen = adapter;
        if (!flags.all) break;
      }
    }

    const prev = getBridgeConfig() || {};
    if (chosen) {
      saveBridgeConfig({ ...prev, mode: 'cli', adapter: chosen, testedAt: new Date().toISOString(), results });
      console.log(`\n已选用 CLI 模式：${chosen.name}`);
      console.log(`RESULT: cli ${chosen.id}`);
    } else {
      saveBridgeConfig({ ...prev, mode: 'inbox', testedAt: new Date().toISOString(), results });
      console.log('\n没有可用的 agent 命令行，已设置为收件箱模式（需要 agent 在会话中值守）。');
      console.log('RESULT: inbox');
    }
  },

  async start() {
    checkNode();
    ensureWorkspace();
    let info = serverInfo();
    if (!(await health(info))) {
      const logFile = path.join(P.logs, 'server.log');
      const out = fs.openSync(logFile, 'a');
      const child = spawn(process.execPath, [path.join(SKILL_DIR, 'server', 'server.mjs')], {
        cwd: WORKSPACE,
        detached: true,
        stdio: ['ignore', out, out],
        env: process.env,
      });
      child.unref();
      const deadline = Date.now() + 15_000;
      info = null;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 300));
        const cur = serverInfo();
        if (cur && cur.pid === child.pid && (await health(cur))) {
          info = cur;
          break;
        }
      }
      if (!info) fail(`工作台启动失败，请查看日志：${logFile}`);
      console.log('工作台已启动。');
    } else {
      console.log('工作台已在运行。');
    }
    const url = `${info.url}?t=${token()}`;
    console.log(`URL: ${url}`);
    if (!getBridgeConfig()) console.log('提示：尚未配置 agent 连接，请先运行 bridge-test。');
    if (flags.open) openBrowser(url);
  },

  async open() {
    const info = serverInfo();
    if (!(await health(info))) fail('工作台未运行，请先执行 start --open');
    const url = `${info.url}?t=${token()}`;
    openBrowser(url);
    console.log(`URL: ${url}`);
  },

  async status() {
    const info = serverInfo();
    const alive = await health(info);
    console.log(`数据目录：${WORKSPACE}`);
    console.log(`工作台：${alive ? `运行中 ${info.url}（pid ${info.pid}）` : '未运行'}`);
    const cfg = getBridgeConfig();
    if (!cfg) console.log('连接：未配置');
    else if (cfg.mode === 'cli') console.log(`连接：CLI 模式 · ${cfg.adapter.name}（${cfg.adapter.command}）`);
    else console.log('连接：收件箱模式');
    if (alive) {
      const { status } = await api('GET', '/api/bridge');
      if (status.mode === 'inbox') console.log(`值守 agent：${status.inboxOnline ? '在线' : '离线'}，待领取任务 ${status.pending} 条`);
    }
  },

  async stop() {
    const info = serverInfo();
    if (!(await health(info))) return console.log('工作台未运行。');
    try {
      process.kill(info.pid, 'SIGTERM');
      console.log('工作台已停止。');
    } catch (err) {
      fail(`停止失败：${err.message}`);
    }
  },

  async 'browser-setup'() {
    const cfg = getBridgeConfig();
    if (!cfg) fail('请先运行 bridge-test 完成连接设置');
    const engine = flags.engine === 'chrome' ? 'chrome' : 'playwright';
    if (cfg.mode !== 'cli' || !cfg.adapter || cfg.adapter.id !== 'claude-code') {
      console.log('当前不是 Claude Code 的 CLI 模式，无法自动配置。');
      console.log('- 收件箱模式：你（agent）在自己的会话里用自带的浏览器 / 电脑控制能力完成任务即可，无需配置。');
      console.log('- 其他 CLI agent：参考 adapters/ 下对应说明，为它接入 Playwright MCP（npx @playwright/mcp）后重新运行 bridge-test。');
      return;
    }

    // 先去掉旧的浏览器配置，再按选择的方式加上
    const args = [...cfg.adapter.args];
    const drop = (flag, withValue) => {
      const i = args.indexOf(flag);
      if (i >= 0) args.splice(i, withValue ? 2 : 1);
    };
    drop('--mcp-config', true);
    drop('--chrome', false);
    let i = args.indexOf('--allowedTools');
    if (i < 0) {
      args.push('--allowedTools', 'WebSearch,WebFetch');
      i = args.indexOf('--allowedTools');
    }
    const tools = args[i + 1].split(',').filter((t) => t && !t.startsWith('mcp__playwright') && !t.startsWith('mcp__claude-in-chrome'));

    const plan = [];
    let mcpFile = null;
    let mcpConfig = null;
    if (engine === 'playwright') {
      const v = spawnSync('npm', ['view', '@playwright/mcp', 'version'], { encoding: 'utf8', shell: process.platform === 'win32' });
      const version = v.status === 0 ? v.stdout.trim() : '';
      if (!/^\d+\.\d+\.\d+/.test(version)) fail('无法查询 @playwright/mcp 版本，请确认已安装 Node.js 并能访问 npm');
      mcpFile = path.join(P.config, 'mcp.json');
      const profile = path.join(WORKSPACE, 'browser-profile');
      // 截图、页面快照等临时文件放进 run/，不要散落在数据目录根部（里面可能有账号数据）
      const outputDir = path.join(P.run, 'browser-output');
      mcpConfig = { mcpServers: { playwright: { command: 'npx', args: ['-y', `@playwright/mcp@${version}`, '--user-data-dir', profile, '--output-dir', outputDir] } } };
      args.push('--mcp-config', mcpFile);
      tools.push('mcp__playwright');
      plan.push(`写入 ${mcpFile}：使用 Playwright MCP ${version}，浏览器资料保存在 ${profile}（独立于你日常的浏览器，第一次需要在它打开的窗口里登录小红书）`);
    } else {
      args.push('--chrome');
      tools.push('mcp__claude-in-chrome');
      plan.push('启用 Claude in Chrome：直接使用你日常 Chrome 里的登录状态（需要已安装 Claude 浏览器扩展）');
    }
    args[args.indexOf('--allowedTools') + 1] = tools.join(',');
    plan.push(`允许 agent 在无界面模式下使用浏览器工具（${tools.join(', ')}）`);

    console.log('将进行以下修改：');
    plan.forEach((p) => console.log(`- ${p}`));
    if (!flags.yes) {
      console.log('\n这会让工作台调用的 agent 无需逐次确认就能操作浏览器。请先向用户说明并征得同意，然后加 --yes 重新运行。');
      return;
    }
    if (mcpFile) fs.writeFileSync(mcpFile, JSON.stringify(mcpConfig, null, 2));
    const adapter = { ...cfg.adapter, args };
    process.stdout.write('测试连接 … ');
    const r = await pingAdapter(adapter, 300_000);
    if (!r.ok) {
      console.log(`失败：${r.error}`);
      fail('浏览器配置未生效，原配置保持不变');
    }
    saveBridgeConfig({ ...cfg, adapter, browser: engine, testedAt: new Date().toISOString() });
    console.log(`通过（${(r.ms / 1000).toFixed(1)} 秒）`);
    console.log(`RESULT: browser ${engine}`);
  },

  async lint() {
    if (typeof flags.account !== 'string' || typeof flags.note !== 'string') fail('用法：lint --account <账号id> --note <笔记id>');
    const { noteDetail } = await import('../server/content.mjs');
    const { lint } = await import('../web/lint.js');
    const n = noteDetail(flags.account, flags.note);
    const { issues, titleLen, bodyLen } = lint({ title: n.title || '', body: n.content || '', tags: n.tags || [] });
    console.log(`标题 ${titleLen} 字，正文 ${bodyLen} 字，话题 ${(n.tags || []).length} 个`);
    if (!issues.length) return console.log('未发现问题。');
    for (const i of issues) console.log(`[${i.level === 'error' ? '必须修改' : '建议修改'}] ${i.where}${i.word ? ` 「${i.word}」(${i.category})` : ''}：${i.tip}`);
  },

  async 'inbox-next'() {
    const wait = Number(flags.wait) || 110;
    const { task } = await api('GET', `/api/agent/next?wait=${wait}`, null, (wait + 15) * 1000);
    if (!task) {
      console.log('NO_TASK');
      return;
    }
    console.log(`TASK_ID: ${task.id}`);
    console.log('----- 任务内容开始 -----');
    console.log(task.prompt);
    console.log('----- 任务内容结束 -----');
    console.log(`完成后执行：node "${path.join(SKILL_DIR, 'scripts', 'workbench.mjs')}" inbox-reply ${task.id} --final  （回复正文从标准输入或 --file 传入）`);
  },

  async 'inbox-reply'() {
    const taskId = flags._[0];
    if (!taskId) fail('缺少 taskId');
    let text = '';
    if (typeof flags.file === 'string') text = fs.readFileSync(flags.file, 'utf8');
    else if (!process.stdin.isTTY) text = fs.readFileSync(0, 'utf8');
    text = text.trim();
    const error = typeof flags.error === 'string' ? flags.error : '';
    if (!text && !error && !flags.final) fail('回复内容为空');
    await api('POST', '/api/agent/reply', { taskId, text, final: !!flags.final, error });
    console.log(flags.final || error ? '已回写，任务结束。' : '已回写进度。');
  },
};

if (!commands[cmd]) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n').replace(/^\/\/ ?/gm, ''));
  process.exit(cmd ? 1 : 0);
}
await commands[cmd]();
