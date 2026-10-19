// 新手引导：检查清单式浮层，自动检测每一步的完成状态。纯前端，完成状态存 localStorage。
import { S, api, acc, showOverlay, currentAccount, accDirRel } from '../core.js';
import { icon } from '../icons.js';
import { esc } from '../md.js';

const KEY = 'xhs-onboarded';

function dismissed() {
  try {
    return !!localStorage.getItem(KEY);
  } catch {
    return false;
  }
}

export function dismiss() {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    /* 无痕模式 */
  }
}

/** 首次打开时自动弹出（引导页里随时可以再看） */
export function maybeAutoShow() {
  if (!dismissed()) open();
}

const PROMPTS = {
  positioning:
    '请帮我建立账号定位：先问我几个关键问题（一次一个），最后把结论整理成知识库文档，并更新账号管理里的定位信息。',
  knowledge:
    '请按 playbooks/knowledge.md 检查我的知识库，补全缺失的基础文档（账号定位、爆款方法论、笔记方法等），完成后告诉我建了哪些。',
  benchmark: `请根据我的账号定位，按 playbooks/benchmark.md 的「推荐对标账号」第一步推荐 3 个候选。不开浏览器；每得到一个就写到 ${accDirRel()}/benchmarks/checkpoints/pending/<id>.candidate.json，由工作台逐条合并；不要等全部找完再写，未核实数据留空。`,
  firstNote:
    '请结合知识库和对标拆解，按 playbooks/topics.md 给我出 3 个选题让我挑；我选定其中一个后，按 playbooks/copywriting.md 写成一篇笔记。',
};

function bridgeOk() {
  const b = S.bridge;
  return !!(b && b.configured && (b.mode === 'cli' || b.inboxOnline));
}

async function buildSteps() {
  const acc0 = currentAccount();
  const [kb, bench, notes, schedule] = await Promise.all([
    api('GET', '/api/knowledge').catch(() => ({ docs: [] })),
    api('GET', `/api/benchmarks?${acc()}`).catch(() => ({ items: [] })),
    api('GET', `/api/notes?${acc()}`).catch(() => ({ items: [] })),
    api('GET', `/api/schedule?${acc()}`).catch(() => ({ items: [] })),
  ]);
  return [
    {
      done: bridgeOk(),
      name: '连接你的 agent',
      desc: bridgeOk()
        ? 'agent 已连接，工作台里的任务都能交给它做。'
        : '还没连上 agent。回到你的 agent 会话说「运行 workbench.mjs bridge-test」重试连接，或打开连接与设置选择可用的 agent。',
      buttons: bridgeOk() ? [] : [['settings', '去连接设置']],
    },
    {
      done: !!(acc0 && acc0.positioning),
      name: '填写账号定位',
      desc: '告诉 agent 你做什么、给谁看，后面所有选题、文案都从这里出发。',
      buttons: acc0 && acc0.positioning ? [['accounts', '查看账号']] : [['prompt', PROMPTS.positioning, '让 agent 帮忙'], ['accounts', '手动填写']],
    },
    {
      done: kb.docs.length > 7, // 初始模板共 7 篇，超过说明有过沉淀
      name: '沉淀知识库',
      desc: '你的运营经验、口径、方法都存在本地知识库里，agent 写稿时会引用。',
      buttons: [['prompt', PROMPTS.knowledge, '让 agent 建知识库'], ['knowledge', '打开知识库']],
    },
    {
      done: bench.items.length > 0,
      name: '找对标并拆解',
      desc: '让 agent 推荐或自己添加想学习的账号，拆出它们的爆款规律。',
      buttons: bench.items.length ? [['benchmark', '查看对标']] : [['prompt', PROMPTS.benchmark, '让 agent 推荐'], ['benchmark', '手动添加']],
    },
    {
      done: notes.items.length > 0,
      name: '写出第一篇笔记',
      desc: '从选题到文案到封面，都在工作台里完成，违禁词和字数会实时检查。',
      buttons: notes.items.length ? [['copywriting', '打开文案']] : [['prompt', PROMPTS.firstNote, '让 agent 出选题'], ['copywriting', '直接开始写']],
    },
    {
      done: schedule.items.length > 0 || notes.items.some((n) => n.status === 'published'),
      name: '安排发布',
      desc: '把笔记排进日历，到点提醒你手动发布，或让 agent 自动发布。',
      buttons: [['schedule', '去发布排期']],
    },
  ];
}

export async function open() {
  showOverlay('<p class="muted">加载中…</p>');
  let steps;
  try {
    steps = await buildSteps();
  } catch (err) {
    showOverlay(`<h3>新手引导</h3><p class="muted">加载失败：${esc(err.message)}</p>`);
    return;
  }
  const doneCount = steps.filter((s) => s.done).length;
  const allDone = doneCount === steps.length;
  showOverlay(`
    <div class="row"><h3 style="margin:0">${icon('rocket')} 新手引导</h3><div class="muted" style="font-size:13px">${doneCount}/${steps.length} 完成</div><div class="spacer"></div>
      <button class="btn small ghost" data-onboard-skip>${allDone ? '完成' : '跳过引导'}</button></div>
    ${allDone ? '<p class="ok-line">全部完成！之后有任何问题直接在右侧和 agent 对话。</p>' : '<p class="muted" style="font-size:13px">跟着清单走一遍就能开始运营。每步都可以「让 agent 帮忙」，或自己去对应页面操作。</p>'}
    <div class="onboard-list">
      ${steps
        .map(
          (s, i) => `<div class="onboard-step${s.done ? ' done' : ''}">
        <span class="onboard-check">${s.done ? '✓' : i + 1}</span>
        <div class="onboard-body">
          <strong>${esc(s.name)}</strong>
          <div class="muted" style="font-size:13px">${esc(s.desc)}</div>
          ${s.buttons.length ? `<div class="row" style="margin-top:8px">${s.buttons.map((b) => (b[0] === 'prompt'
            ? `<button class="btn small primary" data-prompt="${esc(b[1])}">${esc(b[2])}</button>`
            : `<button class="btn small" data-nav="${b[0]}">${esc(b[1])}</button>`)).join('')}</div>` : ''}
        </div>
      </div>`,
        )
        .join('')}
    </div>
    <p class="muted" style="font-size:12px;margin-bottom:0">点「跳过引导」后不再自动弹出；随时可以在「概览」页重新打开。</p>`);

  // 全部完成时记住，不再自动弹出
  if (allDone) dismiss();
}
