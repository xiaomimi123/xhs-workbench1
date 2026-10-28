// 启动底层 agent CLI 前的环境变量清理：去掉沙箱注入的配置目录、端口、本机代理
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { server } from './helpers.mjs';

const { sanitizeAgentEnv } = await server('agent-env.mjs');

test('普通环境原样保留，只去掉嵌套 Claude Code 变量', () => {
  const env = sanitizeAgentEnv({ PATH: 'x', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CODEBUDDY_CONFIG_DIR: 'C:\mine', SERVER__PORT: '9' });
  assert.equal(env.PATH, 'x');
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(env.CODEBUDDY_CONFIG_DIR, 'C:\mine'); // 没有沙箱标记时不动用户自己设的
  assert.equal(env.SERVER__PORT, '9');
});

test('在 WorkBuddy 沙箱里启动时，去掉沙箱的配置目录、端口和 WORKBUDDY_*', () => {
  const env = sanitizeAgentEnv({ PATH: 'x', WORKBUDDY_SESSION: 'a', CODEBUDDY_CONFIG_DIR: 'C:\sandbox', SERVER__PORT: '51234' });
  assert.equal(env.PATH, 'x');
  assert.equal(env.WORKBUDDY_SESSION, undefined);
  assert.equal(env.CODEBUDDY_CONFIG_DIR, undefined);
  assert.equal(env.SERVER__PORT, undefined);
});

test('在 WorkBuddy 沙箱里启动时，沙箱注入的整套 CODEBUDDY_* 全部去掉（SERVICE_PROXY_URL 会导致子进程端口冲突）', () => {
  const env = sanitizeAgentEnv({ PATH: 'x', WORKBUDDY_X: '1', CODEBUDDY_SERVICE_PROXY_URL: 'http://127.0.0.1:38126/internal/hooks/services/invoke',
    CODEBUDDY_SESSION_ID: 's', codebuddy_lower: 'y', CODEBUDDYISH: 'keep?' });
  assert.deepEqual(Object.keys(env).filter((k) => /^codebuddy_/i.test(k)), []);
  assert.equal(env.PATH, 'x');
  // 不在沙箱里时一个都不动
  assert.equal(sanitizeAgentEnv({ CODEBUDDY_SERVICE_PROXY_URL: 'u' }).CODEBUDDY_SERVICE_PROXY_URL, 'u');
});

test('沙箱里指向本机回环的代理会被去掉，真实代理保留', () => {
  const env = sanitizeAgentEnv({ WORKBUDDY_X: '1', http_proxy: 'http://127.0.0.1:7890', HTTPS_PROXY: 'http://localhost:7890', all_proxy: 'http://proxy.corp:8080' });
  assert.equal(env.http_proxy, undefined);
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.all_proxy, 'http://proxy.corp:8080');
});

test('没有沙箱标记时，用户自己的本机代理不动', () => {
  const env = sanitizeAgentEnv({ http_proxy: 'http://127.0.0.1:7890' });
  assert.equal(env.http_proxy, 'http://127.0.0.1:7890');
});

test('沙箱里 WorkBuddy 的 shim 钩子（NODE_OPTIONS / PYTHONPATH / BASH_ENV / EXEPATH / ACC_PRODUCT_CONFIG_PATH）全部去掉', () => {
  const env = sanitizeAgentEnv({ PATH: 'C:\Windows', WORKBUDDY_X: '1', NODE_OPTIONS: '--require D:/workbuddy/resources/shim/node-language-shim.cjs',
    PYTHONPATH: 'D:/workbuddy/resources/shim', BASH_ENV: 'D:/workbuddy/resources/shim/env.sh', EXEPATH: 'D:/workbuddy/x', ACC_PRODUCT_CONFIG_PATH: 'C:/tmp/acc.json', LANG: 'zh_CN' });
  for (const k of ['NODE_OPTIONS', 'PYTHONPATH', 'BASH_ENV', 'EXEPATH', 'ACC_PRODUCT_CONFIG_PATH']) assert.equal(env[k], undefined, k);
  assert.equal(env.LANG, 'zh_CN');
  assert.equal(env.PATH, 'C:\Windows');
});

test('沙箱里取值指向 workbuddy 目录的变量去掉，PATH 只剔除 workbuddy 的目录', () => {
  const sep = process.platform === 'win32' ? ';' : ':';
  const env = sanitizeAgentEnv({ WORKBUDDY_X: '1', SOME_TOOL_HOME: 'D:/workbuddy/tools', MY_VAR: 'keep',
    PATH: ['C:/Windows', 'D:/WorkBuddy/resources/bin', 'C:/nodejs'].join(sep) });
  assert.equal(env.SOME_TOOL_HOME, undefined);
  assert.equal(env.MY_VAR, 'keep');
  assert.equal(env.PATH, ['C:/Windows', 'C:/nodejs'].join(sep));
});

test('没有任何 WorkBuddy 痕迹时，NODE_OPTIONS / PYTHONPATH 等用户自己的设置不动', () => {
  const env = sanitizeAgentEnv({ PATH: 'x', NODE_OPTIONS: '--max-old-space-size=4096', PYTHONPATH: 'C:/mylib' });
  assert.equal(env.NODE_OPTIONS, '--max-old-space-size=4096');
  assert.equal(env.PYTHONPATH, 'C:/mylib');
});

test('只有 NODE_OPTIONS 指向 workbuddy 也算被它拉起（没有 WORKBUDDY_* 时）', () => {
  const env = sanitizeAgentEnv({ PATH: 'x', NODE_OPTIONS: '--require D:/workbuddy/shim.cjs', CODEBUDDY_SERVICE_PROXY_URL: 'http://127.0.0.1:1/x' });
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.CODEBUDDY_SERVICE_PROXY_URL, undefined);
});
