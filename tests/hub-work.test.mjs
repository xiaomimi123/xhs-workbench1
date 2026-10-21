// 企业中枢成果上报：关键产出写到本机 outbox，由接入器转发；没接入中枢时什么都不做
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useTempWorkspace, server } from './helpers.mjs';

useTempWorkspace();
const { reportWork, WORK_ENV } = await server('hub-work.mjs');
const store = await server('store.mjs');
store.ensureWorkspace();
const content = await server('content.mjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-work-'));
const outbox = path.join(dir, 'xhs-workbench.jsonl');
const lines = () => (fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const reset = () => fs.rmSync(outbox, { force: true });

test('没有环境变量：不写任何文件，也不报错', () => {
  assert.equal(reportWork({ key: 'k', title: 't' }, {}), false);
  assert.equal(lines().length, 0);
});

test('写入前清洗：缺 key / 标题不写；非 http 链接（本机路径）丢掉；字段截断；未知状态当已完成', () => {
  const env = { [WORK_ENV]: outbox };
  assert.equal(reportWork({ key: '', title: 't' }, env), false);
  assert.equal(reportWork({ key: 'k', title: '' }, env), false);
  assert.equal(reportWork({ key: 'k', title: 'x'.repeat(500), kind: 'y'.repeat(50), link: 'C:\Users\a\secret.txt', note: 'n'.repeat(999), status: '乱写', extra: 'secret' }, env), true);
  const [l] = lines();
  assert.equal(l.title.length, 120);
  assert.equal(l.kind.length, 20);
  assert.equal(l.note.length, 300);
  assert.equal(l.status, '已完成');
  assert.equal(l.progress, 100);
  assert.ok(!('link' in l) && !('extra' in l));
  reset();
  reportWork({ key: 'k', title: 't', link: 'https://www.xiaohongshu.com/explore/1', status: '待审核' }, env);
  assert.deepEqual(lines()[0], { key: 'k', title: 't', kind: '其他', status: '待审核', progress: 0, link: 'https://www.xiaohongshu.com/explore/1' });
  reset();
});

test('目录不存在等写入失败：吞掉错误，返回 false', () => {
  assert.equal(reportWork({ key: 'k', title: 't' }, { [WORK_ENV]: path.join(dir, 'no', 'such', 'dir', 'x.jsonl') }), false);
});

test('笔记：新建、状态变化时上报；内容修改不重复上报；不含正文', () => {
  reset();
  process.env[WORK_ENV] = outbox;
  try {
    const n = content.saveNote('default', { create: true, title: '秋季护肤', content: '这是不该出现在上报里的正文' });
    assert.deepEqual(lines().map((l) => [l.key, l.status, l.progress]), [[`note:default:${n.id}`, '进行中', 30]]);
    content.saveNote('default', { id: n.id, content: '改了正文，状态没变' });
    assert.equal(lines().length, 1);
    content.saveNote('default', { id: n.id, status: 'ready' });
    content.saveNote('default', { id: n.id, status: 'published', publishedUrl: 'https://www.xiaohongshu.com/explore/abc' });
    const all = lines();
    assert.deepEqual(all.map((l) => l.status), ['进行中', '待审核', '已完成']);
    assert.equal(all[2].link, 'https://www.xiaohongshu.com/explore/abc');
    assert.ok(all.every((l) => l.title === '笔记：秋季护肤' && l.key === all[0].key));
    assert.ok(!fs.readFileSync(outbox, 'utf8').includes('正文'));
  } finally {
    delete process.env[WORK_ENV];
  }
});

test('对标：拆解完成时上报一次，再次拆解（analyzedAt 变了）更新同一条', () => {
  reset();
  process.env[WORK_ENV] = outbox;
  try {
    const b = content.saveBenchmark('default', { name: '程序员八阿哥' });
    assert.equal(lines().length, 0);
    content.saveBenchmark('default', { id: b.id, status: 'analyzed', analyzedAt: '2026-10-21T10:00:00Z', summary: '摘要' });
    content.saveBenchmark('default', { id: b.id, remark: '改备注' });
    assert.equal(lines().length, 1);
    content.saveBenchmark('default', { id: b.id, analyzedAt: '2026-10-22T10:00:00Z' });
    const all = lines();
    assert.equal(all.length, 2);
    assert.ok(all.every((l) => l.key === `benchmark:default:${b.id}` && l.kind === '对标报告' && l.status === '已完成' && l.title === '对标拆解：程序员八阿哥'));
  } finally {
    delete process.env[WORK_ENV];
  }
});
