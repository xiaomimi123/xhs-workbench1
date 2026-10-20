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
//   node scripts/workbench.mjs browser-setup [--engine playwright|chrome] [--headless] [--yes]
//                                                            为 CLI agent 配置浏览器控制
//   node scripts/workbench.mjs browser-worker-setup [--yes]  安装可选的后台有头读取组件
//   node scripts/workbench.mjs browser-worker-status        检查后台读取组件
//   node scripts/workbench.mjs autostart on|off|status            登录电脑后自动运行工作台
//   node scripts/workbench.mjs backup                            立即备份数据
//   node scripts/workbench.mjs restore <备份文件> --yes           从备份恢复（当前数据先移入回收站）
//   node scripts/workbench.mjs kb-search "<问题或关键词>"        按相关度检索知识库
//   node scripts/workbench.mjs lint --account <账号id> --note <笔记id>
//                                                            检查笔记字数与违禁词
//   node scripts/workbench.mjs inbox-next [--wait 110]       收件箱模式：领取下一条任务
//   node scripts/workbench.mjs inbox-reply <taskId> [--final] [--error <msg>] [--file <path>]
//                                                            收件箱模式：回写结果（正文从 --file 或标准输入读取）
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { P, SKILL_DIR, WORKSPACE } from '../server/paths.mjs';
import { ensureWorkspace, readJson, writeJson, saveBridgeConfig, getBridgeConfig } from '../server/store.mjs';
import { ADAPTERS } from '../server/adapters.mjs';
import { detectAdapters, pingAdapter } from '../server/bridge.mjs';
import { applyBrowser, migrateLegacyProfile } from '../server/browser.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);
let adapterBrowserChannel = null; // browser-setup 时确定的浏览器 channel（msedge / chrome / chromium）

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
        ? // start 的第一个带引号参数会被当成窗口标题，所以要补一个空标题
          ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  // Windows 上 cmd /c 的整条命令要作为一个带引号的参数传给 shell，否则 URL 里的 & 会截断命令
  spawn(bin, args, { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref();
}

function storeWorkerSetting(enabled) {
  writeJson(P.settings, { ...readJson(P.settings, {}), backgroundBrowser: enabled });
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
      // 之前为同一个 agent 开启过浏览器控制的，保留
      let adapter = chosen;
      if (prev.browser && prev.adapter && prev.adapter.id === chosen.id && (prev.browser === 'chrome' || prev.adapter.playwrightMcp)) {
        adapter = applyBrowser(chosen, prev.browser, prev.adapter.playwrightMcp);
        if (prev.browser === 'playwright') {
          adapter.browserChannel = prev.adapter.browserChannel;
          adapter.headless = !!prev.adapter.headless;
        }
        console.log('已保留之前的浏览器控制设置。');
      }
      saveBridgeConfig({ ...prev, mode: 'cli', adapter, browser: adapter === chosen ? null : prev.browser, testedAt: new Date().toISOString(), results });
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
      else console.log(`进行中任务：${status.running}，待处理任务：${status.pending}`);
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
    if (readJson(P.settings, {}).backgroundBrowser) fail('请先在设置页关闭后台有头读取，再修改 agent 浏览器配置');
    const engine = flags.engine === 'chrome' ? 'chrome' : 'playwright';
    if (cfg.mode !== 'cli' || !cfg.adapter || !['claude-code','codex'].includes(cfg.adapter.id)) {
      console.log('当前不是 Claude Code / Codex 的 CLI 模式，无法自动配置。');
      console.log('- 收件箱模式：你（agent）在自己的会话里用自带的浏览器 / 电脑控制能力完成任务即可，无需配置。');
      console.log('- 其他 CLI agent：参考 adapters/ 下对应说明，为它接入 Playwright MCP（npx @playwright/mcp）后重新运行 bridge-test。');
      return;
    }

    const plan = [];
    let pkg = null;
    if (engine === 'playwright') {
      const v = spawnSync('npm', ['view', '@playwright/mcp', 'version'], { encoding: 'utf8', shell: process.platform === 'win32' });
      const version = v.status === 0 ? v.stdout.trim() : '';
      if (!/^\d+\.\d+\.\d+/.test(version)) fail('无法查询 @playwright/mcp 版本，请确认已安装 Node.js 并能访问 npm');
      pkg = `@playwright/mcp@${version}`;
      // 浏览器选择：--browser msedge|chrome 用系统真实浏览器（仍有平台风控风险），默认自动探测
      const { detectRealBrowser } = await import('../server/browser.mjs');
      const real = flags.browser ? (['msedge', 'chrome', 'chromium'].includes(flags.browser) ? flags.browser : null) : detectRealBrowser() || 'chromium';
      if (!real) fail('--browser 只支持 msedge / chrome / chromium');
      adapterBrowserChannel = real;
      const nameMap = { msedge: '系统 Microsoft Edge', chrome: '系统 Google Chrome', chromium: 'Playwright 内置浏览器' };
      plan.push(`使用 Playwright MCP ${version}，浏览器：${nameMap[real]}——独立资料目录（${path.join(WORKSPACE, 'browser-profiles', '<账号id>')}），不碰你日常浏览器的登录状态；每个账号第一次使用时需要在打开的窗口里登录`);
      if (flags.headless) plan.push('无头模式：抓取在后台运行，不弹出浏览器窗口（风控更敏感，弹窗异常时改回有头模式）');
    } else {
      plan.push('启用 Claude in Chrome：直接使用你日常 Chrome 里的登录状态（需要已安装 Claude 浏览器扩展）。注意：这种方式所有账号共用一个浏览器，多账号时请用 Playwright');
    }
    const adapter = applyBrowser(cfg.adapter, engine, pkg);
    const tools = adapter.id==='codex'?'Playwright MCP':adapter.args[adapter.args.indexOf('--allowedTools') + 1];
    plan.push(`允许 agent 在无界面模式下使用浏览器工具（${tools.split(',').join(', ')}）`);

    console.log('将进行以下修改：');
    plan.forEach((p) => console.log(`- ${p}`));
    if (!flags.yes) {
      console.log('\n这会让工作台调用的 agent 无需逐次确认就能操作浏览器。请先向用户说明并征得同意，然后加 --yes 重新运行。');
      return;
    }
    if(engine==='playwright'){adapter.headless=!!flags.headless;adapter.browserChannel=adapterBrowserChannel;}
    process.stdout.write('测试连接 … ');
    const r = await pingAdapter(adapter, 300_000);
    if (!r.ok) {
      console.log(`失败：${r.error}`);
      fail('浏览器配置未生效，原配置保持不变');
    }
    if (engine === 'playwright') adapter.headless = !!flags.headless;
    if (adapterBrowserChannel && engine === 'playwright') adapter.browserChannel = adapterBrowserChannel;
    saveBridgeConfig({ ...cfg, adapter, browser: engine, testedAt: new Date().toISOString() });
    const migrated = migrateLegacyProfile();
    if (migrated) console.log(`已把旧的浏览器登录资料迁移到账号 ${migrated} 名下。`);
    console.log(`通过（${(r.ms / 1000).toFixed(1)} 秒）`);
    console.log(`RESULT: browser ${engine}`);
  },

  async 'browser-worker-status'() {
    const { browserRuntimeStatus } = await import('../server/browser-runtime.mjs');
    const runtime = browserRuntimeStatus();
    const enabled = !!readJson(P.settings, {}).backgroundBrowser;
    console.log(`后台有头采集：${enabled ? '已启用' : '未启用'}；Playwright Core ${runtime.version}：${runtime.available ? '已安装' : '未安装'}`);
  },

  async 'browser-worker-setup'() {
    checkNode();
    const cfg = getBridgeConfig();
    if (cfg?.mode !== 'cli' || cfg.browser !== 'playwright' || !cfg.adapter?.playwrightMcp) fail('请先运行 browser-setup 配置有头 Playwright 浏览器');
    if (cfg.adapter.headless) fail('当前为无头模式；后台有头采集需要先切回有头浏览器');
    const { browserRuntimeStatus, installBrowserRuntime, PLAYWRIGHT_VERSION } = await import('../server/browser-runtime.mjs');
    console.log(`将在本机数据目录安装可选的 playwright-core@${PLAYWRIGHT_VERSION}，复用当前账号的独立浏览器资料；不会复制登录状态，也不会自动切无头。`);
    if (!flags.yes) return console.log('确认后加 --yes 重新运行。');
    const runtime = browserRuntimeStatus().available ? browserRuntimeStatus() : installBrowserRuntime();
    storeWorkerSetting(true);
    console.log(`后台有头采集组件已安装（${runtime.version}）；刷新工作台设置页查看状态。`);
  },

  async autostart() {
    const { autostartStatus, setAutostart } = await import('../server/system.mjs');
    const action = flags._[0] || 'status';
    if (action === 'on' || action === 'off') {
      const st = setAutostart(action === 'on');
      console.log(st.enabled ? `已开启开机自启（${st.file}）。电脑登录后会在后台自动运行工作台。` : '已关闭开机自启（正在运行的工作台不受影响）。');
    } else {
      const st = autostartStatus();
      console.log(st.enabled ? `开机自启：已开启（${st.file}）` : '开机自启：未开启');
    }
  },

  async backup() {
    ensureWorkspace();
    const { createBackup } = await import('../server/backup.mjs');
    const b = createBackup();
    console.log(`备份完成：${path.join(WORKSPACE, 'backups', b.name)}（${b.files} 个文件，${(b.size / 1024 / 1024).toFixed(1)} MB）`);
  },

  async restore() {
    const src = flags._[0];
    if (!src) fail('用法：restore <备份文件名或 zip 路径> --yes');
    if (!flags.yes) {
      console.log('恢复会先把当前的配置、账号数据、知识库和对话整体移入回收站（可撤销），再写入备份内容；本机的 agent 连接配置保留。确认后加 --yes 运行。');
      return;
    }
    const { restoreBackup } = await import('../server/backup.mjs');
    const r = restoreBackup(fs.existsSync(src) ? path.resolve(src) : src);
    console.log(`已从 ${r.from} 恢复 ${r.restored} 个文件。正在运行的工作台请刷新页面。`);
  },

  async 'kb-search'() {
    const q = flags._.join(' ');
    if (!q) fail('用法：kb-search "<问题或关键词>"');
    const { searchKnowledge } = await import('../server/store.mjs');
    const results = searchKnowledge(q, 8);
    if (!results.length) return console.log('知识库里没有找到相关内容。');
    for (const r of results) console.log(`[${r.score}] knowledge/${r.path}  ${r.title}\n    ${r.snippet.replace(/[\u0001\u0002]/g, '')}`);
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
