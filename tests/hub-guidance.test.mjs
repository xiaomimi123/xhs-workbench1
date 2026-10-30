// 接入企业中枢后：提示词带「先读公司技能 / 优先级 / 读不到就跳过 / 提改进建议」；手册开头声明对应的中枢技能
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
const { buildPrompt, hubGuidance } = await server('prompt.mjs');
const { HUB_ENV } = await server('hub-mcp.mjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-guide-'));
const file = path.join(dir, 'hub-mcp.json');
fs.writeFileSync(file, JSON.stringify({ mcpServers: { 'enterprise-hub': { command: 'uv', args: ['run', 'x'] } } }));
const account = { id: 'default', name: '测试号' };
const make = (allowHub) => buildPrompt({ session: { messages: [] }, account, text: '写一篇笔记', includeHistory: false, allowHub });

test('接入中枢的普通对话任务：带中枢指引', () => {
  process.env[HUB_ENV] = file;
  try {
    const p = make(true);
    for (const must of ['企业中枢', 'read_skill', '优先级', '不要重试', 'propose_improvement', '不要自己改', '复盘总结', '明确确认']) assert.ok(p.includes(must), must);
    assert.ok(p.indexOf('企业中枢') < p.indexOf('## 用户的新消息'));
  } finally { delete process.env[HUB_ENV]; }
});

test('受控任务 / 只读采集任务（allowHub 为 false）不带；没接中枢时也不带，提示词与以前一致', () => {
  process.env[HUB_ENV] = file;
  try { assert.ok(!make(false).includes('企业中枢')); } finally { delete process.env[HUB_ENV]; }
  assert.ok(!make(true).includes('企业中枢')); // 没有环境变量
  assert.ok(!make(undefined).includes('propose_improvement'));
});

test('指引不把提示词里的数据当指令的边界不变：指引只出现一次，且在用户消息之前', () => {
  process.env[HUB_ENV] = file;
  try { assert.equal(make(true).split('## 企业中枢').length - 1, 1); } finally { delete process.env[HUB_ENV]; }
  assert.equal(hubGuidance().length, 10);   // 标题 + 5 条中枢指引 + 4 条知识来源分工（见 knowledge-boundary.test.mjs）
});

const PLAYBOOK_SKILLS = { 'topics.md': ['xhs-topic'], 'benchmark.md': ['xhs-breakdown'], 'copywriting.md': ['xhs-writing', 'xhs-compliance'],
  'cover.md': ['xhs-cover'], 'engage.md': ['xhs-comment'], 'analytics.md': ['xhs-review'], 'publish.md': ['xhs-compliance'] };

test('手册开头声明对应的中枢技能，README 写明分工和优先级', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'xhs-workbench', 'playbooks');
  for (const [f, ids] of Object.entries(PLAYBOOK_SKILLS)) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    const line = text.split('\n').find((l) => l.includes('**中枢技能**')) || '';
    for (const id of ids) assert.ok(line.includes(id), `${f} 缺少 ${id}`);
    assert.ok(text.split('\n').slice(0, 4).join('\n').includes('中枢技能'), `${f} 的声明要在开头`);
  }
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  for (const must of ['与中枢技能的分工', '优先级', '先停下来说明', '不要重试', 'propose_improvement']) assert.ok(readme.includes(must), must);
});

test('数据复盘手册：沉淀到「复盘总结」要先问用户确认，自动任务不提交，不放他人个人信息', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'xhs-workbench', 'playbooks');
  const text = fs.readFileSync(path.join(root, 'analytics.md'), 'utf8');
  for (const must of ['沉淀到公司知识库「复盘总结」', '等用户明确说要', 'propose_improvement', 'new_doc', '未经用户确认不提交', '定时 / 自动任务', '昵称、联系方式', '账号数据']) assert.ok(text.includes(must), must);
});
