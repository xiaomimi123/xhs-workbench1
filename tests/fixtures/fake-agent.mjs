#!/usr/bin/env node
// 测试用的假 agent：从标准输入读提示词，按 FAKE_AGENT_MODE 模拟不同 agent 的输出
import fs from 'node:fs';
import path from 'node:path';

const mode = process.env.FAKE_AGENT_MODE || 'text';
const prompt = fs.readFileSync(0, 'utf8');
const wantsPong = prompt.includes('PONG');
if (process.env.FAKE_AGENT_AUDIT_DIR) {
  fs.mkdirSync(process.env.FAKE_AGENT_AUDIT_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.FAKE_AGENT_AUDIT_DIR, `${Date.now()}-${process.pid}.json`),
    JSON.stringify({ args: process.argv.slice(2), prompt }));
}

// P0 推荐端到端 fixture：模拟 agent 只落候选，后续由真实服务队列接续。
if (prompt.includes('BENCHMARK_AUTO_FIXTURE')) {
  const pending = path.join(process.env.XHS_WORKSPACE, 'accounts/default/benchmarks/checkpoints/pending');
  fs.mkdirSync(pending, { recursive: true });
  fs.writeFileSync(path.join(pending, 'b_auto.candidate.json'), JSON.stringify({ stage: 'candidate', id: 'b_auto', name: '自动目标' }));
}

// 选题流水线 fixture：只写任务指定的暂存结果，正式入库由真实服务校验。
if (prompt.includes('这是工作台受控内容任务')) {
  const inputPath=/读取 (.+?topicjob_[\w-]+\.input\.json)。/.exec(prompt)?.[1];
  const outputPath=/写到 (.+?topicjob_[\w-]+\.result\.json)/.exec(prompt)?.[1];
  if(inputPath&&outputPath) {
    const input=JSON.parse(fs.readFileSync(inputPath,'utf8'));
    const result=input.source?{topics:[{title:'隔离演示：把灵感变成检查清单',angle:'给小团队可执行步骤',reason:'来自已采集资料，未核实实时热度',sourceUrls:[input.source.notes[0].url]}]}:{title:'把灵感变成行动',content:'先明确目标，再整理现有素材。用一份检查清单记录缺口，逐项确认后开始制作。这是实践建议，不代表已经完成产品实测。',tags:['内容创作']};
    fs.writeFileSync(outputPath,JSON.stringify(result));
  }
}

if (prompt.includes('这是工作台受控文案任务')) {
 const inputPath=/读取 (.+?copyjob_[\w-]+\.input\.json)/.exec(prompt)?.[1];
 const outputPath=/写到 (.+?copyjob_[\w-]+\.result\.json)/.exec(prompt)?.[1];
 if(inputPath&&outputPath){
  const input=JSON.parse(fs.readFileSync(inputPath,'utf8'));
  const result=prompt.includes('结果 JSON：{"titles"')?{titles:['一','二','三','四','五'].map(x=>({title:'检查清单'+x,reason:'对应正文'}))}:prompt.includes('结果 JSON：{"summary"')?{summary:'建议核实事实',issues:[],unverified:['资料中的产品效果']}: {content:'先写目标，再逐项复核。这是修改后的检查清单。',tags:['审片']};
  fs.writeFileSync(outputPath,JSON.stringify(result));
 }
}

if(prompt.includes('这是工作台受控封面任务')) {
 const inputPath=/读取 (.+?coverjob_[\w-]+\.input\.json)/.exec(prompt)?.[1];
 const outputPath=/写到 (.+?coverjob_[\w-]+\.result\.json)/.exec(prompt)?.[1];
 if(inputPath&&outputPath)fs.writeFileSync(outputPath,JSON.stringify({specs:['目标','反馈','复核'].map(title=>({template:'list',palette:'blue',title,items:['写清目标','逐项核对'],subtitle:'审片清单',badge:'步骤',emphasis:[],image:''}))}));
}

if(prompt.includes('这是工作台受控复盘任务')) {
 const inputPath=/读取 (.+?reviewjob_[\w-]+\.input\.json)/.exec(prompt)?.[1];
 const outputPath=/写入 (.+?reviewjob_[\w-]+\.result\.json)/.exec(prompt)?.[1];
 if(inputPath&&outputPath){const input=JSON.parse(fs.readFileSync(inputPath,'utf8'));const sourceIds=[input.rows[0].id];fs.writeFileSync(outputPath,JSON.stringify({summary:'历史样本观察',observations:[{text:'样本仅供参考',sourceIds}],hypotheses:['需要更多样本'],experiments:['验证新角度'],suggestions:[{title:'复盘后的新角度',angle:'实践检查清单',reason:'历史样本启发，需验证',sourceIds}]}));}
}

if(prompt.includes('这是工作台受控回复审核任务')){
 const inputPath=/读取 (.+?replyjob_[\w-]+\.input\.json)/.exec(prompt)?.[1];
 const outputPath=/写入 (.+?replyjob_[\w-]+\.result\.json)/.exec(prompt)?.[1];
 if(inputPath&&outputPath){const input=JSON.parse(fs.readFileSync(inputPath,'utf8'));fs.writeFileSync(outputPath,JSON.stringify({replies:input.messages.map(m=>({itemId:m.itemId,category:'咨询',action:m.incomplete?'human':'reply',reason:'先核对具体问题',draft:'你想了解哪一步？可以补充具体问题。',sourceIds:[m.itemId],unverified:[]}))}));}
}

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
} else if (mode === 'checkpoint-slow') {
  const dir = path.join(process.env.XHS_WORKSPACE, 'accounts', 'default', 'benchmarks', 'checkpoints', 'pending');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'b_timeout.candidate.json'), JSON.stringify({
    id: 'b_timeout', stage: 'candidate', name: '超时前已保存', remark: '尚未核实',
  }));
  fs.writeFileSync(path.join(dir, 'b_verified.candidate.json'), JSON.stringify({
    id: 'b_verified', stage: 'candidate', name: '已确认候选',
  }));
  fs.writeFileSync(path.join(dir, 'b_verified.verified.json'), JSON.stringify({
    id: 'b_verified', stage: 'verified', url: 'https://www.xiaohongshu.com/user/profile/123abc',
    profileName: '已确认候选', followers: '3000', observedAt: '2026-10-17T05:00:00.000Z',
  }));
  fs.writeFileSync(path.join(dir, 'b_half.candidate.json'), '{"stage": "candidate",');
  process.stdout.write('已写入一条候选，继续查找');
  await sleep(30_000);
} else if (mode === 'fail') {
  process.stderr.write('模拟的错误信息');
  process.exit(2);
}
