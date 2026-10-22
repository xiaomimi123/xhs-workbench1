// 启动底层 agent CLI 前清理环境变量。
// 工作台可能是在别的 agent（WorkBuddy 等）的沙箱里被拉起的，沙箱会注入自己的配置目录、端口和本机代理；
// 原样传给 codebuddy / claude 等 CLI，会让它们读到沙箱的配置（读不到自己的登录状态）、端口冲突、请求被转进已不存在的代理。
const LOOPBACK = /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i;
const PROXY_KEYS = ['http_proxy', 'https_proxy', 'all_proxy'];

export function sanitizeAgentEnv(src = process.env) {
  const env = { ...src };
  // 从另一个 Claude Code 会话里启动时，需去掉这些变量，否则嵌套调用会被拒绝
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  const sandboxed = Object.keys(env).some((k) => /^WORKBUDDY_/i.test(k));
  if (sandboxed) {
    // 只在确认是沙箱拉起时才清理：用户自己常驻的本机代理（Clash 等也是 127.0.0.1）不能误删
    for (const k of Object.keys(env)) {
      if (/^WORKBUDDY_/i.test(k)) delete env[k];
      else if (PROXY_KEYS.includes(k.toLowerCase()) && LOOPBACK.test(String(env[k] || '').trim())) delete env[k];
    }
    delete env.CODEBUDDY_CONFIG_DIR;
    delete env.SERVER__PORT;
  }
  return env;
}
