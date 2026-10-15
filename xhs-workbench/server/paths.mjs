// 统一的路径定义：技能包目录（只读，随 skill 分发）与数据目录（用户本地数据）
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKSPACE = path.resolve(process.env.XHS_WORKSPACE || path.join(os.homedir(), 'XHS-Workbench'));

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
export const ACCOUNT_SUBDIRS = ['topics', 'notes', 'engage', 'analytics', 'benchmarks'];

export function accountDir(id) {
  return path.join(P.accountsDir, id);
}
