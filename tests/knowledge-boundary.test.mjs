// 知识来源的分工：公司口径以中枢为准，本地 knowledge/ 只放本账号的笔记。
// 两边写法不一致时 agent 会来回矛盾（2026-10-29 测试时反复遇到），这里守住提示词、手册、模板、评论回复口径的一致。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useTempWorkspace, server } from './helpers.mjs';

useTempWorkspace();
const store = await server('store.mjs');
store.ensureWorkspace();
const { buildPrompt, hubGuidance, hubBrief, knowledgeBoundary } = await server('prompt.mjs');
const { HUB_ENV } = await server('hub-mcp.mjs');
const { EngageWorkflow } = await server('engage-workflow.mjs');
const { P } = await server('paths.mjs');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'xhs-workbench');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-boundary-'));
const hubFile = path.join(dir, 'hub-mcp.json');
fs.writeFileSync(hubFile, JSON.stringify({ mcpServers: { 'enterprise-hub': { command: 'uv', args: ['run', 'x'] } } }));
const account = { id: 'default', name: '测试号' };
const prompt = (opts) => buildPrompt({ session: { messages: [] }, account, text: '写一篇笔记', includeHistory: false, ...opts });
const withHub = (fn) => { process.env[HUB_ENV] = hubFile; try { return fn(); } finally { delete process.env[HUB_ENV]; } };

test('对话任务：带「公司口径以中枢为准」的分工，并说明热点可以联网、公司的事不能用联网代替中枢', () => {
  withHub(() => {
    const p = prompt({ allowHub: true });
    for (const must of ['公司口径以中枢为准', 'search_knowledge', '本账号的笔记', '以中枢为准', '外部信息', '不要自己改']) assert.ok(p.includes(must), must);
  });
  assert.equal(knowledgeBoundary().length, 4);
  assert.ok(hubGuidance().join('\n').includes('中枢没有这个库时如实告诉用户'));   // 「复盘总结」库不存在时不硬提交
});

test('受控任务（文案 / 封面 / 选题 / 评论 / 复盘 / 自动任务）：带简版，只读查阅，不改变输出要求，也不带「提改进建议」', () => {
  withHub(() => {
    const p = prompt({ allowHub: false, hubBrief: true });
    for (const must of ['公司口径（中枢为准，只读查阅）', 'search_knowledge', '不改变本任务的输出范围', '不要重试']) assert.ok(p.includes(must), must);
    assert.ok(!p.includes('propose_improvement'), '受控任务不提交建议');
    assert.ok(p.indexOf('公司口径') < p.indexOf('## 用户的新消息'));
    assert.ok(!p.includes('## 企业中枢'));   // 不是完整的对话指引
  });
  assert.ok(hubBrief().length >= 4);
});

test('没接中枢时提示词不变（不带任何中枢相关内容）', () => {
  assert.ok(!prompt({ allowHub: true }).includes('search_knowledge'));
  assert.ok(!prompt({ allowHub: false, hubBrief: true }).includes('search_knowledge'));
});

test('评论回复：接了中枢就不再把本地「品牌口径」当公司口径塞给 agent；没接中枢才当后备', () => {
  const kb = path.join(P.knowledge, '品牌口径');
  fs.mkdirSync(kb, { recursive: true });
  fs.writeFileSync(path.join(kb, '评论回复口径.md'), '# 回复口径\n亲，感谢支持');
  const wf = new EngageWorkflow({ submit() {} });
  assert.equal(wf.guidance('default').length, 1);                // 没接中枢：后备
  withHub(() => assert.equal(wf.guidance('default').length, 0));  // 接了中枢：以中枢为准
});

test('新装的知识库模板：不再有「品牌口径」「爆款方法论」；说明里写明公司口径在中枢', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'templates', 'knowledge', 'manifest.json'), 'utf8'));
  const dests = Object.values(manifest.files);
  assert.ok(!dests.some((d) => d.startsWith('品牌口径/') || d.startsWith('爆款方法论/')));
  for (const src of Object.keys(manifest.files)) assert.ok(fs.existsSync(path.join(root, 'templates', 'knowledge', src)), src);
  const guide = fs.readFileSync(path.join(root, 'templates', 'knowledge', 'guide.md'), 'utf8');
  assert.ok(guide.includes('公司口径在中枢') && guide.includes('以中枢为准'));
});

test('手册不再叫 agent 去本地「品牌口径 / 爆款方法论」找公司口径；都指向中枢 search_knowledge，并说明冲突以中枢为准', () => {
  const read = (f) => fs.readFileSync(path.join(root, 'playbooks', f), 'utf8');
  for (const f of ['copywriting.md', 'topics.md', 'cover.md', 'engage.md', 'video.md']) assert.ok(read(f).includes('search_knowledge'), `${f} 要指向中枢`);
  const k = read('knowledge.md');
  for (const must of ['公司口径', '以中枢为准', '本账号的笔记', '不要把公司口径类内容', 'propose_improvement']) assert.ok(k.includes(must), must);
  // 旧写法：先去本地 品牌口径/ 爆款方法论/ 找公司口径
  assert.ok(!read('copywriting.md').includes('`品牌口径/`（卖点与禁用说法）'));
  assert.ok(!read('topics.md').includes('知识库 `爆款方法论/`'));
  assert.ok(!read('video.md').includes('`爆款方法论/`（开头 3 秒'));
  assert.ok(!read('materials.md').includes('写进知识库 `爆款方法论/`'));
  assert.ok(read('README.md').includes('公司口径与本地笔记'));
});

test('知识库管家：只整理本账号笔记，不碰公司口径目录，发现可共享的只汇报不自己写', async () => {
  const { Scheduler } = await server('automation.mjs');
  const src = fs.readFileSync(path.join(root, 'server', 'automation.mjs'), 'utf8');
  assert.ok(src.includes('整理**本账号笔记**') && src.includes('公司口径以中枢为准') && src.includes('不要自己写进公司库'));
  assert.ok(Scheduler);
  const k = fs.readFileSync(path.join(root, 'playbooks', 'knowledge.md'), 'utf8');
  assert.ok(k.includes('只整理本账号的笔记') && k.includes('只在汇报里列出'));
});

test('数据复盘：中枢没有「复盘总结」库时不硬提交', () => {
  const a = fs.readFileSync(path.join(root, 'playbooks', 'analytics.md'), 'utf8');
  assert.ok(a.includes('中枢没有「复盘总结」库') && a.includes('不要换别的库硬提交'));
});

test('文案深度检查：对照中枢《违禁词与广告法》；本地词表提示以中枢为准', () => {
  const wf = fs.readFileSync(path.join(root, 'server', 'copy-workflow.mjs'), 'utf8');
  assert.ok(wf.includes('search_knowledge 查中枢《违禁词与广告法》'));
  const ui = fs.readFileSync(path.join(root, 'web', 'modules', 'copywriting.js'), 'utf8');
  assert.ok(ui.includes('最终以中枢《违禁词与广告法》为准'));
});

test('受控任务的简版不能和任务自己的限制矛盾：不说「可以联网」，也不说「提改进建议」', () => {
  const brief = hubBrief().join('\n');
  assert.ok(!brief.includes('联网'));
  assert.ok(!brief.includes('propose_improvement'));
});
