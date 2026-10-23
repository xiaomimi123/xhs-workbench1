#!/usr/bin/env node
// 小红书运营工作台 · 统一命令入口（给 agent 调用）
//
//   node scripts/workbench.mjs doctor [--json]               环境自检：缺什么、怎么装（不修改任何东西）
//   node scripts/workbench.mjs upgrade --check              查看当前版本、数据版本与最近一次升级
//   node scripts/workbench.mjs upgrade --package <zip> [--yes] [--allow-downgrade]
//                                                            用新版安装包替换技能包（先备份数据，旧版本保留为 .bak-<版本>）
//   node scripts/workbench.mjs setup                         初始化数据目录
//   node scripts/workbench.mjs bridge-test [--agent <id>] [--prefer <id>] [--only <id>] [--all] [--auto] [--inbox]
//                                                            探测本机 agent 并跑连接测试，写入配置
//   node scripts/workbench.mjs start [--open]                启动工作台（已运行则复用）
//   node scripts/workbench.mjs open                          在浏览器打开工作台
//   node scripts/workbench.mjs status                        查看运行与连接状态
//   node scripts/workbench.mjs stop                          停止工作台
//   node scripts/workbench.mjs browser-setup [--engine playwright|chrome] [--headless] [--yes]
//                                                            为 CLI agent 配置浏览器控制
//   node scripts/workbench.mjs browser-mode readonly|test   切换 CodeBuddy 的浏览器权限档（readonly 只读 / test 测试档）
//   node scripts/workbench.mjs browser-worker-setup [--yes]  安装可选的后台有头读取组件
//   node scripts/workbench.mjs browser-worker-status        检查后台读取组件
//   node scripts/workbench.mjs autostart on|off|status            登录电脑后自动运行工作台
//   node scripts/workbench.mjs backup                            立即备份数据
//   node scripts/workbench.mjs restore <备份文件> --yes           从备份恢复（当前数据先移入回收站）
//   node scripts/workbench.mjs kb-search "<问题或关键词>"        按相关度检索知识库
//   node scripts/workbench.mjs lint --account <账号id> --note <笔记id>
//                                                            检查笔记字数与违禁词
//   node scripts/workbench.mjs inbox-next [--wait 110] [--dry-run]
//                                                            收件箱模式：领取下一条任务；--dry-run 只看队列、不领取
//   node scripts/workbench.mjs inbox-requeue <taskId>        收件箱模式：把刚领到、处理不了的任务退回队列
//   node scripts/workbench.mjs inbox-reply <taskId> [--final] [--error <msg>] [--file <path>]
//                                                            收件箱模式：回写结果（正文从 --file 或标准输入读取）
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { P, SKILL_DIR, WORKSPACE } from '../server/paths.mjs';
import { readJson, writeJson, saveBridgeConfig, getBridgeConfig } from '../server/store.mjs';
import { ADAPTERS, DESKTOP_AGENTS, findDesktopAgent, detectDesktopAgents, planConnection } from '../server/adapters.mjs';
import { detectAdapters, pingAdapter } from '../server/bridge.mjs';
import { runDoctor, formatDoctor } from '../server/doctor.mjs';
import { VERSION } from '../server/version.mjs';
import { readVersionRecord, installPackage, ensureWorkspaceStamped, DATA_VERSION } from '../server/upgrade.mjs';
import { createBackup } from '../server/backup.mjs';
import { decodeText, writeTaskFile } from '../server/inbox-files.mjs';
import { applyBrowser, migrateLegacyProfile } from '../server/browser.mjs';
import { applyHubDefaults } from '../server/hub-env.mjs';
import { reportHealth } from '../server/health-outbox.mjs';

applyHubDefaults();  // 由 agent 直接运行命令时也接上本机中枢接入器（start 启动的服务会继承这些变量）

const [cmd, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);
const ensureWorkspace = () => ensureWorkspaceStamped(VERSION);
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 调本地服务。值守是长驻场景：服务重启、连接被重置时不能崩出一堆堆栈——
 * 网络层错误带退避重试（1s、2s、4s），每次都重新读 server.json（重启后端口可能变了）；
 * 仍不通就打印机器可读的 WORKBENCH_DOWN 并以退出码 2 结束，让值守端能区分“没有任务”（NO_TASK）和“服务不可用”。
 * HTTP 层的业务错误（4xx/5xx 带 error 字段）不重试，照旧直接报错。
 */
async function api(method, pathname, body, timeoutMs = 15_000, { retries = 3 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const info = serverInfo();
    if (await health(info)) {
      let res;
      try {
        res = await fetch(`http://127.0.0.1:${info.port}${pathname}`, {
          method,
          headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': token() },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch { res = null; } // 连接被重置 / 超时：落到下面的重试
      if (res) {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) fail(data.error || `HTTP ${res.status}`);
        return data;
      }
    }
    if (attempt < retries) await sleep(1000 * 2 ** attempt);
  }
  console.log(`WORKBENCH_DOWN: 工作台没有运行或正在重启（已重试 ${retries} 次）。请稍后原样重试这条命令；一直不通请运行 start。`);
  process.exit(2);
}

function openBrowser(url) {
  const [bin, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? // explorer 直接打开 URL：不经过 shell，URL 里的 & 不会被截断，也没有 shell:true 传参的安全告警（DEP0190）
          ['explorer.exe', [url]]
        : ['xdg-open', [url]];
  spawn(bin, args, { detached: true, stdio: 'ignore' }).unref();
}

function storeWorkerSetting(enabled) {
  writeJson(P.settings, { ...readJson(P.settings, {}), backgroundBrowser: enabled });
}

// ---------- 命令 ----------

const commands = {
  async upgrade() {
    const record = readVersionRecord();
    const last = record?.history?.at(-1);
    if (flags.check || !flags.package) {
      console.log(`技能包版本：v${VERSION}（数据格式 v${DATA_VERSION}）`);
      console.log(record ? `数据目录记录：v${record.appVersion}（数据格式 v${record.dataVersion}）` : '数据目录还没有版本记录（旧版安装或全新安装；下次启动工作台时会自动备份并登记）');
      if (last) console.log(`最近一次变更：${last.at} ${last.from ? 'v' + last.from : '未知版本'} → v${last.to}${last.backup ? `，升级前备份 ${last.backup}` : ''}${last.ok === false ? `，失败：${last.error}` : ''}`);
      console.log('用新版安装包升级：upgrade --package <zip路径>（不带 --yes 只预检）');
      console.log('RESULT: info');
      return;
    }
    if (typeof flags.package !== 'string' || !fs.existsSync(flags.package)) fail('找不到安装包：' + flags.package);
    let plan;
    try {
      plan = installPackage({ buf: fs.readFileSync(flags.package), skillDir: SKILL_DIR, currentVersion: VERSION, allowDowngrade: !!flags['allow-downgrade'], dryRun: true });
    } catch (err) {
      fail(`安装包检查未通过：${err.message}`);
    }
    console.log(`当前 v${plan.from} → 安装包 v${plan.to}（${plan.files} 个文件，SHA-256 ${plan.sha256}）`);
    if (!plan.ok) {
      console.log(`不会升级：${plan.refused}${plan.needsFlag ? `。确实要这样做请加 ${plan.needsFlag}` : ''}`);
      console.log('RESULT: refused');
      return;
    }
    if (!flags.yes) {
      console.log('预检通过。执行时会：1) 停止工作台 2) 先备份全部用户数据 3) 把现有技能包改名为 ' + plan.oldCopy + '（作为回退用副本） 4) 换上新版本 5) 重新启动，启动时自动迁移数据。用户数据目录不会被替换。');
      console.log('请先征得用户同意，再加 --yes 重新运行。');
      console.log('RESULT: confirm');
      return;
    }
    const wasRunning = await health(serverInfo());
    if (wasRunning) await commands.stop();
    const backup = createBackup({ prefix: 'upgrade-pre' });
    console.log(`已备份用户数据：${backup.name}（${backup.files} 个文件）`);
    let done;
    try {
      done = installPackage({ buf: fs.readFileSync(flags.package), skillDir: SKILL_DIR, currentVersion: VERSION, allowDowngrade: !!flags['allow-downgrade'] });
    } catch (err) {
      if (wasRunning) console.log('升级未完成，旧版本保持原样。可运行 start 重新启动工作台。');
      fail(err.message);
    }
    if (!done.ok) fail(done.refused);
    console.log(`已升级到 v${done.to}；旧版本保留在 ${done.oldCopy}，确认新版本正常后可自行删除。`);
    if (wasRunning) {
      const r = spawnSync(process.execPath, [path.join(SKILL_DIR, 'scripts', 'workbench.mjs'), 'start'], { stdio: 'inherit' });
      if (r.status !== 0) console.log('新版本启动失败；回退方法：关闭工作台，删除当前 xhs-workbench 目录，把 ' + done.oldCopy + ' 改回 xhs-workbench。');
    } else console.log('工作台之前没有在运行；需要时运行 start，启动时会自动迁移数据。');
    console.log(`RESULT: upgraded ${done.from} ${done.to}`);
  },

  // 第一步就能跑：不依赖数据目录已初始化，也不写任何文件（只在探测可写性时创建并删除一个临时文件）
  async doctor() {
    const report = runDoctor({ workspace: WORKSPACE, bridgeConfig: readJson(P.bridge, null) });
    if (flags.json) console.log(JSON.stringify(report, null, 2));
    else console.log(formatDoctor(report));
    if (!report.ready) process.exitCode = 1;
  },

  async setup() {
    checkNode();
    ensureWorkspace();
    console.log(`数据目录已就绪：${WORKSPACE}`);
    console.log(`技能包目录：${SKILL_DIR}`);
    console.log(`Node.js 版本：${process.versions.node}`);
    const { ensureDefaultConnection } = await import('../server/agent-setup.mjs');
    if (process.env.XHS_NO_AUTO_CONNECT !== '1' && ensureDefaultConnection()) console.log('连接配置：已自动连接 CodeBuddy CLI（网页「连接与设置」里可以检查登录、选择浏览器）');
    else console.log(getBridgeConfig() ? '连接配置：已存在（可直接 start）' : '连接配置：尚未配置（本机没有 CodeBuddy CLI）；在网页「连接与设置」里选择 agent');
  },

  async 'bridge-test'() {
    checkNode();
    ensureWorkspace();
    const saveInbox = (host) => {
      const { hostAgent: _old, ...prev } = getBridgeConfig() || {};
      saveBridgeConfig({ ...prev, mode: 'inbox', ...(host ? { hostAgent: { id: host.id, name: host.name } } : {}), testedAt: new Date().toISOString() });
    };

    const detectedCli = detectAdapters(ADAPTERS);
    const detectedDesktop = detectDesktopAgents();
    const hostId = flags.agent || flags.prefer;
    const plan = flags.inbox
      ? { action: 'inbox', hostId: hostId && findDesktopAgent(hostId) ? hostId : null }
      : planConnection({ cliIds: detectedCli.map((a) => a.id), desktopIds: detectedDesktop.map((a) => a.id), prefer: hostId || flags.only || null, current: getBridgeConfig(), auto: !!flags.auto });

    console.log(`本机检测到的 agent 命令行：${detectedCli.map((a) => `${a.name}(${a.command})`).join('，') || '无'}`);
    console.log(`本机检测到的桌面类 agent（只能走收件箱模式）：${detectedDesktop.map((a) => a.name).join('，') || '无'}`);

    if (plan.action === 'choose') {
      console.log('\n本机有多个可用的 agent，工作台不替用户决定。请问用户想让网页里的对话由哪一个处理，然后重新运行：');
      console.log('  bridge-test --agent <id>');
      for (const o of plan.options) {
        const cli = detectedCli.find((a) => a.id === o);
        const desktop = detectedDesktop.find((a) => a.id === o);
        console.log(`  ${o}	${(cli || desktop).name}	${cli ? 'CLI 模式（工作台直接调用，无需保持窗口）' : '收件箱模式（需要该 agent 窗口保持打开并值守）'}`);
      }
      console.log(`RESULT: choose ${plan.options.join(' ')}`);
      return;
    }
    if (plan.action === 'inbox') {
      const host = plan.hostId ? findDesktopAgent(plan.hostId) : null;
      saveInbox(host);
      console.log(host ? `已设置为收件箱模式，由 ${host.name} 值守。` : '已设置为收件箱模式。');
      console.log('提示：收件箱模式要求该 agent 的窗口保持打开，并在会话里循环领取任务（见 SKILL.md 第三节）。');
      console.log(`RESULT: inbox${host ? ` ${host.id}` : ''}`);
      return;
    }

    let candidates = detectedCli;
    if (plan.action === 'cli') {
      if (!candidates.some((a) => a.id === plan.id)) fail(`本机没有找到命令行 agent「${plan.id}」。已知的桌面类 agent id：${DESKTOP_AGENTS.map((a) => a.id).join('、')}`);
      candidates = candidates.filter((a) => a.id === plan.id);
    }
    if (flags.all) candidates = detectedCli;
    if (flags.prefer) candidates.sort((a, b) => (b.id === flags.prefer) - (a.id === flags.prefer));

    const results = [];
    let chosen = null;
    for (const adapter of candidates) {
      process.stdout.write(`测试 ${adapter.name} … `);
      const r = await pingAdapter(adapter);
      reportHealth({ stage: 'doctor', ok: r.ok, message: r.error || '', agent: adapter.name });  // 命令行的连接测试也回传「应用健康」
      results.push({ id: adapter.id, command: adapter.command, ok: r.ok, ms: r.ms, error: r.error });
      console.log(r.ok ? `通过（${(r.ms / 1000).toFixed(1)} 秒）` : `失败：${r.error}`);
      if (r.ok && !chosen) {
        chosen = adapter;
        if (!flags.all) break;
      }
    }

    const { hostAgent: _staleHost, ...prev } = getBridgeConfig() || {};
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
      // Windows 上 SIGTERM 等于直接结束进程，服务自己来不及写日志，所以由命令行记一笔：以后能分清是谁停的
      try { fs.appendFileSync(path.join(P.logs, 'server.log'), `[${new Date().toISOString()}] 收到 stop 命令（命令行 pid ${process.pid}，父进程 pid ${process.ppid}），停止工作台 pid ${info.pid}\n`); } catch { /* 日志写不了不影响停止 */ }
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
    const engine = flags.engine === 'chrome' ? 'chrome' : flags.engine === 'workbuddy' ? 'workbuddy' : 'playwright';
    if (engine === 'workbuddy' && cfg.adapter?.id !== 'codebuddy') fail('WorkBuddy 浏览器插件目前只接 CodeBuddy CLI：请先 bridge-test --agent codebuddy');
    if (cfg.mode !== 'cli' || !cfg.adapter || !['claude-code','codex','codebuddy'].includes(cfg.adapter.id)) {
      console.log('当前不是 Claude Code / Codex / CodeBuddy 的 CLI 模式，无法自动配置。');
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
    } else if (engine === 'workbuddy') {
      const { detectWorkbuddyBrowserMcp } = await import('../server/browser.mjs');
      pkg = detectWorkbuddyBrowserMcp();
      if (!pkg) fail('没有找到 WorkBuddy 的浏览器插件（browser-mcp）。请在 WorkBuddy「设置 > 智能体 > 浏览器操控」里打开「让 WorkBuddy 控制浏览器」并安装 Edge / Chrome 扩展');
      plan.push(`使用 WorkBuddy 浏览器插件（${pkg}）：直接操作你自己正在用的 Edge / Chrome，沿用已有登录；需要浏览器里的 WorkBuddy 扩展已启用。注意所有工作台账号共用这一个浏览器，操作前要核对当前登录的是哪个号`);
      plan.push(`权限：${cfg.adapter.browserMode === 'test' ? '测试档（可点击、输入；仍禁执行脚本、不关你的标签页）' : '只读档（只能看、滚动、截图；不能点击、输入）'}`);
    } else {
      plan.push('启用 Claude in Chrome：直接使用你日常 Chrome 里的登录状态（需要已安装 Claude 浏览器扩展）。注意：这种方式所有账号共用一个浏览器，多账号时请用 Playwright');
    }
    const adapter = applyBrowser(cfg.adapter, engine, pkg);
    const tools = adapter.id==='codex'?'Playwright MCP':adapter.id==='codebuddy'?adapter.args.slice(adapter.args.indexOf('--allowedTools') + 1).filter((a,i,arr)=>!arr.slice(0,i).some((x)=>x.startsWith('-'))).join(','):adapter.args[adapter.args.indexOf('--allowedTools') + 1];
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
    reportHealth({ stage: 'doctor', ok: r.ok, message: r.ok ? '' : `浏览器配置（${engine}）连接测试失败：${r.error}`, agent: adapter.name });
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

  async 'browser-mode'() {
    const mode = rest[0] || '';
    const cfg = getBridgeConfig();
    if (!['readonly', 'test'].includes(mode)) fail('用法：browser-mode readonly|test');
    if (!cfg?.adapter || cfg.adapter.id !== 'codebuddy' || !['playwright', 'workbuddy'].includes(cfg.browser)) fail('当前不是 CodeBuddy 的浏览器控制，请先运行 browser-setup');
    const adapter = applyBrowser({ ...cfg.adapter, browserMode: mode }, cfg.browser, cfg.browser === 'workbuddy' ? cfg.adapter.workbuddyMcp : cfg.adapter.playwrightMcp);
    adapter.headless = cfg.adapter.headless; adapter.browserChannel = cfg.adapter.browserChannel;
    saveBridgeConfig({ ...cfg, adapter });
    console.log(mode === 'test'
      ? '已切到【测试档】：点击 / 输入等交互工具已放开；仍禁用上传文件和执行脚本，并屏蔽创作者中心域名（发布入口）。测完请运行 browser-mode readonly 收回。'
      : '已切回【只读档】：浏览器写类工具全部禁用。');
    console.log(`RESULT: browser-mode ${mode}`);
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
    if (flags['dry-run']) {
      // 只看队列，绝不领取（探测、排查时用，避免把任务白白领走）
      const peek = await api('GET', '/api/agent/peek');
      console.log(`PENDING: ${peek.pending}`);
      if (peek.head) console.log(`HEAD: ${peek.head.id}`);
      console.log('DRY_RUN: 没有领取任何任务');
      return;
    }
    const wait = Number(flags.wait) || 110;
    const { task } = await api('GET', `/api/agent/next?wait=${wait}`, null, (wait + 15) * 1000);
    if (!task) {
      console.log('NO_TASK');
      return;
    }
    console.log(`TASK_ID: ${task.id}`);
    // 任务正文另存为 UTF-8（带 BOM）文件：Windows 终端/PowerShell 常按 GBK 或 UTF-16 解读输出，中文会变成乱码，以文件为准
    const taskFile = writeTaskFile(task, { dir: path.join(P.run, 'inbox') });
    console.log(`TASK_FILE: ${taskFile}`);
    console.log('（任务正文是 UTF-8 中文。若下面的内容在你的终端里显示为乱码，请用读文件的工具读取 TASK_FILE，以文件为准。）');
    console.log('----- 任务内容开始 -----');
    console.log(task.prompt);
    console.log('----- 任务内容结束 -----');
    console.log(`完成后执行：node "${path.join(SKILL_DIR, 'scripts', 'workbench.mjs')}" inbox-reply ${task.id} --final  （回复正文从标准输入或 --file 传入）`);
  },

  async 'inbox-requeue'() {
    const taskId = flags._[0];
    if (!taskId) fail('用法：inbox-requeue <taskId>');
    await api('POST', '/api/agent/requeue', { taskId });
    console.log('已把任务退回队列，其他（或稍后的）值守可以重新领取。');
  },

  async 'inbox-reply'() {
    const taskId = flags._[0];
    if (!taskId) fail('缺少 taskId');
    let text = '';
    // 回写正文自动识别 UTF-8 / UTF-16 / GBK（PowerShell 的重定向默认写 UTF-16，管道常是 GBK）
    if (typeof flags.file === 'string') text = decodeText(fs.readFileSync(flags.file));
    else if (!process.stdin.isTTY) text = decodeText(fs.readFileSync(0));
    text = text.trim();
    const error = typeof flags.error === 'string' ? flags.error : '';
    if (!text && !error && !flags.final) fail('回复内容为空');
    await api('POST', '/api/agent/reply', { taskId, text, final: !!flags.final, error });
    console.log(flags.final || error ? '已回写，任务结束。' : '已回写进度。');
  },
};

// 帮助参数绝不进入真实命令：`inbox-next --help` 以前会真的领走队首任务
if (flags.help || flags.h || rest.includes('-h') || cmd === '--help' || cmd === '-h' || cmd === 'help') {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n').replace(/^\/\/ ?/gm, ''));
  process.exit(0);
}
if (!commands[cmd]) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n').replace(/^\/\/ ?/gm, ''));
  process.exit(cmd ? 1 : 0);
}
await commands[cmd]();
