import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTempWorkspace, server } from './helpers.mjs';
useTempWorkspace();
const store = await server('store.mjs'); store.ensureWorkspace();
const { BenchmarkQueue, collectionRoute, collectionStatus, enqueueCollection, recordCollectionObservation } = await server('benchmark-queue.mjs');
const complete = () => ({ state: 'complete', avatar: { path: 'avatar.png' }, profile: { bio: {} }, discoveredCount: 2, attemptedCount: 2, notes: [{}, {}] });

test('六目标串行，第三个中断后重启仅恢复未完成项，重复通知不重复派发', () => {
  const snapshots = new Map(); const sent = []; let busy = false;
  const opts = { accounts: () => [{ id: 'default' }], detail: (_, id) => ({ observation: snapshots.get(id) }),
    busy: () => busy, dispatch: (a, id, taskId) => { sent.push({ a, id, taskId }); busy = true; }, changed() {} };
  let queue = new BenchmarkQueue(opts);
  const ids = Array.from({ length: 6 }, (_, i) => `b_${i}`);
  enqueueCollection('default', ids); enqueueCollection('default', ids);
  queue.control('default','resume');
  for (let i = 0; i < 2; i++) {
    queue.tick(); queue.tick(); assert.equal(sent.length, i + 1);
    snapshots.set(ids[i], complete()); queue.finish(sent.at(-1).taskId); busy = false;
  }
  queue.tick(); assert.equal(sent.at(-1).id, 'b_2');
  snapshots.set('b_2', { state: 'profile', notes: [{}] });
  queue = new BenchmarkQueue(opts); busy = false; queue.recover(); queue.tick();
  assert.equal(collectionStatus('default').paused, true); assert.equal(sent.length, 3);
  queue.control('default', 'resume'); queue.tick(); assert.equal(sent.at(-1).id, 'b_2');
  for (let i = 2; i < 6; i++) {
    snapshots.set(ids[i], complete()); queue.finish(sent.at(-1).taskId); busy = false; queue.tick();
  }
  assert.equal(collectionStatus('default').items.filter(x => x.state === 'complete').length, 6);
  assert.deepEqual(sent.map(x => x.id), ['b_0', 'b_1', 'b_2', 'b_2', 'b_3', 'b_4', 'b_5']);
});

test('agent 同浏览器完整观察不再派发；部分观察暂停且整体继续可重试', () => {
  const a = store.saveAccount({ name: 'agent 测试' }).id;
  enqueueCollection(a, ['b_done', 'b_partial']);
  recordCollectionObservation(a, 'b_partial');
  const sent = [];
  let busy = true;
  const queue = new BenchmarkQueue({ accounts: () => [{ id: a }], busy: () => busy,
    detail: (_, id) => ({ observation: id === 'b_done' ? complete() : { state: 'partial', observedAt: '2099-01-01T00:00:00.000Z', reason: '头像截图失败' } }),
    dispatch: (_, id) => sent.push(id), changed() {} });
  queue.tick(); assert.equal(sent.length, 0); busy = false; queue.tick();
  assert.equal(collectionStatus(a).paused, true); assert.equal(collectionStatus(a).items[0].state, 'complete');
  queue.control(a, 'resume'); queue.tick(); assert.deepEqual(sent, ['b_partial']);
});

test('浏览器能力缺失准确暂停，不影响另一账号', () => {
  const a = store.saveAccount({ name: '阻塞测试' }).id;
  enqueueCollection(a, ['b_fail']);
  const queue = new BenchmarkQueue({ accounts: () => [{ id: a }], busy: () => false,
    detail: () => ({ observation: null }), dispatch() { throw new Error('尚未登录'); }, changed() {} });
  queue.control(a,'resume'); queue.tick(); queue.tick();
  assert.equal(collectionStatus(a).items[0].attempts, 1);
  assert.equal(collectionStatus(a).reason, '尚未登录');
  assert.equal(collectionStatus('default').paused, false);
});

test('同任务检查点早于服务合并时刻，profile 尝试仍暂停而不重复打开', async () => {
  const { recordCollectionObservation } = await server('benchmark-queue.mjs');
  const a = store.saveAccount({ name: '检查点时序' }).id;
  enqueueCollection(a, ['b_seen']);
  recordCollectionObservation(a, 'b_seen');
  const sent = [];
  const q = new BenchmarkQueue({ accounts: () => [{ id: a }], busy: () => false,
    detail: () => ({ observation: { state: 'profile', observedAt: '2000-01-01T00:00:00.000Z', reason: '等待本人登录' } }), dispatch: (_, id) => sent.push(id), changed() {} });
  q.tick(); assert.equal(sent.length, 0); assert.equal(collectionStatus(a).paused, true);
  q.control(a, 'resume'); q.tick(); assert.deepEqual(sent, ['b_seen']);
});

test('重启暂停候选 pending；曾完成后缺图的目标允许批量重新补齐', () => {
  const a = store.saveAccount({ name: '重启待办' }).id;
  enqueueCollection(a, ['b_lost']); let snapshot = complete(); const sent = [];
  const q = new BenchmarkQueue({ accounts: () => [{ id: a }], busy: () => false,
    detail: () => ({ observation: snapshot }), dispatch: (_, id) => sent.push(id), changed() {} });
  q.recover(); q.tick(); assert.equal(collectionStatus(a).paused, true); assert.equal(sent.length, 0);
  q.control(a, 'resume'); q.tick(); assert.equal(collectionStatus(a).items[0].state, 'complete');
  snapshot = { ...complete(), avatar: null };
  q.control(a, 'fill', ['b_lost']); q.tick(); assert.deepEqual(sent, ['b_lost']);
});

test('暂停后手动采集完成，整体继续清除旧失败原因且不重复派单', () => {
  const a=store.saveAccount({name:'恢复已完成'}).id;
  let snapshot={state:'partial',reason:'旧失败'};
  enqueueCollection(a,['b_resolved']);recordCollectionObservation(a,'b_resolved');
  const q=new BenchmarkQueue({accounts:()=>[{id:a}],busy:()=>false,detail:()=>({observation:snapshot}),dispatch:()=>assert.fail('不得重复派单'),changed(){}});
  q.tick();assert.equal(collectionStatus(a).paused,true);
  snapshot=complete();q.control(a,'resume');q.tick();
  assert.equal(collectionStatus(a).items[0].state,'complete');
  assert.equal(collectionStatus(a).items[0].reason,'');
});

test('新增推荐仅登记待办；明确启动后才执行且不包含后来新增目标',()=>{
 const a=store.saveAccount({name:'explicit'}).id;
 const sent=[];
 const q=new BenchmarkQueue({accounts:()=>[{id:a}],busy:()=>false,detail:()=>({observation:null}),dispatch:(_,id)=>sent.push(id),changed(){}});
 enqueueCollection(a,['b_one']);q.tick();assert.deepEqual(sent,[]);
 q.control(a,'resume');enqueueCollection(a,['b_later']);q.tick();assert.deepEqual(sent,['b_one']);
 q.finish(collectionStatus(a).items[0].taskId,'没有结果');
 assert.equal(collectionStatus(a).items[1].authorized,false);
});

test('批量采集选路：后台组件优先；WorkBuddy 插件方式走 agent；都不行才拒绝（XHS-02）', () => {
  const ready = { enabled: true, available: true, compatible: true };
  assert.equal(collectionRoute(ready, { mode: 'cli', browser: 'playwright' }), 'worker');
  assert.equal(collectionRoute({ ...ready, compatible: false }, { mode: 'cli', browser: 'workbuddy' }), 'agent');
  assert.equal(collectionRoute({ enabled: false }, { mode: 'cli', browser: 'workbuddy' }), 'agent');
  assert.equal(collectionRoute({ enabled: false }, { mode: 'cli', browser: 'playwright' }), null);
  assert.equal(collectionRoute({ enabled: false }, { mode: 'inbox', browser: 'workbuddy' }), null);
  assert.equal(collectionRoute({ enabled: false }, { mode: 'cli', browser: 'none' }), null);
});

test('节奏闸门不通过：队列暂停并写明原因、取消授权、不派发；通过后照常派发（采集间隔不在后台悄悄等到点再继续）', () => {
  const a = store.saveAccount({ name: '闸门' }).id;
  enqueueCollection(a, ['b_g1', 'b_g2']);
  const sent = []; let verdict = { ok: false, reason: '距上次访问才 20 分钟，两次采集之间至少隔 180 分钟，还要等约 160 分钟' };
  const queue = new BenchmarkQueue({ accounts: () => [{ id: a }], busy: () => false, detail: () => ({ observation: null }),
    dispatch: (_, id) => sent.push(id), changed() {}, gate: () => verdict });
  queue.control(a, 'resume');
  queue.tick();
  let q = collectionStatus(a);
  assert.equal(sent.length, 0); assert.equal(q.paused, true); assert.match(q.reason, /至少隔 180 分钟/);
  assert.ok(q.items.every((x) => x.authorized === false && x.state === 'pending'));
  queue.tick(); assert.equal(sent.length, 0);                      // 暂停着，不会自己再试
  verdict = { ok: true }; queue.control(a, 'resume'); queue.tick();  // 人再点「开始」才继续
  assert.deepEqual(sent, ['b_g1']); assert.equal(collectionStatus(a).items[0].state, 'running');
});

test('暂停采集只暂停队列，不给账号上自动访问锁（否则整个账号聊不了天）；平台限制的锁不受影响', async () => {
  const policy = await server('access-policy.mjs');
  const a = 'pause-only';
  enqueueCollection(a, ['b_x']);
  const queue = new BenchmarkQueue({ accounts: () => [{ id: a }], detail: () => ({}), busy: () => false, dispatch() {}, changed() {} });
  queue.control(a, 'pause');
  assert.equal(collectionStatus(a).paused, true);
  assert.equal(collectionStatus(a).items.every((x) => !x.authorized), true);
  assert.equal(policy.browserAccessStatus(a).kind, 'open');           // 没上锁
  assert.doesNotThrow(() => policy.assertBrowserAccess(a));           // 对话不受影响
  // 已经有平台限制时，暂停不会改动它，恢复也不会越过它
  policy.lockBrowserAccess(a, 'restriction', '用户报告平台处罚');
  queue.control(a, 'pause');
  assert.equal(policy.browserAccessStatus(a).kind, 'restriction');
  assert.throws(() => queue.control(a, 'resume'), /平台限制尚未解除/);
});
