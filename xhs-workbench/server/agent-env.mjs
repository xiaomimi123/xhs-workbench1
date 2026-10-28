// 启动底层 agent CLI 前清理环境变量。
// 工作台可能是在别的 agent（WorkBuddy 等）的沙箱里被拉起的，沙箱会注入自己的配置目录、端口和本机代理；
// 原样传给 codebuddy / claude 等 CLI，会让它们读到沙箱的配置（读不到自己的登录状态）、端口冲突、请求被转进已不存在的代理。
const LOOPBACK = /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i;
const PROXY_KEYS = ['http_proxy', 'https_proxy', 'all_proxy'];
// WorkBuddy 会话里除 WORKBUDDY_* / CODEBUDDY_* 外，还会把解释器和脚本钩子指向自己的 shim（实测 CLI 带着它们会被判成「WorkBuddy 上下文」，要求托管凭据而登录失败，
// 而同一台机器的最小环境里连续 5 次以上都能用）。这几个变量的名字固定，沙箱里一律去掉；
// 其他变量只在取值指向 workbuddy 目录时才去掉（用户自己的同名变量不会指向那里），PATH 只剔除 workbuddy 的目录。
const HOOK_KEYS = /^(NODE_OPTIONS|PYTHONPATH|PYTHONSTARTUP|BASH_ENV|ENV|EXEPATH|ACC_PRODUCT_CONFIG\w*)$/i;
const POINTS_TO_WORKBUDDY = /workbuddy/i;
const isSandboxed = (env) => Object.entries(env).some(([k, v]) => /^WORKBUDDY_/i.test(k) || (HOOK_KEYS.test(k) && POINTS_TO_WORKBUDDY.test(String(v || ''))));

export function sanitizeAgentEnv(src = process.env) {
  const env = { ...src };
  // 从另一个 Claude Code 会话里启动时，需去掉这些变量，否则嵌套调用会被拒绝
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  const sandboxed = isSandboxed(env);
  if (sandboxed) {
    // 只在确认是沙箱拉起时才清理：用户自己常驻的本机代理（Clash 等也是 127.0.0.1）不能误删
    for (const k of Object.keys(env)) {
      if (/^WORKBUDDY_/i.test(k)) delete env[k];
      // WorkBuddy 内置的就是 CodeBuddy，它给自己的会话注入了一整套 CODEBUDDY_*（实测 60 个），必须全清，不能只清 CONFIG_DIR：
      // 其中 CODEBUDDY_SERVICE_PROXY_URL 指向 WorkBuddy 自己的本机端口，子进程 codebuddy 会去监听同一个端口，
      // 启动即 EADDRINUSE 退出，网页上看到的就是「回复为空」（员工电脑上踩过）
      else if (/^CODEBUDDY_/i.test(k)) delete env[k];
      else if (PROXY_KEYS.includes(k.toLowerCase()) && LOOPBACK.test(String(env[k] || '').trim())) delete env[k];
    }
    delete env.SERVER__PORT;
    for (const k of Object.keys(env)) {
      if (/^path$/i.test(k)) {
        const sep = process.platform === 'win32' ? ';' : ':';
        env[k] = String(env[k]).split(sep).filter((d) => d && !POINTS_TO_WORKBUDDY.test(d)).join(sep);
      } else if (HOOK_KEYS.test(k) || POINTS_TO_WORKBUDDY.test(String(env[k] || ''))) delete env[k];
    }
  }
  return env;
}
