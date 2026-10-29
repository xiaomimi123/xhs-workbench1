// 工作台跑的 CodeBuddy 任务显式带 --model <中枢模型>：三个条件都满足才加，任何一个不满足就不加
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTempWorkspace, server } from './helpers.mjs';

useTempWorkspace();
const { hubModelId, withHubModel } = await server('hub-model.mjs');

const files = (profile, models) => (p) => {
  const q = String(p).split(String.fromCharCode(92)).join('/');   // 反斜杠 → 斜杠（不在字符串里直接写反斜杠）
  if (q.endsWith('/profile.json') && profile !== undefined) return typeof profile === 'string' ? profile : JSON.stringify(profile);
  if (q.endsWith('/.codebuddy/models.json') && models !== undefined) return typeof models === 'string' ? models : JSON.stringify(models);
  throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
};
const HUB = { id: 'deepseek-v4-flash', name: '公司中枢 · deepseek-v4-flash' };
const opts = (profile, models, env = {}) => ({ env, home: '/home/u', read: files(profile, models) });
const CB = { id: 'codebuddy' };
const ARGS = ['-p', '--permission-mode', 'acceptEdits', '--add-dir', '/skill', '--allowedTools', 'Read', 'Glob'];

test('岗位包下发了中枢模型、models.json 里有接入器写的条目：返回模型 ID', () => {
  assert.equal(hubModelId(opts({ model: { model: 'deepseek-v4-flash' } }, { models: [{ id: 'mine', name: '我自己的' }, HUB] })), 'deepseek-v4-flash');
  assert.equal(hubModelId(opts('\uFEFF' + JSON.stringify({ model: { model: 'deepseek-v4-flash' } }), '\uFEFF' + JSON.stringify({ models: [HUB] }))), 'deepseek-v4-flash');   // 带 BOM 的文件也能读
});

test('任何一个条件不满足都返回 null（不能因为模型 ID 不对让任务失败）', () => {
  const profile = { model: { model: 'deepseek-v4-flash' } };
  assert.equal(hubModelId(opts({ model: null }, { models: [HUB] })), null);                              // 岗位包用自带模型
  assert.equal(hubModelId(opts({}, { models: [HUB] })), null);
  assert.equal(hubModelId(opts(undefined, { models: [HUB] })), null);                                    // 没有 profile.json（没装接入器）
  assert.equal(hubModelId(opts(profile, undefined)), null);                                              // 没有 models.json
  assert.equal(hubModelId(opts(profile, { models: [{ id: 'deepseek-v4-flash', name: '员工自己加的同名模型' }] })), null);   // 不是接入器写的条目
  assert.equal(hubModelId(opts(profile, { models: [{ id: 'other', name: '公司中枢 · other' }] })), null);                    // 没有这个 ID
  assert.equal(hubModelId(opts(profile, 'not json')), null);
  assert.equal(hubModelId(opts({ model: { model: '--evil; rm' } }, { models: [HUB] })), null);           // 不合法的 ID 不透传
  assert.equal(hubModelId(opts({ model: { model: 'x'.repeat(200) } }, { models: [{ id: 'x'.repeat(200), name: '公司中枢 · x' }] })), null);
});

test('XHS_HUB_MODEL_FLAG=off 可以关；测试 / 自定义数据目录不读这台电脑上真实的配置', () => {
  const ok = [{ model: { model: 'deepseek-v4-flash' } }, { models: [HUB] }];
  assert.equal(hubModelId(opts(...ok, { XHS_HUB_MODEL_FLAG: 'off' })), null);
  assert.equal(hubModelId(opts(...ok, { XHS_WORKSPACE: '/tmp/x' })), null);
  assert.equal(hubModelId(opts(...ok, { XHS_WORKSPACE: '/tmp/x', HUB_AGENT_HOME: '/agent' })), 'deepseek-v4-flash');   // 明确指定了接入器目录就读
});

test('withHubModel：只给 CodeBuddy 加，插在 --allowedTools 前面（多值参数会吞掉后面的）；已有 --model 的不动', () => {
  const o = opts({ model: { model: 'deepseek-v4-flash' } }, { models: [HUB] });
  const r = withHubModel(CB, ARGS, o);
  assert.deepEqual(r, ['-p', '--permission-mode', 'acceptEdits', '--add-dir', '/skill', '--model', 'deepseek-v4-flash', '--allowedTools', 'Read', 'Glob']);
  assert.deepEqual(ARGS.slice(0, 3), ['-p', '--permission-mode', 'acceptEdits']);               // 不改原数组
  assert.deepEqual(withHubModel(CB, ['-p', '--model', 'mine', '--allowedTools', 'Read'], o), ['-p', '--model', 'mine', '--allowedTools', 'Read']);
  assert.deepEqual(withHubModel({ id: 'claude' }, ARGS, o), ARGS);
  assert.deepEqual(withHubModel(CB, ['-p'], o), ['-p', '--model', 'deepseek-v4-flash']);        // 没有多值参数：加在最后
  assert.deepEqual(withHubModel(CB, ARGS, opts({ model: null }, { models: [HUB] })), ARGS);       // 不满足条件：原样返回
});

test('runCli 接了 withHubModel（接线检查）', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../xhs-workbench/server/bridge.mjs', import.meta.url), 'utf8');
  assert.match(src, /args = withHubModel\(adapter, args\);/);
});
