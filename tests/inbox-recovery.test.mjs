// 收件箱任务：重启不丢、断线的等待者被清理、可退回队列、可只看不领
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempWorkspace, server } from './helpers.mjs';

const WS = useTempWorkspace();
const store = await server('store.mjs');
store.ensureWorkspace();
const { Bridge } = await server('bridge.mjs');
store.saveBridgeConfig({ mode: 'inbox' });
const file = () => path.join(WS, 'run', `inbox-${Math.random().toString(36).slice(2)}.json`);
const chatTask = (id, extra = {}) => ({ id, sessionId: 's1', accountId: 'default', prompt: `任务 ${id}`, createdAt: new Date().toISOString(), ...extra });

test('只持久化对话任务；重启后恢复为待领取，原来已被领走但没回写的也放回队列', async () => {
  const f = file();
  const a = new Bridge({ inboxFile: f });
  a.submit(chatTask('m_a'));
  a.submit(chatTask('m_b'));
  a.submit({ id: 'workflow_x', accountId: 'default', prompt: '自动工作流任务' }); // 没有 sessionId：由各工作流自己的 recover() 处理
  const claimed = await a.next(100);
  assert.equal(claimed.id, 'm_a'); // m_a 已被领走，还没回写
  const saved = JSON.parse(fs.readFileSync(f, 'utf8')).tasks;
  assert.deepEqual(saved.map((t) => t.id).sort(), ['m_a', 'm_b']);
  assert.deepEqual(saved.map((t) => t.state).sort(), ['claimed', 'pending']);

  const b = new Bridge({ inboxFile: f }); // 模拟服务重启
  assert.deepEqual(b.restored.map((t) => t.id).sort(), ['m_a', 'm_b']);
  assert.equal(b.restored.find((t) => t.id === 'm_a').wasClaimed, true);
  assert.equal(b.status().pending, 2);
  assert.equal(b.status().running, 0);
  assert.equal((await b.next(0)).id, 'm_a'); // 可以重新领取
  assert.equal(b.status().inboxOnline, true);
});

test('回写最终结果 / 报错 / 取消后，从磁盘移除；过期（>24 小时）与格式不对的任务不恢复', async () => {
  const f = file();
  const a = new Bridge({ inboxFile: f });
  a.on('error', () => {}); // 服务里有处理器；单测里补一个，EventEmitter 对无人监听的 error 会抛
  a.submit(chatTask('m_done'));
  a.submit(chatTask('m_err'));
  a.submit(chatTask('m_cancel'));
  await a.next(0); await a.next(0);
  assert.ok(a.reply('m_done', { text: '好', final: true }));
  assert.ok(a.reply('m_err', { error: '失败' }));
  assert.ok(a.cancel('m_cancel'));
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')).tasks, []);
  fs.writeFileSync(f, JSON.stringify({ tasks: [chatTask('m_old', { createdAt: new Date(Date.now() - 25 * 3600_000).toISOString() }), { prompt: '没有 id' }, chatTask('m_ok')] }));
  assert.deepEqual(new Bridge({ inboxFile: f }).restored.map((t) => t.id), ['m_ok']);
  fs.writeFileSync(f, '不是 JSON'); // 文件损坏：当作没有，不能让服务起不来
  assert.deepEqual(new Bridge({ inboxFile: f }).restored, []);
});

test('不指定 inboxFile（测试/默认）时不写盘', async () => {
  const b = new Bridge();
  b.submit(chatTask('m_mem'));
  assert.equal(b.status().pending, 1);
  assert.deepEqual(b.restored, []);
});

test('长轮询客户端断开：等待者立刻被摘掉，下一条任务不会被“领”给已经不存在的客户端', async () => {
  const b = new Bridge();
  const ac = new AbortController();
  const waiting = b.next(60_000, ac.signal);
  assert.equal(b.waiters.length, 1);
  ac.abort(); // 连接断开
  assert.equal(await waiting, null);
  assert.equal(b.waiters.length, 0);
  b.submit(chatTask('m_after'));
  assert.equal(b.status().pending, 1, '没有活着的等待者，任务应继续待领取，而不是变成 claimed 后丢失');
  assert.equal((await b.next(0)).id, 'm_after');
  // 已经 aborted 的 signal 立刻返回；正常到期不泄漏监听
  const dead = new AbortController(); dead.abort();
  assert.equal(await b.next(60_000, dead.signal), null);
  assert.equal(b.waiters.length, 0);
});

test('requeue：把领到的任务退回队列并立刻唤醒等待者；不存在的任务返回 false', async () => {
  const b = new Bridge();
  b.submit(chatTask('m_rq'));
  await b.next(0);
  assert.equal(b.status().running, 1);
  const waiting = b.next(2000); // 另一个值守在等
  assert.equal(b.requeue('m_rq'), true);
  assert.equal((await waiting).id, 'm_rq'); // 被唤醒并领到
  assert.equal(b.requeue('nope'), false);
});

test('peek：报告待领取数量和队首，不改变任何状态', async () => {
  const b = new Bridge();
  assert.deepEqual(b.peek(), { pending: 0, head: null });
  b.submit(chatTask('m_p1'));
  b.submit(chatTask('m_p2'));
  const peek = b.peek();
  assert.equal(peek.pending, 2);
  assert.equal(peek.head.id, 'm_p1');
  assert.equal(b.status().pending, 2);
  assert.equal(b.status().running, 0);
});
