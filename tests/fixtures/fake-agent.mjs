#!/usr/bin/env node
// 测试用的假 agent：从标准输入读提示词，按 FAKE_AGENT_MODE 模拟不同 agent 的输出
import fs from 'node:fs';

const mode = process.env.FAKE_AGENT_MODE || 'text';
const prompt = fs.readFileSync(0, 'utf8');
const wantsPong = prompt.includes('PONG');

// 提示词里出现 WRITE_FILE:<相对路径> 时，模拟 agent 写文件
const m = /WRITE_FILE:(\S+)/.exec(prompt);
if (m) fs.writeFileSync(m[1], `written by fake agent\n`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (mode === 'text') {
  process.stdout.write(wantsPong ? 'PONG' : `收到：${prompt.slice(-20)}`);
} else if (mode === 'claude-json') {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  out({ type: 'system', subtype: 'init', session_id: 'sess-123' });
  out({ type: 'assistant', session_id: 'sess-123', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/tmp/x.md' } }] } });
  await sleep(50);
  out({ type: 'assistant', session_id: 'sess-123', message: { content: [{ type: 'text', text: wantsPong ? 'PONG' : '第一段' }] } });
  if (!wantsPong) out({ type: 'assistant', session_id: 'sess-123', message: { content: [{ type: 'text', text: '第二段' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: wantsPong ? 'PONG' : '第二段', session_id: 'sess-123' });
} else if (mode === 'flaky') {
  // 第一次不回 PONG，第二次正常（用计数文件区分）
  const f = process.env.FAKE_AGENT_COUNTER;
  const n = Number(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : 0) + 1;
  fs.writeFileSync(f, String(n));
  process.stdout.write(n === 1 ? '嗯？' : 'PONG');
} else if (mode === 'slow') {
  process.stdout.write('开始');
  await sleep(30_000);
} else if (mode === 'fail') {
  process.stderr.write('模拟的错误信息');
  process.exit(2);
}
