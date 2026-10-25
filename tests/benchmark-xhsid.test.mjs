// 对标观察：小红书号读不到时，用主页链接 + 昵称确认身份（XHS-03，用例来自员工电脑上的回归脚本）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTempWorkspace, server } from './helpers.mjs';
useTempWorkspace();
const store = await server('store.mjs'); store.ensureWorkspace();
const { mergeObservation } = await server('benchmark-observation.mjs');

const URL_ = 'https://www.xiaohongshu.com/user/profile/6294596b0000000015018790';
const base = { stage: 'observation', id: 'b_x', url: URL_, observedAt: '2026-10-25T05:40:00Z', source: 'agent-visible', state: 'profile', profileName: '王致和' };
const item = { id: 'b_x', name: '王致和', url: URL_, xhsId: '27760725675', verifiedAt: '2026-10-25T04:00:00Z', profileName: '王致和' };
let n = 0;
const run = (entry, target = item) => { const acc = store.saveAccount({ name: `xhsid${n++}` }).id; return mergeObservation(acc, { ...target, id: entry.id }, entry); };

test('小红书号为空或没写：主页链接和昵称一致就收下，身份取已核实记录', () => {
  assert.equal(run({ ...base, xhsId: '' }).xhsId, '27760725675');
  assert.equal(run({ ...base }).xhsId, '27760725675');
  assert.equal(run({ ...base, xhsId: '', profileName: ' 王致和 ' }).xhsId, '27760725675');  // 忽略空白
});
test('小红书号有值：必须和已核实记录一致', () => {
  assert.equal(run({ ...base, xhsId: '27760725675' }).xhsId, '27760725675');
  assert.throws(() => run({ ...base, xhsId: '123456789' }), /小红书号与已核实账号不一致/);
});
test('小红书号为空且昵称不一致、主页链接不一致：拒绝，并说清原因', () => {
  assert.throws(() => run({ ...base, xhsId: '', profileName: '王致和官方' }), /没有读到小红书号，且主页昵称与已核实账号不一致/);
  assert.throws(() => run({ ...base, xhsId: '', url: 'https://www.xiaohongshu.com/user/profile/000000000000000000000000' }), /主页与已核实主页不一致/);
});
test('已核实记录没有小红书号：主页链接 + 昵称一致也能收下（主页链接是账号唯一 id）', () => {
  const noId = { ...item, xhsId: undefined };
  assert.equal(run({ ...base, xhsId: '' }, noId).xhsId, undefined);
  assert.equal(run({ ...base, xhsId: '27760725675' }, noId).xhsId, undefined);  // 检查点不能给记录补写身份
  assert.throws(() => run({ ...base, xhsId: '27760725675', profileName: '别人' }, noId), /已核实记录里没有小红书号/);
});
