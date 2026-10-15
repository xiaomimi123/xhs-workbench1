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
    args: ['exec', '--skip-git-repo-check', '--full-auto', '-'],
    promptVia: 'stdin',
    parser: 'text',
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy Code',
    bins: ['codebuddy', 'cbc'],
    args: ['-p', '{prompt}'],
    promptVia: 'arg',
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
