// 参考视频描述：冻结输入、看图自检（两阶段）、拼图、校验、恢复
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempWorkspace, server } from './helpers.mjs';

useTempWorkspace();
const store = await server('store.mjs');
store.ensureWorkspace();
const { VideoDescriptionWorkflow } = await server('video-description-workflow.mjs');
const { createChallenge, gradeAnswer, readQuadrants, encodeQuadrantPng, QUADRANTS } = await server('vision-challenge.mjs');
const a = store.saveAccount({ name: 'description' }).id;
const tasks = [];
const card = new URL('./fixtures/card.png', import.meta.url);
const refs = {
  read: () => ({ hash: 'abc', media: { duration: 5 } }),
  frames: async (_a, _id, dir) => { fs.mkdirSync(dir, { recursive: true }); const p = path.join(dir, 'frame.jpg'); fs.copyFileSync(card, p); return [{ time: 0, path: p }]; },
};
// 每个用例用全新的工作流，并清掉看图自检缓存，避免用例之间互相影响
const make = (overrides = {}) => {
  const w = new VideoDescriptionWorkflow({ references: refs, submit: (t) => tasks.push(t), ...overrides });
  fs.rmSync(w.visionCache(a), { force: true });
  return w;
};
const checkId = (j) => `${j.id}-check`;
const answer = (w, j, visionCheck) => { fs.writeFileSync(j.checkFile, JSON.stringify({ visionCheck: visionCheck ?? w.find(a, j.id).visionExpected })); };
// 让看图自检通过，进入第二阶段
const passCheck = (w, j) => { answer(w, j); w.finish(checkId(j)); };
const goodResult = (j) => fs.writeFileSync(j.outputFile, JSON.stringify({ prompt: '主体拿起产品，镜头固定', observations: [{ time: 0, description: '产品位于桌上' }], limitations: ['抽帧无法确定完整运动'] }));
const wrongAnswer = (expected) => ({ ...expected, topLeft: expected.topLeft === '红' ? '蓝' : '红' });

test('生成描述：先做看图自检，通过后才提交真正的分析任务；原描述与冻结输入不被改动', async () => {
  const w = make();
  const j = await w.start(a, { kind: 'generate', sourceVideoId: 'vref_fixture', prompt: 'original', instruction: 'replace cup' });
  assert.equal(j.status, 'checking');
  assert.equal(tasks.at(-1).id, checkId(j));
  assert.equal(tasks.at(-1).timeoutMs, 180000);
  assert.match(tasks.at(-1).prompt, /看图自检/);
  assert.match(tasks.at(-1).prompt, /view_image/);
  const input = JSON.parse(fs.readFileSync(j.inputFile));
  assert.equal(input.prompt, 'original');
  assert.equal(input.frames.length, 1);
  const before = tasks.length;
  passCheck(w, j);
  assert.equal(w.find(a, j.id).status, 'queued');
  assert.equal(tasks.length, before + 1);
  assert.equal(tasks.at(-1).id, j.id);
  assert.match(tasks.at(-1).prompt, /view_image/);
  assert.doesNotMatch(tasks.at(-1).prompt, /visionCheck/); // 第二阶段不再提自检
  w.progress(j.id);
  assert.equal(w.find(a, j.id).status, 'running');
  goodResult(w.find(a, j.id));
  w.finish(j.id);
  const done = w.find(a, j.id);
  assert.equal(done.status, 'done');
  assert.equal(done.result.prompt, '主体拿起产品，镜头固定');
  assert.equal(done.visionCheck.passed, true);
  assert.equal(JSON.parse(fs.readFileSync(j.inputFile)).prompt, 'original');
  assert.throws(() => w.find('default', j.id));
});

test('优化现有描述不看图，所以不做自检，直接提交', async () => {
  const w = make();
  const optimized = await w.start(a, { kind: 'optimize', prompt: '拿起产品喝' });
  assert.equal(optimized.status, 'queued');
  assert.equal(tasks.at(-1).id, optimized.id);
  assert.equal(JSON.parse(fs.readFileSync(optimized.inputFile, 'utf8')).visionCheck, undefined);
  await assert.rejects(w.start(a, { kind: 'optimize', prompt: '' }));
  await assert.rejects(w.start(a, { kind: 'generate' }));
});

test('rejects invalid result, preserves original, recovers interrupted tasks', async () => {
  const w = make();
  const j = await w.start(a, { kind: 'optimize', prompt: '保留原描述' });
  fs.writeFileSync(j.outputFile, JSON.stringify({ prompt: '', observations: [], limitations: [] }));
  w.finish(j.id);
  assert.equal(w.find(a, j.id).status, 'error');
  const next = await w.start(a, { kind: 'optimize', prompt: 'new' });
  const recovered = make();
  recovered.recover();
  assert.equal(recovered.find(a, next.id).status, 'error');
  assert.match(recovered.find(a, next.id).error, /重启/);
  // 检测阶段被中断的任务同样恢复为错误
  const checking = await make().start(a, { kind: 'generate', sourceVideoId: 'vref_recover', prompt: '', instruction: '中断' });
  assert.equal(checking.status, 'checking');
  const again = make();
  again.recover();
  assert.equal(again.find(a, checking.id).status, 'error');
});

test('有拼图时：分析任务只要求读拼图（不再逐帧读 12 张），拼图进入冻结输入并受哈希校验；超时放宽到 300 秒', async () => {
  const sheetRefs = { ...refs, contactSheets: async (_frames, dir) => { fs.mkdirSync(dir, { recursive: true }); const p = path.join(dir, 'sheet-1.jpg'); fs.copyFileSync(card, p); return [{ path: p, times: [0], columns: 3 }]; } };
  const w = make({ references: sheetRefs });
  const j = await w.start(a, { kind: 'generate', sourceVideoId: 'vref_sheets', prompt: '', instruction: '换产品' });
  passCheck(w, j);
  const task = tasks.at(-1);
  assert.equal(task.timeoutMs, 300000);
  assert.match(task.prompt, /view_image/);
  assert.match(task.prompt, /input\.sheets 里的拼图/);
  assert.match(task.prompt, /不要再逐张读 input\.frames/);
  const input = JSON.parse(fs.readFileSync(j.inputFile, 'utf8'));
  assert.equal(input.sheets.length, 1);
  assert.match(input.sheets[0].hash, /^[0-9a-f]{64}$/);
  goodResult(j);
  fs.appendFileSync(input.sheets[0].path, 'x');
  w.finish(j.id);
  assert.equal(w.find(a, j.id).status, 'error');
  assert.match(w.find(a, j.id).error, /拼图已改变/);
});

test('没有拼图（拼图失败或旧环境）：退回逐帧查看的原提示词', async () => {
  const w = make();
  const j = await w.start(a, { kind: 'generate', sourceVideoId: 'vref_nosheets', prompt: '', instruction: '换产品2' });
  passCheck(w, j);
  assert.match(tasks.at(-1).prompt, /逐一查看 input\.frames 的图片/);
  assert.doesNotMatch(tasks.at(-1).prompt, /input\.sheets/);
});

// ── 看图自检 ──
test('自检题：随机排布且四象限颜色互不相同，PNG 可被解码还原', () => {
  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    const { png, expected } = createChallenge();
    assert.equal(new Set(Object.values(expected)).size, 4);
    assert.deepEqual(readQuadrants(png), expected);
    seen.add(JSON.stringify(expected));
  }
  assert.ok(seen.size > 5, '排布必须随机，不能每次一样');
  assert.deepEqual(readQuadrants(encodeQuadrantPng(['蓝', '黄', '红', '绿'])), { topLeft: '蓝', topRight: '黄', bottomLeft: '红', bottomRight: '绿' });
});

test('判分：必须 4/4 才算通过；缺答、乱答、“看不到”都算错', () => {
  const expected = { topLeft: '红', topRight: '绿', bottomLeft: '蓝', bottomRight: '黄' };
  assert.equal(gradeAnswer(expected, expected).passed, true);
  const g = gradeAnswer(expected, { topLeft: '红', topRight: '看不到', bottomLeft: '红' });
  assert.equal(g.passed, false);
  assert.equal(g.correct, 1);
  assert.deepEqual(g.wrong.map((x) => x.quadrant), ['topRight', 'bottomLeft', 'bottomRight']);
  assert.equal(g.wrong[2].answered, '（没有回答）');
  assert.equal(gradeAnswer(expected, undefined).correct, 0);
});

test('自检题进入冻结输入，期望答案只存在任务记录里，不在 input.json 里', async () => {
  const w = make();
  const j = await w.start(a, { kind: 'generate', sourceVideoId: 'vref_vision1', prompt: '', instruction: '换产品' });
  const input = JSON.parse(fs.readFileSync(j.inputFile, 'utf8'));
  assert.ok(fs.existsSync(input.visionCheck.path));
  assert.match(input.visionCheck.hash, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(input).includes('visionExpected'), false);
  assert.deepEqual(Object.keys(w.find(a, j.id).visionExpected).sort(), [...QUADRANTS].sort());
});

test('自检答错：立刻停止，不提交分析任务，说明哪个象限答错，不留结果，也不写入通过缓存', async () => {
  const w = make();
  const j = await w.start(a, { kind: 'generate', sourceVideoId: 'vref_vision3', prompt: '', instruction: '答错' });
  const submitted = tasks.length;
  answer(w, j, wrongAnswer(w.find(a, j.id).visionExpected));
  w.finish(checkId(j));
  const failed = w.find(a, j.id);
  assert.equal(failed.status, 'error');
  assert.equal(failed.result, undefined);
  assert.equal(tasks.length, submitted, '自检没过就不该再花几分钟去分析');
  assert.match(failed.error, /没有通过看图自检/);
  assert.match(failed.error, /只答对了 3 个/);
  assert.match(failed.error, /左上应为/);
  assert.match(failed.error, /写出的描述很可能是编造的，已丢弃/);
  assert.match(failed.error, /换成支持图像理解的 Agent 或模型/);
  assert.equal(failed.visionCheck.passed, false);
  assert.equal(fs.existsSync(w.visionCache(a)), false);
});

test('自检没作答 / 没写结果文件 / Agent 报错：同样终止并给出可读原因', async () => {
  const w = make();
  const none = await w.start(a, { kind: 'generate', sourceVideoId: 'vref_vision4', prompt: '', instruction: '没作答' });
  fs.writeFileSync(none.checkFile, JSON.stringify({}));
  w.finish(checkId(none));
  assert.match(w.find(a, none.id).error, /只答对了 0 个/);
  const missing = await w.start(a, { kind: 'generate', sourceVideoId: 'vref_vision4b', prompt: '', instruction: '没文件' });
  w.finish(checkId(missing));
  assert.match(w.find(a, missing.id).error, /看图自检没有得到结果/);
  const crashed = await w.start(a, { kind: 'generate', sourceVideoId: 'vref_vision4c', prompt: '', instruction: '报错' });
  w.finish(checkId(crashed), '超时（120 秒）未完成');
  assert.match(w.find(a, crashed.id).error, /超时/);
});

test('自检图片被改动后结果被拒绝', async () => {
  const w = make();
  const j = await w.start(a, { kind: 'generate', sourceVideoId: 'vref_vision5', prompt: '', instruction: '篡改' });
  const input = JSON.parse(fs.readFileSync(j.inputFile, 'utf8'));
  answer(w, j);
  fs.appendFileSync(input.visionCheck.path, 'x');
  w.finish(checkId(j));
  assert.match(w.find(a, j.id).error, /看图自检图片已改变/);
});

test('通过后缓存 12 小时：之后的描述任务跳过自检直接分析；换了 agent（key 变化）或过期后重新检测', async () => {
  let key = 'agent-A';
  let t = 1_000_000_000_000;
  const w = make({ visionKey: () => key, now: () => t });
  const first = await w.start(a, { kind: 'generate', sourceVideoId: 'vref_cache1', prompt: '', instruction: '一' });
  assert.equal(first.status, 'checking');
  passCheck(w, first);
  const second = await w.start(a, { kind: 'generate', sourceVideoId: 'vref_cache2', prompt: '', instruction: '二' });
  assert.equal(second.status, 'queued'); // 跳过自检
  assert.equal(tasks.at(-1).id, second.id);
  assert.equal(w.find(a, second.id).visionCheck.cached, true);
  key = 'agent-B';
  const swapped = await w.start(a, { kind: 'generate', sourceVideoId: 'vref_cache3', prompt: '', instruction: '三' });
  assert.equal(swapped.status, 'checking'); // 换了 agent，重新检测
  key = 'agent-A';
  t += 13 * 3600 * 1000;
  const expired = await w.start(a, { kind: 'generate', sourceVideoId: 'vref_cache4', prompt: '', instruction: '四' });
  assert.equal(expired.status, 'checking'); // 缓存过期
});

test('自检答案优先取 Agent 最终回复里的 JSON（少一次写文件的往返）；回复里没有再退回 check.json', async () => {
  const w = make();
  const j = await w.start(a, { kind: 'generate', sourceVideoId: 'vref_reply1', prompt: '', instruction: '回复' });
  assert.match(tasks.at(-1).prompt, /不要写任何文件/);
  assert.match(tasks.at(-1).prompt, /最终回复里只输出一行 JSON/);
  assert.equal(tasks.at(-1).timeoutMs, 180000);
  const expected = w.find(a, j.id).visionExpected;
  w.finish(checkId(j), '', `好的，我看到了：\n${JSON.stringify({ visionCheck: expected })}\n以上。`);
  assert.equal(w.find(a, j.id).status, 'queued'); // 通过，进入第二阶段
  // 回复不是 JSON 时，退回读文件
  const w3 = make();
  const k3 = await w3.start(a, { kind: 'generate', sourceVideoId: 'vref_reply3', prompt: '', instruction: '回复3' });
  answer(w3, k3);
  w3.finish(checkId(k3), '', '我看了图，但没有按格式回复');
  assert.equal(w3.find(a, k3.id).status, 'queued');
  // 回复和文件都没有：给出可读原因
  const k4 = await make().start(a, { kind: 'generate', sourceVideoId: 'vref_reply4', prompt: '', instruction: '回复4' });
  const w4 = make();
  w4.index.set(k4.id + '-check', a);
  w4.finish(checkId(k4), '', '没有 JSON');
  assert.match(w4.find(a, k4.id).error, /看图自检没有得到结果/);
  // 回复里的 JSON 答错：照样判不通过
  const k5 = await make().start(a, { kind: 'generate', sourceVideoId: 'vref_reply5', prompt: '', instruction: '回复5' });
  const w5 = make();
  w5.index.set(k5.id + '-check', a);
  const exp5 = w5.find(a, k5.id).visionExpected;
  w5.finish(checkId(k5), '', JSON.stringify({ visionCheck: wrongAnswer(exp5) }));
  assert.match(w5.find(a, k5.id).error, /没有通过看图自检/);
});
