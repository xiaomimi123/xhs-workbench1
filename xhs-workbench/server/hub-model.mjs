// 通过工作台跑的 CodeBuddy 任务，必须走企业中枢下发的模型（经中枢的模型网关，才能按人计量、判断在线）。
//
// 为什么不能只靠 CodeBuddy 的默认模型：接入器改默认模型有个让位规则——员工自己在 ~/.codebuddy/settings.json 里设过默认模型
// （比如 CodeBuddy 登录或选模型时写的），就不覆盖。之后工作台里的任务一直用那个模型，不再经过中枢（2026-10-28 虚拟机里 13:36 之后
// 网关再没有任何调用记录，员工却一直在用工作台）。所以工作台启动 CodeBuddy 时显式带上 --model <中枢模型 ID>。
//
// 只在三个条件都满足时才加，任何一个不满足就不加（不能因为一个不存在的模型 ID 让任务失败）：
//   ① 本机接入器的 profile.json 里岗位包下发了中枢模型（岗位包选「自带模型」时没有）
//   ② CodeBuddy 的 models.json 里确实有这个 ID、并且是接入器写的条目（名字带「公司中枢 · 」前缀）
//   ③ 没有设置 XHS_HUB_MODEL_FLAG=off（想临时用自己的模型时可以关）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARK = '公司中枢 · ';
const MODEL_ID = /^[\w][\w.:/-]{0,79}$/;

export function hubModelId({ env = process.env, home = os.homedir(), read = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  if (String(env.XHS_HUB_MODEL_FLAG || '').toLowerCase() === 'off') return null;
  // 测试 / 自定义数据目录：不读这台电脑上真实的接入器配置（除非明确指定了接入器目录）
  if (env.XHS_WORKSPACE && !env.HUB_AGENT_HOME) return null;
  try {
    const agentHome = env.HUB_AGENT_HOME || path.join(home, '.hub-agent');
    const id = JSON.parse(read(path.join(agentHome, 'profile.json')).replace(/^﻿/, '')).model?.model;
    if (typeof id !== 'string' || !MODEL_ID.test(id)) return null;
    // 只认 ~/.codebuddy（接入器写 models.json 的位置）；CODEBUDDY_CONFIG_DIR 可能是 WorkBuddy 沙箱注入的，工作台启动 CodeBuddy 前也会清掉它
    const cbHome = path.join(home, '.codebuddy');
    const models = JSON.parse(read(path.join(cbHome, 'models.json')).replace(/^﻿/, '')).models;
    return Array.isArray(models) && models.some((m) => m && m.id === id && String(m.name || '').startsWith(MARK)) ? id : null;
  } catch {
    return null;
  }
}

/** 给 CodeBuddy 的参数里加上 --model <中枢模型>（已经带了 --model 的不动；不是 CodeBuddy 的不动）。返回新数组。 */
export function withHubModel(adapter, args, opts) {
  if (adapter?.id !== 'codebuddy' || args.includes('--model')) return args;
  const id = hubModelId(opts);
  if (!id) return args;
  // --allowedTools / --disallowedTools 是多值参数，会把后面的参数都吞掉，所以要插在它们前面
  const multi = args.findIndex((a) => a === '--allowedTools' || a === '--disallowedTools');
  const at = multi >= 0 ? multi : args.length;
  return [...args.slice(0, at), '--model', id, ...args.slice(at)];
}
