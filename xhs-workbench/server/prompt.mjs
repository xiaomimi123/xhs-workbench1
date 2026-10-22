// 把工作台里的一条消息包装成发给 agent 的完整提示词
import path from 'node:path';
import { SKILL_DIR, WORKSPACE, accountDir } from './paths.mjs';
import { materialsSummary } from './materials.mjs';
import { readHubServers } from './hub-mcp.mjs';

const HISTORY_LIMIT = 10;
const HISTORY_CHARS = 1500;

/** 接入企业中枢时给 agent 的指引：先读公司技能（业务标准）、两套指引的优先级、读不到就跳过、发现问题提改进建议。 */
export function hubGuidance() {
  return [
    '## 企业中枢（公司统一的业务标准）',
    '- 各模块操作手册开头有一行「中枢技能」，写明对应的公司技能。做那个模块的事之前，先用中枢工具 list_skills / read_skill 读它，把它当作**业务标准**（口吻、选题标准、合规红线、回复原则、复盘指标）。同一会话读过就不用重复读。',
    '- 优先级：文件格式、存放位置、检查点、浏览器与账号安全、不自动发布，以操作手册为准；业务标准以公司技能为准。两者直接冲突时先停下来说明，不要自己挑一个。',
    '- 没有这些工具、没有权限或读取失败时，直接按操作手册做，不要重试，也不要因此中断。',
    '- 读了公司技能或知识库后，如果发现内容有错误、过时或缺步骤，用 propose_improvement 提交改进建议（只是建议，不要自己改；有把握才提，不是每次都提）。',
    '- 做完数据复盘后，按数据复盘手册「沉淀到公司知识库」一节：先向用户列出值得沉淀的结论并询问，用户明确确认后才用 propose_improvement 提交到「复盘总结」知识库；自动任务里不提交。',
  ];
}

export function buildPrompt({ session, account, text, includeHistory, allowHub = false }) {
  const accDir = path.relative(WORKSPACE, accountDir(account.id)) || '.';
  const accountLines = [
    `名称：${account.name}（id: ${account.id}）`,
    account.xhsId && `小红书号：${account.xhsId}`,
    account.positioning && `定位：${account.positioning}`,
    account.audience && `目标人群：${account.audience}`,
    account.style && `内容风格：${account.style}`,
    `账号数据目录：${accDir}/`,
  ].filter(Boolean);

  const parts = [
    '【小红书运营工作台 · 来自 Web 工作台的消息】',
    '你是用户本地的「小红书运营工作台」后台 agent，用户正在网页工作台里和你对话。',
    '',
    '## 环境',
    `- 技能包目录（只读）：${SKILL_DIR}`,
    `- 数据目录（当前工作目录）：${WORKSPACE}`,
    `- 各模块操作手册：${path.join(SKILL_DIR, 'playbooks')}/，做某个模块的事之前先读对应手册（索引见 playbooks/README.md）`,
    '',
    '## 当前账号',
    ...accountLines.map((l) => `- ${l}`),
    '',
    '## 规则',
    '- 用中文回复，使用 Markdown；回复会直接显示在网页对话框里，保持简洁。',
    '- 产出物（文案、拆解、知识沉淀等）写成文件存到数据目录对应位置，并在回复中写明文件路径；工作台会自动刷新显示。',
    '- 推荐只使用已有资料并登记候选待办，不自动打开浏览器，不自动接续核实或采集。用户需通过工作台明确启动只读采集；拆解与创作优先使用已落盘资料。',
    '- 发布由用户本人在官方应用手动完成。禁止代为打开发布流程、提交发布、定时发布或重试发布；仅可准备本地文案、素材、预览和提醒。',
    '- 不要删除文件；需要删除时移入数据目录下的 .trash/。',
    '- 涉及登录、验证码、支付、账号安全时停下来，请用户本人操作。',
  ];

  // 只有会带中枢工具的任务（普通对话）且确实接入了中枢时才加；受控任务和只读采集任务没有中枢工具，不加
  if (allowHub && Object.keys(readHubServers().servers).length) parts.push('', ...hubGuidance());

  const library = materialsSummary();
  if (library) {
    parts.push(
      '',
      '## 素材库（用户剪辑的参考素材）',
      '以下素材是用户标记为「值得学习模仿」的参考。写文案、做封面、出脚本时，模仿它们的选题角度、结构和节奏；需要看素材文件本体时读取 materials/files/ 下的对应文件（视频可抽帧分析）：',
      library,
    );
  }

  if (includeHistory) {
    const history = session.messages
      .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.status === 'done'))
      .slice(-HISTORY_LIMIT - 1, -1);
    if (history.length) {
      parts.push('', '## 之前的对话（节选）');
      for (const m of history) {
        const t = m.text.length > HISTORY_CHARS ? m.text.slice(0, HISTORY_CHARS) + '…（已截断）' : m.text;
        parts.push(`**${m.role === 'user' ? '用户' : '你'}**：${t}`);
      }
    }
  }

  parts.push('', '## 用户的新消息', text);
  return parts.join('\n');
}
