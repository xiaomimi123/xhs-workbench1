// 「采集状态」界面：显示判定和用量、开关 / 冷静期 / 上限只通过接口改、核实主页走带闸门的任务类型
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../xhs-workbench/web/modules/benchmark.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/export /g, '');
const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function setup({ confirm = true, bridge = { mode: 'cli', browser: 'workbuddy' } } = {}) {
  const calls = []; const asks = []; const toasts = [];
  const ctx = vm.createContext({
    md: esc, esc, icon: () => '', S: { accountId: 'default', bridge, info: {} }, $: () => null,
    api: async (method, url, body) => { calls.push([method, url, body]); return method === 'GET' && url.includes('/api/benchmarks?') ? { items: [], checkpointIssues: null, collection: { items: [] }, access: { kind: 'open' } } : {}; },
    acc: (x = '') => `account=default${x ? '&' + x : ''}`, fileUrl: (x) => x, toast: (m) => toasts.push(m), fmtTime: (x) => x, ask: (...a) => asks.push(a),
    readFileAsDataURL: async () => '', accDirRel: () => 'accounts/default', confirmDialog: async () => confirm,
  });
  vm.runInContext(src, ctx);
  return { ctx, calls, asks, toasts };
}
const pace = (over = {}) => ({
  status: 'block', reason: '采集总开关是关着的：要采集先在「采集状态」里打开', enabled: false,
  limits: { notesPerDay: 10, profilesPerDay: 3, sessionNotes: 5, sessionProfiles: 2, gapMin: 180, windowStart: '09:00', windowEnd: '22:30', minNoteGapSec: 20 },
  cooldown: null, lastAt: null, lastAgoText: '没有记录', today: { notes: 4, profiles: 1, chats: 2 }, week: [], ...over,
});
const card = (ctx, p) => vm.runInContext(`V.items=[{id:'b_1',name:'A'}];V.collection={items:[{id:'b_1',state:'pending',attempts:0}]};V.access={kind:'open'};V.pace=${JSON.stringify(p)};collectionCardHtml()`, ctx);

test('状态卡片：判定、今天用量、规则、冷静期都在；开关反映服务端状态', () => {
  const { ctx } = setup();
  const off = card(ctx, pace());
  assert.match(off, /⛔ 现在不能采集/); assert.match(off, /采集总开关是关着的/);
  assert.match(off, /笔记 4\/10 篇 · 主页 1\/3 个 · 带浏览器的对话 2 次/);
  assert.match(off, /每天 09:00–22:30 · 两次采集至少隔 180 分钟 · 一次最多笔记 5 篇、主页 2 个/);
  assert.doesNotMatch(off, /data-act="pace-toggle" checked/); assert.doesNotMatch(off, /解除冷静期/);
  const on = card(ctx, pace({ status: 'go', enabled: true, reason: '今天还能读：笔记 6 篇、主页 2 个' }));
  assert.match(on, /✅ 现在可以采集/); assert.match(on, /data-act="pace-toggle" checked/);
  const cooling = card(ctx, pace({ cooldown: { until: '2026-11-02T10:00:00.000Z', reason: '账号收到平台提示', active: true } }));
  assert.match(cooling, /至 2026-11-02（生效中） · 账号收到平台提示/); assert.match(cooling, /data-act="pace-clear"/);
  assert.match(card(ctx, pace({ status: 'wait', reason: '距上次访问才 20 分钟' })), /⏳ 先别开始/);
});

test('界面上的值会被转义；太长的原因只留一句', () => {
  const { ctx } = setup();
  const html = card(ctx, pace({ reason: '<img src=x onerror=alert(1)>' + '很长'.repeat(200) }));
  assert.doesNotMatch(html, /<img src=x/); assert.match(html, /…/);
});

test('开关、冷静期、解除、上限：点了只发对应的接口请求，不直接改本地状态；取消确认就不发', async () => {
  const { ctx, calls } = setup();
  vm.runInContext('V.items=[];V.collection={items:[]};V.access={kind:"open"};V.pace=' + JSON.stringify(pace()) + ';', ctx);
  const main = { innerHTML: '', querySelectorAll: () => [{ dataset: { paceLimit: 'notesPerDay' }, type: 'number', value: '6' }, { dataset: { paceLimit: 'windowStart' }, type: 'time', value: '10:00' }], addEventListener() {} };
  ctx.main = main;
  vm.runInContext('bind(main)', ctx);
  const click = async (act, extra = {}) => { try { await main.onclick({ target: { closest: () => ({ dataset: { act }, ...extra }) } }); } catch { /* 重绘需要完整页面，这里只看发出去的请求 */ } };
  const policy = () => JSON.parse(JSON.stringify(calls.filter((c) => c[1].includes('/api/browse/policy')).map((c) => c[2])));
  await click('pace-toggle', { checked: true });
  await click('pace-cooldown');
  await click('pace-clear');
  await click('pace-limits');
  assert.deepEqual(policy(), [
    { action: 'enable' }, { action: 'set-cooldown', days: 7, reason: '账号收到平台提示' }, { action: 'clear-cooldown' },
    { action: 'set-limits', limits: { notesPerDay: 6, windowStart: '10:00' } },
  ]);
  const refused = setup({ confirm: false });
  refused.ctx.main = main; vm.runInContext('bind(main)', refused.ctx);
  for (const act of ['pace-cooldown', 'pace-clear']) { try { await main.onclick({ target: { closest: () => ({ dataset: { act } }) } }); } catch { /* 同上 */ } }
  assert.equal(refused.calls.filter((c) => c[1].includes('/api/browse/policy')).length, 0);
});

test('开始采集被服务端拒绝时，界面把原因说出来；插件方式的核实主页走 benchmark.agent（服务端过闸门、记账）', async () => {
  const { ctx, calls, asks, toasts } = setup();
  ctx.api = async (method, url, body) => {
    calls.push([method, url, body]);
    if (url.includes('/api/benchmarks/collection')) throw new Error('采集总开关是关着的：要采集先在「采集状态」里打开');
    return { items: [], checkpointIssues: null, collection: { items: [] }, access: { kind: 'open' } };
  };
  const main = { innerHTML: '', querySelectorAll: () => [], addEventListener() {} };
  ctx.main = main;
  vm.runInContext('V.items=[];V.collection={items:[]};V.access={kind:"open"};V.pace=null;V.detail={item:{id:"b_9",name:"某作者",url:"https://www.xiaohongshu.com/user/profile/abc"},screenshots:[]};V.current="b_9";bind(main)', ctx);
  const click = async (act) => { try { await main.onclick({ target: { closest: () => ({ dataset: { act } }) } }); } catch { /* 重绘 */ } };
  await click('verify');   // 先点它：后面的重新加载会清掉当前选中的对标
  const [text, send, options] = asks.at(-1);
  assert.match(text, /只读核实对标账号「某作者」/); assert.equal(send, true);
  assert.deepEqual(JSON.parse(JSON.stringify(options)), { taskKind: 'benchmark.agent', benchmarkId: 'b_9' });
  await click('collect-resume');
  assert.match(toasts.at(-1), /采集总开关是关着的/);
});
