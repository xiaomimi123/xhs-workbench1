// 工作台不是由企业中枢接入器启动的时候（agent 直接运行技能包副本、开机自启、员工自己运行 start），
// 自动找到本机接入器留下的配置，照样接上中枢：中枢 MCP（知识库、技能、GPU 出图出视频）、成果上报、应用健康、访问锁的位置。
// 员工电脑上踩过：agent 直接跑了技能包副本，中枢传的环境变量一个都没有，工作台里的中枢链路全断，中枢也看不到任何报错。
// 已经由接入器启动（带了 HUB_MCP_SERVERS_FILE）、本机没有接入器、或指定了 XHS_WORKSPACE（测试 / 自定义安装）时什么都不做。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function applyHubDefaults(env = process.env, home = os.homedir(), exists = fs.existsSync, read = (p) => fs.readFileSync(p, 'utf8')) {
  if (env.HUB_MCP_SERVERS_FILE || env.XHS_WORKSPACE) return false;
  const agentHome = env.HUB_AGENT_HOME || path.join(home, '.hub-agent');
  if (!exists(path.join(agentHome, 'credentials.json'))) return false;
  const root = env.HUB_APPS_ROOT || path.join(home, 'HubApps');
  const set = (k, v) => { if (v && !env[k]) env[k] = v; };
  const mcp = path.join(agentHome, 'hub-mcp.json');  // 接入器在接入时写好（0.5.1 起），打开应用时也会写
  if (exists(mcp)) set('HUB_MCP_SERVERS_FILE', mcp);
  const caps = path.join(agentHome, 'capabilities', 'xhs-workbench.json');
  if (exists(caps)) set('HUB_CAPABILITIES_FILE', caps);
  set('HUB_WORK_OUTBOX', path.join(agentHome, 'outbox', 'xhs-workbench.jsonl'));
  set('HUB_HEALTH_OUTBOX', path.join(root, 'logs', 'health-xhs-workbench.jsonl'));
  set('HUB_APP_STATE_DIR', path.join(agentHome, 'state', 'xhs-workbench'));
  try { set('HUB_DEVICE_ID', read(path.join(agentHome, 'device-id')).trim()); } catch { /* 还没有设备号 */ }
  env.HUB_SELF_STARTED = '1';  // 网页据此提示「建议从中枢打开」
  return true;
}
