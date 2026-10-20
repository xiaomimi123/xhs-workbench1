// 把工作台里的一条消息包装成发给 agent 的完整提示词
import path from 'node:path';
import { SKILL_DIR, WORKSPACE, accountDir } from './paths.mjs';
import { materialsSummary } from './materials.mjs';

const HISTORY_LIMIT = 10;
const HISTORY_CHARS = 1500;

export function buildPrompt({ session, account, text, includeHistory }) {
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
