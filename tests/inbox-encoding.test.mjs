// 收件箱模式的编码兜底与“处理中也算在线”
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useTempWorkspace, server } from './helpers.mjs';

useTempWorkspace();
const store = await server('store.mjs');
store.ensureWorkspace();
const { decodeText, writeTaskFile } = await server('inbox-files.mjs');
const { Bridge } = await server('bridge.mjs');

const TEXT = '【小红书运营工作台】请回复：值守测试成功。';
const utf16le = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
const utf16be = (s) => { const b = Buffer.from(s, 'utf16le'); b.swap16(); return Buffer.concat([Buffer.from([0xfe, 0xff]), b]); };

test('回写正文自动识别编码：UTF-8、带 BOM 的 UTF-8、UTF-16 LE/BE、GBK 都能还原成同一段中文', () => {
  assert.equal(decodeText(Buffer.from(TEXT, 'utf8')), TEXT);
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(TEXT, 'utf8')])), TEXT);
  assert.equal(decodeText(utf16le(TEXT)), TEXT);
  assert.equal(decodeText(utf16be(TEXT)), TEXT);
  assert.equal(decodeText(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])), '中文'); // “中文”的 GBK 字节
  assert.equal(decodeText(Buffer.from('plain ascii')), 'plain ascii');
  assert.equal(decodeText(Buffer.alloc(0)), '');
});

test('任务正文另存为带 BOM 的 UTF-8 文件，读回与原文一致；非法任务编号被拒绝；旧文件被清理', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-'));
  try {
    const old = path.join(dir, 'task_old.md');
    fs.writeFileSync(old, 'old');
    fs.utimesSync(old, new Date(Date.now() - 8 * 24 * 3600 * 1000), new Date(Date.now() - 8 * 24 * 3600 * 1000));
    const file = writeTaskFile({ id: 'task_abc', prompt: TEXT }, { dir });
    const raw = fs.readFileSync(file);
    assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(decodeText(raw), TEXT);
    assert.equal(fs.existsSync(old), false, '超过 7 天的旧任务文件应被清理');
    assert.throws(() => writeTaskFile({ id: '../evil', prompt: 'x' }, { dir }), /任务编号无效/);
    assert.equal(fs.existsSync(path.join(dir, '..', 'evil.md')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('agent 领到任务后在处理（不再轮询）也算在线，超过 15 分钟没有任何动静才算离线', async () => {
  store.saveBridgeConfig({ mode: 'inbox' });
  const b = new Bridge();
  b.submit({ id: 'tw', sessionId: 's', accountId: 'default', prompt: 'p' });
  await b.next(1000);
  b.lastPoll = Date.now() - 5 * 60_000; // 5 分钟没轮询
  assert.equal(b.status().inboxOnline, true, '处理中不应显示离线');
  assert.equal(b.status().running, 1);
  b.tasks.get('tw').claimedAt = new Date(Date.now() - 20 * 60_000).toISOString();
  assert.equal(b.status().inboxOnline, false, '领取后 20 分钟毫无动静，视为离线');
  assert.ok(b.reply('tw', { text: '进度' })); // 回写进度刷新活动时间并刷新轮询时间
  assert.equal(b.status().inboxOnline, true);
  assert.ok(b.reply('tw', { text: '完成', final: true }));
  b.lastPoll = Date.now() - 5 * 60_000;
  assert.equal(b.status().inboxOnline, false, '任务结束且长时间没轮询：离线');
});
