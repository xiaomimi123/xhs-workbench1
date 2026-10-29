// 工作台开着就向中枢报到：只在网页开着时报、没接中枢不报、令牌过期换一次再试、不带 client / version（不覆盖接入器版本）、失败不抛出
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { useTempWorkspace, server } from './helpers.mjs';

useTempWorkspace();
const { HubHeartbeat } = await server('hub-heartbeat.mjs');

function make({ active = true, available = true, statuses = [200], tokenFails = false } = {}) {
  const calls = { fetch: [], token: [] };
  const hubGen = { available: () => available, token: async (force) => { calls.token.push(!!force); if (tokenFails) throw new Error('no token'); return { hub: 'http://hub:8088/', access_token: force ? 'fresh' : 'old' }; } };
  const queue = [...statuses];
  const fetchImpl = async (url, init) => { calls.fetch.push({ url, init }); return { status: queue.length > 1 ? queue.shift() : queue[0] }; };
  return { hb: new HubHeartbeat({ hubGen, isActive: () => active, fetchImpl }), calls };
}

test('网页开着且接了中枢：POST 到 /api/agent/heartbeat，带令牌，body 是空对象（不带 client / version / os）', async () => {
  const { hb, calls } = make();
  assert.equal(await hb.beat(), 'ok');
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.fetch[0].url, 'http://hub:8088/api/agent/heartbeat');   // 去掉多余的斜杠
  assert.equal(calls.fetch[0].init.method, 'POST');
  assert.equal(calls.fetch[0].init.headers.Authorization, 'Bearer old');
  assert.equal(calls.fetch[0].init.body, '{}');
});

test('没人在看网页 / 没接中枢：不发请求', async () => {
  let m = make({ active: false });
  assert.equal(await m.hb.beat(), 'idle'); assert.equal(m.calls.fetch.length + m.calls.token.length, 0);
  m = make({ available: false });
  assert.equal(await m.hb.beat(), 'no-hub'); assert.equal(m.calls.fetch.length + m.calls.token.length, 0);
});

test('令牌过期（401）：换新令牌再试一次；还是失败就返回状态码，不抛出', async () => {
  let m = make({ statuses: [401, 200] });
  assert.equal(await m.hb.beat(), 'ok');
  assert.deepEqual(m.calls.token, [false, true]);
  assert.equal(m.calls.fetch[1].init.headers.Authorization, 'Bearer fresh');
  m = make({ statuses: [401, 401] });
  assert.equal(await m.hb.beat(), 'http-401');
  m = make({ statuses: [500] });
  assert.equal(await m.hb.beat(), 'http-500');
});

test('拿不到令牌 / 网络出错：返回 error，不抛出（不影响工作台）', async () => {
  assert.equal(await make({ tokenFails: true }).hb.beat(), 'error');
  const hb = new HubHeartbeat({ hubGen: { available: () => true, token: async () => ({ hub: 'http://h', access_token: 't' }) }, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(await hb.beat(), 'error');
});

test('start / stop：定时器不阻止进程退出，重复 start 不会起两个', () => {
  const { hb } = make();
  hb.start(); const t = hb.timer; hb.start();
  assert.equal(hb.timer, t);
  assert.equal(typeof t.hasRef === 'function' ? t.hasRef() : false, false);
  hb.stop(); assert.equal(hb.timer, null);
});

test('server.mjs 接了心跳，并且只在有实时连接时才报', () => {
  const src = fs.readFileSync(new URL('../xhs-workbench/server/server.mjs', import.meta.url), 'utf8');
  assert.match(src, /new HubHeartbeat\(\{ hubGen, isActive: \(\) => sseClients\.size > 0 \}\)\.start\(\)/);
});
