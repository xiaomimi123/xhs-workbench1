// 统一的路径定义：技能包目录（只读，随 skill 分发）与数据目录（用户本地数据）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 数据目录：XHS_WORKSPACE 优先；已有 ~/XHS-Workbench 的电脑继续用它（不搬用户数据）；
// 否则用企业中枢应用根目录里的 data/xhs-workbench（接入器启动时通过 HUB_APP_DATA_DIR 传入；agent 直接运行命令时没有这个变量，按目录是否存在找到同一处）
export function resolveWorkspace(env = process.env, home = os.homedir(), exists = fs.existsSync) {
  if (env.XHS_WORKSPACE) return path.resolve(env.XHS_WORKSPACE);
  const legacy = path.join(home, 'XHS-Workbench');
  if (exists(legacy)) return legacy;
  if (env.HUB_APP_DATA_DIR) return path.resolve(env.HUB_APP_DATA_DIR);
  const hubData = path.join(env.HUB_APPS_ROOT || path.join(home, 'HubApps'), 'data', 'xhs-workbench');
  return exists(hubData) ? hubData : legacy;
}
export const WORKSPACE = resolveWorkspace();

export const P = {
  config: path.join(WORKSPACE, 'config'),
  bridge: path.join(WORKSPACE, 'config', 'bridge.json'),
  settings: path.join(WORKSPACE, 'config', 'settings.json'),
  accounts: path.join(WORKSPACE, 'config', 'accounts.json'),
  accountsDir: path.join(WORKSPACE, 'accounts'),
  knowledge: path.join(WORKSPACE, 'knowledge'),
  chats: path.join(WORKSPACE, 'chats'),
  logs: path.join(WORKSPACE, 'logs'),
  run: path.join(WORKSPACE, 'run'),
  serverInfo: path.join(WORKSPACE, 'run', 'server.json'),
  token: path.join(WORKSPACE, 'run', 'token'),
  trash: path.join(WORKSPACE, '.trash'),
  web: path.join(SKILL_DIR, 'web'),
  templates: path.join(SKILL_DIR, 'templates'),
};

// 每个账号下的业务目录（M2/M3 模块会往这些目录写数据）
export const ACCOUNT_SUBDIRS = ['topics', 'notes', 'engage', 'analytics', 'benchmarks', 'materials'];

export function accountDir(id) {
  return path.join(P.accountsDir, id);
}
