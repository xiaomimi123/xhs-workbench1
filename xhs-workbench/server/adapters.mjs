import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 已知 agent CLI 的适配模板。bridge-test 会探测本机装了哪些，逐个跑连接测试。
// 占位符：{prompt} {workspace} {skillDir} {agentSessionId}
// promptVia: 'stdin' 通过标准输入传提示词（推荐，避免命令行转义问题）；'arg' 通过 {prompt} 占位符传入
// parser:    'claude-stream-json' 解析 Claude Code 的流式 JSON；'text' 直接把标准输出当回复

export const ADAPTERS = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    bins: ['claude'],
    args: ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', 'WebSearch,WebFetch', '--add-dir', '{skillDir}'],
    promptVia: 'stdin',
    parser: 'claude-stream-json',
    resumeArgs: ['--resume', '{agentSessionId}'],
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    bins: ['codex'],
    args: ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-'],
    promptVia: 'stdin',
    parser: 'text',
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy Code',
    bins: ['codebuddy', 'cbc'],
    // 提示词走标准输入：Windows 上 codebuddy 是 .cmd 垫片，通过命令行参数传多行文本会在第一个换行处被截断（agent 只看到标题）
    // 无人值守没有权限弹窗：自动接受文件编辑（acceptEdits），读文件、搜索和联网要显式放行（实测只加 --add-dir 时 Read 仍被拒）。
    // --allowedTools 是多值参数，每个工具单独一项；用逗号拼成一项放行不生效。
    args: ['-p', '--permission-mode', 'acceptEdits', '--add-dir', '{skillDir}', '--allowedTools', 'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
    promptVia: 'stdin',
    parser: 'text',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    bins: ['gemini'],
    args: ['-p', '{prompt}'],
    promptVia: 'arg',
    parser: 'text',
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    bins: ['qwen'],
    args: ['-p', '{prompt}'],
    promptVia: 'arg',
    parser: 'text',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    bins: ['opencode'],
    args: ['run', '{prompt}'],
    promptVia: 'arg',
    parser: 'text',
  },
];

export function findAdapter(id) {
  return ADAPTERS.find((a) => a.id === id);
}

// 桌面 / IDE 类 agent：没有可在后台调用的命令行，只能走收件箱模式（agent 在自己的会话里值守）。
// 探测依据是安装痕迹（用户目录下的配置夹、应用安装目录），仅作为“本机似乎装有”的提示，不代表一定可用。
export const DESKTOP_AGENTS = [
  { id: 'workbuddy', name: 'WorkBuddy', homeDirs: ['.workbuddy'], apps: { darwin: ['/Applications/WorkBuddy.app'], win32: ['%LOCALAPPDATA%/Programs/WorkBuddy', '%LOCALAPPDATA%/WorkBuddy', '%PROGRAMFILES%/WorkBuddy'] } },
  { id: 'cursor', name: 'Cursor', homeDirs: ['.cursor'], apps: { darwin: ['/Applications/Cursor.app'], win32: ['%LOCALAPPDATA%/Programs/cursor', '%LOCALAPPDATA%/Programs/Cursor'] } },
  { id: 'trae', name: 'Trae', homeDirs: ['.trae'], apps: { darwin: ['/Applications/Trae.app'], win32: ['%LOCALAPPDATA%/Programs/Trae'] } },
];

export function findDesktopAgent(id) {
  return DESKTOP_AGENTS.find((a) => a.id === id);
}

/** 探测本机装有的桌面类 agent。参数可注入，便于测试。 */
export function detectDesktopAgents({ home = os.homedir(), platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  const expand = (p) => (/%(\w+)%/.exec(p) && !env[/%(\w+)%/.exec(p)[1]] ? '' : p.replace(/%(\w+)%/g, (_, k) => env[k]));
  const found = [];
  for (const a of DESKTOP_AGENTS) {
    const candidates = [...a.homeDirs.map((d) => path.join(home, d)), ...(a.apps[platform] || []).map(expand).filter(Boolean)];
    const hit = candidates.find((c) => c && exists(c));
    if (hit) found.push({ id: a.id, name: a.name, evidence: hit, mode: 'inbox' });
  }
  return found;
}

/**
 * 决定 bridge-test 该怎么做（纯函数）：
 *  - 用户 / agent 明确指定了 id（桌面类 → 收件箱；命令行类 → 测试该命令行）就照做；
 *  - 没指定且只有一个选项，沿用；
 *  - 没指定且有多个选项（含桌面类），不替用户决定，返回 choose。
 */
export function planConnection({ cliIds = [], desktopIds = [], prefer = null, current = null, auto = false }) {
  const pick = prefer || null;
  if (pick) {
    if (findDesktopAgent(pick)) return { action: 'inbox', hostId: pick };
    return { action: 'cli', id: pick };
  }
  if (current?.mode === 'inbox' && current.hostAgent?.id) return { action: 'inbox', hostId: current.hostAgent.id };
  if (current?.mode === 'cli' && current.adapter?.id && cliIds.includes(current.adapter.id)) return { action: 'cli', id: current.adapter.id };
  const options = [...cliIds, ...desktopIds];
  if (options.length === 0) return { action: 'inbox', hostId: null };
  // 自动挑选时 CodeBuddy 优先：中枢的浏览器自动化、模型和只读权限档都按它配置（其余按固定顺序）
  if (options.length === 1 || auto) return cliIds.length ? { action: 'cli', id: cliIds.includes('codebuddy') ? 'codebuddy' : cliIds[0] } : { action: 'inbox', hostId: desktopIds[0] };
  return { action: 'choose', options };
}
