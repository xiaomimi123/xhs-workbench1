// 对标主页观察：与用户手填/agent 分析隔离，检查点校验及头像回退。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempWorkspace, server, PNG_1PX } from './helpers.mjs';

const WS = useTempWorkspace();
const store = await server('store.mjs');
const content = await server('content.mjs');
store.ensureWorkspace();
const b = content.saveBenchmark('default', { name: '目标作者', followers: '手填 999', remark: '自己写的备注' });
const url = 'https://www.xiaohongshu.com/user/profile/abc123';
const dir = path.join(WS, 'accounts', 'default', 'benchmarks', b.id);
const pending = path.join(WS, 'accounts', 'default', 'benchmarks', 'checkpoints', 'pending');
const at = '2026-10-17T10:00:00.000Z';
store.writeJson(path.join(pending, `${b.id}.verified.json`), { id: b.id, stage: 'verified', url, xhsId: 'someone', profileName: '目标作者', followers: '3000', observedAt: at });
assert.equal(content.reconcileBenchmarkCheckpoints('default').verified, 1);
const observation = (extra = {}) => ({ id: b.id, stage: 'observation', url, xhsId: 'someone', profileName: '目标作者',
  observedAt: at, source: 'agent-visible', state: 'partial', profile: { bio: '简介', following: '42' }, ...extra });
const put = (input) => store.writeJson(path.join(pending, `${b.id}.observation.json`), input);

test('旧条目头像为空；手动上传和自动截图分开标来源', () => {
  assert.equal(content.benchmarkDetail('default', b.id).observation, null);
  assert.equal(content.listBenchmarks('default')[0].avatar, null);
  const manual = content.uploadBenchmarkAvatar('default', b.id, 'manual.png', `data:image/png;base64,${PNG_1PX.toString('base64')}`);
  assert.match(manual, /avatar-manual-/);
  assert.equal(content.listBenchmarks('default')[0].avatar.kind, 'manual');
  const captured = content.stageBenchmarkAvatar('default', b.id, PNG_1PX);
  put(observation({ avatarFile: captured, notes: [{ url: 'https://www.xiaohongshu.com/explore/abcdef123456?xsec_token=secret',
    title: '一条笔记', likes: '12', position: 0 }], discoveredCount: 1, attemptedCount: 1, state: 'complete' }));
  assert.equal(content.reconcileBenchmarkCheckpoints('default').observations, 1);
  const detail = content.benchmarkDetail('default', b.id);
  assert.equal(detail.item.avatar.kind, 'captured');
  assert.equal(detail.observation.notes[0].url, 'https://www.xiaohongshu.com/explore/abcdef123456');
  assert.equal(detail.observation.notes[0].fields.likes.value, '12');
  assert.equal(detail.observation.notes[0].fields.likes.observedAt, at);
  assert.equal(detail.observation.avatar.source, 'agent-visible');
  assert.equal(detail.item.followers, '手填 999');
  assert.equal(detail.item.observedFollowers, '3000');
  assert.equal(detail.item.remark, '自己写的备注');
});

test('笔记逐条追加；缺失新字段不伪装成刚观察到，agent 拆解数据保持独立', () => {
  store.writeJson(path.join(dir, 'notes.json'), [{ title: 'agent 分析笔记', likes: '旧值' }]);
  const later = '2026-10-17T11:00:00.000Z';
  put(observation({ observedAt: later, notes: [{ url: 'https://www.xiaohongshu.com/explore/abcdef123456', title: '同一篇新标题', position: 0 },
    { url: 'https://www.xiaohongshu.com/explore/abcdef654321', title: '另一篇', position: 1 }], state: 'partial', reason: '评论没有显示' }));
  assert.equal(content.reconcileBenchmarkCheckpoints('default').observations, 1);
  const detail = content.benchmarkDetail('default', b.id);
  assert.equal(detail.observation.notes.length, 2);
  assert.equal(detail.observation.notes[0].fields.title.value, '同一篇新标题');
  assert.equal(detail.observation.notes[0].fields.likes.value, '12');
  assert.equal(detail.observation.notes[0].fields.likes.observedAt, at);
  assert.equal(detail.observation.state, 'partial');
  assert.equal(detail.notes[0].title, 'agent 分析笔记');
  assert.equal(detail.item.avatar.kind, 'captured');
});

test('冲突/过量/站外链接/损坏头像均不覆盖旧观察', () => {
  const before = fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8');
  const cases = [
    observation({ xhsId: 'wrong' }),
    observation({ notes: [{ url: 'https://evil.example/explore/abcdef123456', title: '假' }] }),
    observation({ notes: Array.from({ length: 6 }, (_, i) => ({ url: `https://www.xiaohongshu.com/explore/abcdef${i}123456` })) }),
    observation({ observedAt: 'yesterday' }),
  ];
  for (const entry of cases) {
    put(entry);
    assert.equal(content.reconcileBenchmarkCheckpoints('default').rejected, 1);
    assert.equal(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8'), before);
  }
  fs.writeFileSync(path.join(dir, 'avatar-source-abcdef1234567890.png'), 'not-an-image');
  put(observation({ avatarFile: 'avatar-source-abcdef1234567890.png' }));
  assert.equal(content.reconcileBenchmarkCheckpoints('default').rejected, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'snapshot.json'), 'utf8'), before);
  assert.throws(() => content.uploadBenchmarkAvatar('default', b.id, 'x.svg', 'data:image/svg+xml;base64,PHN2Zz4='), /仅支持/);
  const snapshotPath = path.join(dir, 'snapshot.json');
  const corrupted = JSON.stringify({ ...JSON.parse(before), avatar: { path: 'benchmarks/b_other/avatar-captured-0123456789abcdef.png', observedAt: at, source: 'agent-visible' } });
  fs.writeFileSync(snapshotPath, corrupted);
  put(observation({ profile: { following: '99' } }));
  assert.equal(content.reconcileBenchmarkCheckpoints('default').rejected, 1);
  assert.equal(fs.readFileSync(snapshotPath, 'utf8'), corrupted);
  fs.writeFileSync(snapshotPath, before);
});

test('agent 多个独立观察检查点按序合并，任务中断前的笔记不丢失', () => {
  const batch = '67125abc';
  const checkpoint = (step, entry) => store.writeJson(path.join(pending, `${b.id}.observation-${batch}-${step}.json`), entry);
  checkpoint(0, observation({ observedAt: '2026-10-17T12:00:00.000Z', state: 'profile', profile: { following: '43' }, discoveredCount: 3 }));
  checkpoint(1, observation({ observedAt: '2026-10-17T12:01:00.000Z', profile: {}, notes: [{ url: 'https://www.xiaohongshu.com/explore/agent123456', title: '第一篇', position: 0 }], attemptedCount: 1 }));
  checkpoint(2, observation({ observedAt: '2026-10-17T12:02:00.000Z', profile: {}, notes: [{ url: 'https://www.xiaohongshu.com/explore/agent654321', title: '第二篇', position: 1 }], attemptedCount: 2 }));
  checkpoint(6, observation({ observedAt: '2026-10-17T12:03:00.000Z', state: 'partial', profile: {}, reason: '第三篇页面受限', attemptedCount: 3 }));
  assert.equal(content.reconcileBenchmarkCheckpoints('default').observations, 4);
  const saved = content.benchmarkDetail('default', b.id).observation;
  assert.equal(saved.state, 'partial');
  assert.equal(saved.notes.find((n) => n.url.endsWith('agent123456')).fields.title.value, '第一篇');
  assert.equal(saved.notes.find((n) => n.url.endsWith('agent654321')).fields.title.value, '第二篇');
  assert.equal(saved.profile.following.value, '43');
  assert.equal(saved.attemptedCount, 3);
  assert.equal(content.benchmarkCheckpointIssues('default').incomplete, 0);
});

test('不同账号不能读取或给已删除条目补观察', () => {
  const other = store.saveAccount({ name: '另一账号' });
  assert.equal(content.listBenchmarks(other.id).length, 0);
  assert.throws(() => content.uploadBenchmarkAvatar(other.id, b.id, 'x.png', PNG_1PX.toString('base64')), /不存在/);
  content.deleteBenchmark('default', b.id);
  put(observation());
  assert.equal(content.reconcileBenchmarkCheckpoints('default').rejected, 1);
});

test('缺少头像或未观察笔记列表不能声称整体 complete', () => {
  const target = content.saveBenchmark('default', { name: '不完整目标' });
  const identity = { id: target.id, url: 'https://www.xiaohongshu.com/user/profile/incomplete', xhsId: 'incomplete', profileName: '不完整目标', observedAt: at };
  store.writeJson(path.join(pending, `${target.id}.verified.json`), { ...identity, stage: 'verified' });
  content.reconcileBenchmarkCheckpoints('default');
  store.writeJson(path.join(pending, `${target.id}.observation.json`), { ...identity, stage: 'observation', source: 'agent-visible', state: 'complete', profile: { bio: '简介' } });
  content.reconcileBenchmarkCheckpoints('default');
  assert.equal(content.benchmarkDetail('default', target.id).observation.state, 'partial');
});
