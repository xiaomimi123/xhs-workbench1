// 接入企业中枢 0.8.0：数据目录、访问锁位置（应用根目录之外）、运行错误回传「应用健康」
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useTempWorkspace, server } from './helpers.mjs';

useTempWorkspace();
const { resolveWorkspace } = await server('paths.mjs');
const policy = await server('access-policy.mjs');
const { accountDir } = await server('paths.mjs');
const health = await server('health-outbox.mjs');

test('数据目录：XHS_WORKSPACE 优先；已有 ~/XHS-Workbench 不搬；否则用中枢应用根目录的 data/xhs-workbench', () => {
  const home = '/h';
  const has = (...ps) => (p) => ps.includes(p);
  assert.equal(resolveWorkspace({ XHS_WORKSPACE: '/w' }, home, has()), path.resolve('/w'));
  assert.equal(resolveWorkspace({ HUB_APP_DATA_DIR: '/h/HubApps/data/xhs-workbench' }, home, has(path.join(home, 'XHS-Workbench'))), path.join(home, 'XHS-Workbench'));
  assert.equal(resolveWorkspace({ HUB_APP_DATA_DIR: '/d' }, home, has()), path.resolve('/d'));
  // agent 直接运行命令（没有中枢传的变量）时，按目录是否存在找到同一处
  const hubData = path.join(home, 'HubApps', 'data', 'xhs-workbench');
  assert.equal(resolveWorkspace({}, home, has(hubData)), hubData);
  assert.equal(resolveWorkspace({}, home, has()), path.join(home, 'XHS-Workbench'));  // 没接中枢的新用户：老位置
});

test('访问锁：有 HUB_APP_STATE_DIR 时放在它下面，第一次把旧锁原样搬过去并给旧文件改名', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-state-'));
  const legacy = path.join(accountDir('default'), 'browser-access.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ kind: 'restriction', reason: '平台处罚', source: 'workbench' }));
  process.env.HUB_APP_STATE_DIR = state;
  try {
    assert.equal(policy.browserAccessStatus('default').kind, 'restriction');  // 限制状态跟着搬过去，不会因为换位置被解除
    assert.ok(fs.existsSync(path.join(state, 'accounts', 'default', 'browser-access.json')));
    assert.ok(!fs.existsSync(legacy) && fs.existsSync(legacy + '.migrated'));
    // 之后有人改数据目录里的旧位置也没用
    fs.writeFileSync(legacy, JSON.stringify({ kind: 'open', reason: '' }));
    assert.equal(policy.browserAccessStatus('default').kind, 'restriction');
    policy.resolveBrowserRestriction('default', true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'accounts', 'default', 'browser-access.json'), 'utf8')).kind, 'open');
  } finally {
    delete process.env.HUB_APP_STATE_DIR;
    fs.rmSync(legacy, { force: true }); fs.rmSync(legacy + '.migrated', { force: true });
  }
  assert.equal(policy.stateRoot({ XHS_WORKSPACE: '/w' }, '/h', () => true), '');  // 单独使用 / 测试：不碰 ~/.hub-agent
  assert.equal(policy.stateRoot({}, '/h', (p) => p === path.join('/h', '.hub-agent', 'state', 'xhs-workbench')), path.join('/h', '.hub-agent', 'state', 'xhs-workbench'));
});

test('应用健康：写到接入器指定的文件，去隐私、归类、10 分钟去重；没接中枢或关掉时不写', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-health-'));
  const file = path.join(dir, 'logs', 'health-xhs-workbench.jsonl');
  const env = { HUB_HEALTH_OUTBOX: file, HUB_DEVICE_ID: 'dev1' };
  const home = process.platform === 'win32' ? 'C:\\Users\\张三\\x' : '/Users/zhangsan/x';
  assert.equal(health.reportHealth({ stage: 'task', ok: false, message: `自动访问已锁定：处罚 ${home} token=abc` }, { env, now: 1000 }), true);
  assert.equal(health.reportHealth({ stage: 'task', ok: false, message: `自动访问已锁定：处罚 ${home} token=abc` }, { env, now: 2000 }), false);
  assert.equal(health.reportHealth({ stage: 'doctor', ok: true, agent: 'CodeBuddy Code' }, { env, now: 3000 }), true);
  const evs = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(evs.length, 2);
  assert.equal(evs[0].code, 'ACCESS_LOCKED');
  assert.ok(!/张三|zhangsan|abc/.test(evs[0].message) && evs[0].message.includes('~'));
  assert.equal(evs[0].app_id, 'xhs-workbench');
  assert.equal(evs[0].device_id, 'dev1');
  assert.deepEqual([evs[1].ok, evs[1].code, evs[1].message, evs[1].agent], [true, 'OK', '', 'CodeBuddy Code']);
  assert.equal(health.reportHealth({ stage: 'task', ok: false, message: 'x' }, { env: {} }), false);
  assert.equal(health.reportHealth({ stage: 'task', ok: false, message: 'y' }, { env: { ...env, HUB_HEALTH: 'off' } }), false);
  assert.equal(health.classify('Error: spawn codebuddy ENOENT'), 'CLI_MISSING');
  assert.equal(health.classify('Authentication required. Please run /login'), 'CLI_NOT_LOGGED_IN');
  assert.equal(health.classify('奇怪'), 'UNKNOWN');
});
