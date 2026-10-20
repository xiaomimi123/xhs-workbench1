// 环境自检：给 agent 一份“缺什么、怎么装”的确定清单，免得它凭感觉排查。
// 纯函数 + 可注入依赖；命令行入口在 scripts/workbench.mjs 的 doctor。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findBinary } from './binaries.mjs';
import { ADAPTERS, detectDesktopAgents } from './adapters.mjs';

export const MIN_NODE_MAJOR = 18;

/** 本机可用的包管理器，用来挑最省事的安装命令 */
export function detectPackageManagers(find = findBinary, platform = process.platform) {
  const names = platform === 'win32' ? ['winget', 'choco', 'scoop'] : platform === 'darwin' ? ['brew'] : ['apt-get', 'dnf', 'brew'];
  return names.filter((n) => find(n));
}

function installHint(tool, platform, managers) {
  const has = (m) => managers.includes(m);
  if (tool === 'node') {
    if (platform === 'win32') {
      if (has('winget')) return { command: 'winget install OpenJS.NodeJS.LTS', note: '装完后要新开一个终端，PATH 才会刷新。' };
      return { manual: '到 https://nodejs.org 下载 LTS 版 .msi 安装包，让用户双击安装（可能需要管理员权限，请用户本人操作）。装完新开终端。' };
    }
    if (platform === 'darwin') {
      if (has('brew')) return { command: 'brew install node' };
      return { manual: '到 https://nodejs.org 下载 LTS 版 .pkg 安装包，让用户双击安装（需要输入电脑密码，请用户本人操作）。' };
    }
    return { manual: '用系统包管理器安装 Node.js ≥ 18，或使用 nvm。' };
  }
  // ffmpeg / ffprobe 同一个包
  if (platform === 'win32') {
    if (has('winget')) return { command: 'winget install Gyan.FFmpeg', note: '装完后新开终端；工作台自己也会在常见目录里查找，不一定要重启。' };
    if (has('choco')) return { command: 'choco install ffmpeg -y' };
    if (has('scoop')) return { command: 'scoop install ffmpeg' };
    return { manual: '没有包管理器：从 https://www.gyan.dev/ffmpeg/builds/ 下载 ffmpeg-release-essentials.zip（约 110MB，国内网络可能很慢），解压到 %USERPROFILE%\\ffmpeg，并把其中的 bin 目录加入用户 PATH。工作台会在 %USERPROFILE%\\ffmpeg 下自动查找，所以只解压不改 PATH 也能用。下载前先告诉用户来源和大小。' };
  }
  if (platform === 'darwin') {
    if (has('brew')) return { command: 'brew install ffmpeg' };
    return { manual: '先让用户安装 Homebrew（https://brew.sh），再执行 brew install ffmpeg。' };
  }
  return { manual: '用系统包管理器安装 ffmpeg（apt install ffmpeg / dnf install ffmpeg）。' };
}

/**
 * 运行全部检查。level：
 *   required    缺了工作台起不来 → 必须先解决
 *   recommended 缺了部分功能不可用 → 告诉用户影响后再决定装不装
 *   info        只是提示，不需要处理
 */
export function runDoctor(deps = {}) {
  const platform = deps.platform || process.platform;
  const find = deps.find || ((n) => findBinary(n));
  const nodeVersion = deps.nodeVersion || process.versions.node;
  const workspace = deps.workspace;
  const bridgeConfig = deps.bridgeConfig === undefined ? null : deps.bridgeConfig;
  const detectCli = deps.detectCli || (() => ADAPTERS.filter((a) => a.bins.some((b) => find(b))).map((a) => ({ id: a.id, name: a.name })));
  const detectDesktop = deps.detectDesktop || (() => detectDesktopAgents({ platform }));
  const managers = deps.managers || detectPackageManagers(find, platform);
  const writable = deps.writable || ((dir) => {
    try { fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, `.doctor-${process.pid}`); fs.writeFileSync(f, 'x'); fs.rmSync(f); return true; } catch { return false; }
  });

  const checks = [];
  const add = (c) => checks.push(c);

  const major = Number(String(nodeVersion).split('.')[0]);
  add({ id: 'node', label: `Node.js ≥ ${MIN_NODE_MAJOR}`, level: 'required', ok: major >= MIN_NODE_MAJOR, detail: `当前 ${nodeVersion}`,
    affects: '工作台无法运行', fix: major >= MIN_NODE_MAJOR ? null : installHint('node', platform, managers) });

  if (workspace) {
    const ok = writable(workspace);
    add({ id: 'workspace', label: '数据目录可写', level: 'required', ok, detail: workspace, affects: '无法保存任何数据',
      fix: ok ? null : { manual: `数据目录 ${workspace} 无法创建或写入。换一个位置：设置环境变量 XHS_WORKSPACE 指向有写权限的文件夹（例如用户目录下的新文件夹）。` } });
  }

  for (const tool of ['ffmpeg', 'ffprobe']) {
    const where = find(tool);
    add({ id: tool, label: tool, level: 'recommended', ok: !!where, detail: where || '未找到', affects: '参考视频的上传校验、抽帧与视频创作不可用（图文笔记不受影响）',
      fix: where ? null : installHint('ffmpeg', platform, managers) });
  }

  const cli = detectCli();
  const desktop = detectDesktop();
  const configured = !!bridgeConfig;
  const agentOk = configured || cli.length + desktop.length > 0;
  add({ id: 'agent', label: 'Agent 连接', level: 'recommended', ok: configured,
    detail: configured
      ? (bridgeConfig.mode === 'cli' ? `CLI 模式 · ${bridgeConfig.adapter?.name || bridgeConfig.adapter?.id}` : `收件箱模式 · ${bridgeConfig.hostAgent?.name || '未指定值守 agent'}`)
      : `尚未配置；本机检测到：${[...cli, ...desktop].map((a) => a.name).join('、') || '无'}`,
    affects: '网页里的对话没有 agent 处理',
    fix: configured ? null : { command: 'node "<SKILL_DIR>/scripts/workbench.mjs" bridge-test --agent <id>',
      note: agentOk ? '本机有多个 agent 时必须先问用户选哪个（见 SKILL.md 第二节），不要自己决定。' : '本机没有检测到任何 agent，用你自己（当前正在对话的 agent）值守：bridge-test --inbox。' } });

  if (platform !== 'darwin') {
    add({ id: 'platform-features', label: '仅 macOS 可用的功能', level: 'info', ok: true,
      detail: '实况图（Live Photo）制作、本地二维码、截图 OCR 核对在当前系统不可用，工作台会明确提示，其余功能不受影响', affects: '', fix: null });
  }

  const required = checks.filter((c) => c.level === 'required' && !c.ok);
  const recommended = checks.filter((c) => c.level === 'recommended' && !c.ok);
  return { platform, node: nodeVersion, managers, checks, ready: required.length === 0, requiredMissing: required.map((c) => c.id), recommendedMissing: recommended.map((c) => c.id) };
}

export function formatDoctor(report) {
  const lines = [`系统：${report.platform} · Node ${report.node} · 包管理器：${report.managers.join('、') || '无'}`, ''];
  for (const c of report.checks) {
    const mark = c.ok ? '✔' : c.level === 'required' ? '✖' : c.level === 'recommended' ? '△' : '·';
    lines.push(`${mark} ${c.label}：${c.detail}`);
    if (!c.ok) {
      if (c.affects) lines.push(`    影响：${c.affects}`);
      if (c.fix?.command) lines.push(`    FIX: ${c.fix.command}`);
      if (c.fix?.manual) lines.push(`    FIX(手动): ${c.fix.manual}`);
      if (c.fix?.note) lines.push(`    注意：${c.fix.note}`);
    }
  }
  lines.push('');
  if (!report.ready) lines.push(`RESULT: blocked ${report.requiredMissing.join(' ')}`);
  else if (report.recommendedMissing.length) lines.push(`RESULT: action-needed ${report.recommendedMissing.join(' ')}`);
  else lines.push('RESULT: ok');
  return lines.join('\n');
}
