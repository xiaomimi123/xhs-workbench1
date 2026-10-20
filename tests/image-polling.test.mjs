// 图片任务自动进度：只查询、不重新提交；没有任务编号的不调用刷新；输入时不重绘
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../xhs-workbench/web/image-polling.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/export /g, '');
const ctx = vm.createContext({});
vm.runInContext(source, ctx);
const start = (opts) => vm.runInContext('startImagePolling', ctx)(opts);

function harness(initial, { focused = false, refreshResult = (j) => ({ ...j }) } = {}) {
  const calls = { refresh: [], load: 0, draw: 0 };
  let jobs = initial;
  let t = 1_000_000;
  const queue = [];
  const opts = {
    current: () => true, jobs: () => jobs, paused: () => false, focused: () => focused,
    refresh: async (id) => { calls.refresh.push(id); return refreshResult(jobs.find((j) => j.id === id)); },
    load: async () => { calls.load++; },
    draw: () => { calls.draw++; },
    now: () => t, setTimer: (fn, ms) => { queue.push({ fn, ms }); return queue.length; }, clearTimer: () => { queue.length = 0; },
  };
  const stop = start(opts);
  const tick = async () => { const next = queue.shift(); await next.fn(); };
  return { calls, tick, queue, stop, setJobs: (j) => { jobs = j; }, advance: (ms) => { t += ms; }, now: () => t };
}
const job = (over) => ({ id: 'j1', provider: 'apimart', status: 'submitted', taskId: 'task_1', createdAt: new Date(1_000_000).toISOString(), ...over });

test('有任务编号的进行中任务：调用只读刷新，再读取记录并重绘', async () => {
  const h = harness([job()]);
  await h.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), { refresh: ['j1'], load: 1, draw: 1 });
  assert.equal(h.queue.length, 1); // 继续排下一轮
  assert.equal(h.queue[0].ms, 4000);
});

test('还在提交、没有任务编号：只重新读取记录，绝不调用刷新接口', async () => {
  const h = harness([job({ status: 'submitting', taskId: undefined })]);
  await h.tick();
  assert.deepEqual(h.calls.refresh, []);
  assert.equal(h.calls.load, 1);
});

test('不是 APIMart 或已结束的任务不发任何网络请求', async () => {
  const h = harness([job({ provider: 'current-agent' }), job({ id: 'j2', status: 'done' }), job({ id: 'j3', status: 'needs_review', taskId: undefined }), job({ id: 'j4', status: 'error' })]);
  await h.tick();
  assert.deepEqual(h.calls.refresh, []);
  assert.equal(h.calls.load, 0);
  assert.equal(h.calls.draw, 0);
  assert.equal(h.queue[0].ms, 4000); // 空闲时仍在本地低频检查，用户之后提交新任务能接上
});

test('用户在输入时只更新数据、不重绘；停止输入后补一次重绘', async () => {
  let focused = true;
  const calls = { draw: 0, load: 0 };
  const queue = [];
  const jobs = [job()];
  start({ current: () => true, jobs: () => jobs, focused: () => focused, refresh: async () => ({}), load: async () => { calls.load++; }, draw: () => { calls.draw++; }, now: () => 1_000_000, setTimer: (fn) => { queue.push(fn); }, clearTimer: () => {} });
  await queue.shift()();
  assert.deepEqual([calls.load, calls.draw], [1, 0]);
  focused = false;
  await queue.shift()();
  assert.equal(calls.draw, 1);
});

test('刷新返回错误但任务仍在进行：退避到 30 秒', async () => {
  const bad = harness([job()], { refreshResult: (j) => ({ ...j, error: '网络错误' }) });
  await bad.tick();
  assert.equal(bad.queue[0].ms, 30000);
});

test('超过 2 分钟后降为 10 秒一次；超过 30 分钟的任务不再自动查询', async () => {
  const h = harness([job()]);
  h.advance(3 * 60 * 1000);
  await h.tick();
  assert.equal(h.queue[0].ms, 10000);
  h.advance(31 * 60 * 1000);
  await h.tick();
  assert.equal(h.calls.refresh.length, 1); // 第二轮没有再查
});

test('页面不再是当前页面时停止，不再排下一轮；stop() 取消定时器', async () => {
  let isCurrent = true;
  const queue = [];
  const stop = start({ current: () => isCurrent, jobs: () => [job()], refresh: async () => ({}), load: async () => {}, draw: () => {}, now: () => 1_000_000, setTimer: (fn) => { queue.push(fn); return 1; }, clearTimer: () => { queue.length = 0; } });
  isCurrent = false;
  await queue.shift()();
  assert.equal(queue.length, 0);
  const h = harness([job()]);
  h.stop();
  assert.equal(h.queue.length, 0);
});

test('没有定时器的环境（测试沙箱）直接不轮询', () => {
  const stop = start({ current: () => true, jobs: () => [], refresh: async () => ({}), load: async () => {}, draw: () => {} });
  assert.equal(typeof stop, 'function');
});
