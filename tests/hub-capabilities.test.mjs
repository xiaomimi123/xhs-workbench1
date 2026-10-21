// 企业中枢能力预检：缺浏览器能力时只拦浏览器功能；没有文件 / 文件有问题时一切照旧
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useTempWorkspace, server, fakeAdapter } from './helpers.mjs';

useTempWorkspace();
const { readHubCapabilities, browserBlockedReason, assertBrowserCapability, CAP_ENV } = await server('hub-capabilities.mjs');
const store = await server('store.mjs');
store.ensureWorkspace();
const { Bridge } = await server('bridge.mjs');
const policy = await server('access-policy.mjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cap-'));
const write = (obj, name = 'cap.json') => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return { [CAP_ENV]: f };
};
const doc = (browser, extra = {}) => ({ schema: 1, app_id: 'xhs-workbench', checkedAt: '2026-10-21T10:00:00+0800', capabilities: { browser, agent_cli: { ready: true, missing: [], fixes: [] } }, ...extra });

test('没有环境变量 / 文件不存在：不拦任何功能，也不报问题', () => {
  assert.deepEqual(readHubCapabilities({}), { present: false, problem: '' });
  assert.deepEqual(readHubCapabilities({ [CAP_ENV]: path.join(dir, 'nope.json') }), { present: false, problem: '' });
  assert.equal(browserBlockedReason({}), '');
  assert.doesNotThrow(() => assertBrowserCapability({}));
});

test('能力满足：不拦', () => {
  const env = write(doc({ ready: true, missing: [], fixes: [] }));
  assert.equal(readHubCapabilities(env).browser.ready, true);
  assert.equal(browserBlockedReason(env), '');
});

test('缺浏览器能力：拦浏览器功能，说明缺什么、怎么处理，并说明其他功能不受影响', () => {
  const env = write(doc({ ready: false, missing: ['CodeBuddy CLI', '系统浏览器'], fixes: ['npm install -g @tencent-ai/codebuddy-code', '安装 Edge'] }));
  const why = browserBlockedReason(env);
  assert.match(why, /浏览器自动化不可用/);
  assert.match(why, /CodeBuddy CLI、系统浏览器/);
  assert.match(why, /npm install -g @tencent-ai\/codebuddy-code/);
  assert.match(why, /不受影响/);
  assert.throws(() => assertBrowserCapability(env), (e) => e.status === 409 && /CodeBuddy CLI/.test(e.message));
});

test('装好后重写文件即恢复，不用重启（每次都重新读取）', () => {
  const env = write(doc({ ready: false, missing: ['CodeBuddy CLI'], fixes: [] }));
  assert.throws(() => assertBrowserCapability(env));
  write(doc({ ready: true, missing: [], fixes: [] }));
  assert.doesNotThrow(() => assertBrowserCapability(env));
});

test('文件不合法时一切照旧（不误锁用户），并给出原因', () => {
  for (const [content, problem] of [['{oops', /不是合法 JSON/], [{ schema: 2, capabilities: {} }, /格式不对/], [{ schema: 1 }, /格式不对/]]) {
    const env = write(content);
    const r = readHubCapabilities(env);
    assert.equal(r.present, false);
    assert.match(r.problem, problem);
    assert.equal(browserBlockedReason(env), '');
  }
  const big = write('x'.repeat(70 * 1024));
  assert.match(readHubCapabilities(big).problem, /过大/);
});

test('只声明命令行 agent、没有 browser 能力的应用：不拦浏览器', () => {
  const env = write({ schema: 1, capabilities: { agent_cli: { ready: false, missing: ['CodeBuddy CLI'], fixes: [] } } });
  assert.equal(browserBlockedReason(env), '');
});

test('清洗：字段截断、数量限制，未知类型当作缺失', () => {
  const env = write(doc({ ready: false, missing: Array.from({ length: 20 }, (_, i) => 'm'.repeat(100) + i), fixes: [123, null, 'ok'] }));
  const c = readHubCapabilities(env).browser;
  assert.equal(c.missing.length, 8);
  assert.ok(c.missing.every((m) => m.length <= 60));
  assert.deepEqual(c.fixes, ['ok']);
  assert.equal(readHubCapabilities(write(doc('not-an-object'))).browser, null);
});

test('桥：缺浏览器能力时，浏览器专用任务在执行前被拒绝并说明缺什么；不记成平台风控，访问锁保持打开', () => {
  store.saveBridgeConfig({ mode: 'cli', browser: 'playwright', adapter: fakeAdapter() });
  const bridge = new Bridge({ browserWorker: {}, onBenchmarkVerified() {} });
  const prev = process.env[CAP_ENV];
  process.env[CAP_ENV] = write(doc({ ready: false, missing: ['CodeBuddy CLI'], fixes: ['npm install -g @tencent-ai/codebuddy-code'] }))[CAP_ENV];
  try {
    for (const kind of ['benchmark.verify', 'browser.prepare']) {
      assert.throws(() => bridge.submit({ id: 'x', accountId: 'default', kind, prompt: 'read' }), /中枢能力检查.*CodeBuddy CLI/);
    }
    assert.equal(bridge.running.size, 0);
    assert.equal(bridge.cliQueue.length, 0);
    assert.equal(policy.browserAccessStatus('default').kind, 'open'); // 缺能力不是风控，不上锁
  } finally {
    if (prev === undefined) delete process.env[CAP_ENV]; else process.env[CAP_ENV] = prev;
  }
});
