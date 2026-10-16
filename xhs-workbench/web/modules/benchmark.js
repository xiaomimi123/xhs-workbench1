// 竞品对标：录入对标账号 → agent 拆解（报告 + 笔记数据）→ 生成选题 / 沉淀知识库
import { md, esc } from '../md.js';
import { icon } from '../icons.js';
import { S, $, api, acc, fileUrl, toast, fmtTime, ask, readFileAsDataURL, accDirRel } from '../core.js';

const V = { items: [], current: null, detail: null, tab: 'report', form: null, cfg: null, showRadar: false };

function benchDir(id) {
  return `${accDirRel()}/benchmarks/${id}/`;
}

const STATUS = { pending: ['待拆解', ''], analyzing: ['拆解中', 'warn'], analyzed: ['已拆解', 'brand'] };

async function load() {
  V.items = (await api('GET', `/api/benchmarks?${acc()}`)).items;
  V.cfg = await api('GET', `/api/automation?${acc()}`);
  if (V.current) {
    V.detail = V.items.some((b) => b.id === V.current) ? await api('GET', `/api/benchmarks/detail?${acc(`id=${V.current}`)}`) : null;
    if (!V.detail) V.current = null;
  }
}

/** 看过追踪结果：清掉新笔记提醒（不依赖列表是否已加载，从提醒直接进详情也要生效） */
async function markSeen(id) {
  const b = V.items.find((x) => x.id === id);
  if (b && !b.newCount && !b.radarNote) return;
  await api('POST', `/api/benchmarks/seen?${acc()}`, { id }).catch(() => {});
  if (b) {
    b.newCount = 0;
    delete b.radarNote;
  }
}

export async function render(main, params = {}) {
  if (params.id) {
    V.current = params.id;
    V.tab = 'report';
    V.form = null;
    await markSeen(params.id); // 从提醒点进来 = 看过，清掉新笔记角标
  }
  if (V.accountId !== S.accountId) {
    V.accountId = S.accountId;
    V.current = params.id || null;
    V.form = null;
  }
  main.innerHTML = '<div class="empty">加载中…</div>';
  try {
    await load();
  } catch (err) {
    main.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  draw(main);
}

export async function onContent(ev) {
  if (ev.area !== 'benchmarks' || V.form) return;
  await load();
  draw($('#main'));
}

function draw(main) {
  if (V.current && V.detail) return drawDetail(main);
  const cards = V.items
    .map((b) => {
      const [label, cls] = STATUS[b.status] || STATUS.pending;
      return `<div class="card quick-card" data-bench="${esc(b.id)}">
        <div class="row"><h3 style="margin:0">${esc(b.name)}</h3>
          ${b.newCount ? `<span class="badge brand">新 ${b.newCount}</span>` : ''}
          <span class="badge ${cls}">${label}</span></div>
        <p class="muted" style="margin:6px 0 0">${[b.xhsId && `小红书号 ${esc(b.xhsId)}`, b.followers && `粉丝 ${esc(b.followers)}`, b.noteCount && `已采集 ${b.noteCount} 篇`].filter(Boolean).join(' · ') || '还没有数据'}</p>
        ${b.radarNote ? `<p class="radar-note" style="margin:8px 0 0">${icon("radar")} ${esc(b.radarNote)}</p>` : b.summary ? `<p style="margin:8px 0 0">${esc(b.summary)}</p>` : b.remark ? `<p style="margin:8px 0 0" class="muted">备注：${esc(b.remark)}</p>` : ''}
        <div class="row" style="margin-top:10px">
          <button class="chip${b.tracking ? ' active' : ''}" data-act="${b.tracking ? 'track-off' : 'track-on'}" data-id="${esc(b.id)}">${b.tracking ? `${icon('radar')} 追踪中` : `${icon('radar')} 追踪`}</button>
        </div>
      </div>`;
    })
    .join('');

  main.innerHTML = `
    <div class="row page-head">
      <div><h1 class="page-title">${icon("target")} 竞品对标</h1><div class="muted">录入值得学习的账号，让 agent 拆解它们的选题、标题、封面和结构规律；开启追踪后新笔记会自动提醒。</div></div>
      <div class="spacer"></div>
      <button class="btn" data-act="toggle-radar">${icon("radar")} 追踪设置${V.cfg && V.cfg.radar.everyHours > 0 ? `（每 ${V.cfg.radar.everyHours} 小时）` : '（关）'}</button>
      <button class="btn" data-act="recommend">让 agent 推荐对标账号</button>
      <button class="btn primary" data-act="add">添加对标账号</button>
    </div>
    ${V.showRadar && V.cfg ? radarFormHtml() : ''}
    ${V.form ? formHtml(V.form) : ''}
    ${V.items.length ? `<div class="grid">${cards}</div>` : V.form ? '' : `<div class="card empty-card">
        <p>还没有对标账号。</p>
        <p class="muted">添加一个你想学习的账号（主页链接或名字都行），或者让 agent 根据你的账号定位推荐。</p>
      </div>`}`;
  bind(main);
}

function radarFormHtml() {
  const r = V.cfg.radar;
  return `<div class="card" style="margin-bottom:16px;max-width:560px">
    <h3 style="margin-top:0">对标追踪设置（当前账号）</h3>
    <form class="form" id="radar-form">
      <label>检查间隔（小时，0 表示不自动检查）<input type="number" name="everyHours" min="0" max="168" step="1" value="${r.everyHours}"></label>
      <label>新笔记点赞达到多少算「可能爆了」<input type="number" name="likesThreshold" min="1" step="1" value="${r.likesThreshold}"></label>
      <p class="muted" style="margin:0;font-size:12px">开启追踪的对标账号会按这个间隔让 agent 检查新笔记，超过阈值的会顶栏提醒你。${V.cfg.lastRuns.radar ? `上次检查：${fmtTime(V.cfg.lastRuns.radar)}。` : ''}需要 agent 能控制浏览器、工作台保持运行。</p>
      <div class="row"><button class="btn primary" type="submit">保存设置</button><button class="btn ghost" type="button" data-act="toggle-radar">收起</button></div>
    </form>
  </div>`;
}

function formHtml(f) {
  return `<div class="card" style="margin-bottom:16px;max-width:640px">
    <h3 style="margin-top:0">${f.id ? '编辑对标账号' : '添加对标账号'}</h3>
    <form class="form" id="bench-form">
      <label>账号名称 *<input type="text" name="name" required value="${esc(f.name)}"></label>
      <label>主页链接<input type="text" name="url" placeholder="https://www.xiaohongshu.com/user/profile/…" value="${esc(f.url)}"></label>
      <div class="row" style="align-items:stretch">
        <label style="flex:1">小红书号<input type="text" name="xhsId" value="${esc(f.xhsId)}"></label>
        <label style="flex:1">粉丝数<input type="text" name="followers" value="${esc(f.followers)}"></label>
      </div>
      <label>备注（为什么对标它、想学什么）<textarea name="remark" rows="2">${esc(f.remark)}</textarea></label>
      <div class="row"><button class="btn primary" type="submit">保存</button><button class="btn ghost" type="button" data-act="cancel-form">取消</button></div>
    </form>
  </div>`;
}

function drawDetail(main) {
  const { item: b, report, notes, screenshots } = V.detail;
  const [label, cls] = STATUS[b.status] || STATUS.pending;
  const tabs = [
    ['report', '拆解报告'],
    ['notes', `笔记数据（${notes.length}）`],
    ['shots', `截图素材（${screenshots.length}）`],
  ];
  let body = '';
  if (V.tab === 'report') {
    body = report
      ? `<div class="md">${md(report)}</div>`
      : `<div class="empty">还没有拆解报告。点上方「让 agent 拆解」开始。<br><span class="muted">如果 agent 无法直接浏览小红书，可以先在「截图素材」里上传对方主页和爆款笔记的截图。</span></div>`;
  } else if (V.tab === 'notes') {
    const isNew = (n) => n.firstSeenAt && Date.now() - new Date(n.firstSeenAt).getTime() < 48 * 3600_000;
    body = notes.length
      ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>标题</th><th>类型</th><th>点赞</th><th>收藏</th><th>评论</th><th>选题类型</th><th>标题套路</th></tr></thead><tbody>
          ${notes.map((n) => `<tr><td>${n.url ? `<a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a>` : esc(n.title)}${isNew(n) ? ' <span class="badge brand">新</span>' : ''}</td><td>${esc(n.type)}</td><td>${esc(n.likes)}</td><td>${esc(n.collects)}</td><td>${esc(n.comments)}</td><td>${esc(n.topicType)}</td><td>${esc(n.titlePattern)}</td></tr>`).join('')}
        </tbody></table></div>`
      : '<div class="empty">agent 拆解时会把采集到的笔记数据存在这里。</div>';
  } else {
    body = `
      <label class="btn upload-btn">上传截图<input type="file" accept="image/*" multiple id="shot-input" hidden></label>
      <span class="muted" style="margin-left:8px">主页、爆款笔记、评论区截图都可以，agent 会读取图片内容。</span>
      <div class="gallery">${screenshots.map((p) => `<a href="${fileUrl(p)}" target="_blank"><img src="${fileUrl(p)}" alt=""></a>`).join('')}</div>`;
  }

  main.innerHTML = `
    <div class="row page-head">
      <button class="btn ghost small" data-act="back">← 全部对标账号</button>
    </div>
    <div class="card">
      <div class="row">
        <h2 style="margin:0">${esc(b.name)}</h2><span class="badge ${cls}">${label}</span>
        ${b.analyzedAt ? `<span class="muted" style="font-size:12px">拆解于 ${fmtTime(b.analyzedAt)}</span>` : ''}
        <div class="spacer"></div>
        <button class="btn small" data-act="edit">编辑</button>
        <button class="btn small ghost danger" data-act="delete">删除</button>
      </div>
      <div class="muted" style="margin-top:6px">${[b.xhsId && `小红书号 ${esc(b.xhsId)}`, b.followers && `粉丝 ${esc(b.followers)}`, b.url && `<a href="${esc(b.url)}" target="_blank" rel="noopener">主页</a>`].filter(Boolean).join(' · ')}</div>
      ${b.remark ? `<div style="margin-top:6px">备注：${esc(b.remark)}</div>` : ''}
      ${b.summary ? `<div class="summary">${esc(b.summary)}</div>` : ''}
      <div class="row" style="margin-top:12px">
        <button class="btn primary small" data-act="analyze">${b.status === 'analyzed' ? '让 agent 重新拆解' : '让 agent 拆解'}</button>
        <button class="btn small" data-act="check-now" ${b.tracking ? '' : 'disabled'} title="立即检查这个账号有没有新笔记">立即检查新笔记</button>
        <button class="chip${b.tracking ? ' active' : ''}" data-act="${b.tracking ? 'track-off' : 'track-on'}" data-id="${esc(b.id)}">${b.tracking ? `${icon('radar')} 追踪中` : `${icon('radar')} 追踪`}</button>
        <button class="btn small" data-act="to-topics" ${report ? '' : 'disabled'}>根据拆解生成选题</button>
        <button class="btn small" data-act="to-kb" ${report ? '' : 'disabled'}>沉淀到知识库</button>
      </div>
    </div>
    ${V.form ? formHtml(V.form) : ''}
    <div class="tabs">${tabs.map(([id, name]) => `<button class="tab${V.tab === id ? ' active' : ''}" data-tab="${id}">${name}</button>`).join('')}</div>
    <div class="card">${body}</div>`;
  bind(main);
}

function bind(main) {
  main.onclick = async (e) => {
    const t = e.target.closest('[data-act],[data-bench],[data-tab]');
    if (!t) return;
    if (t.dataset.bench) {
      V.current = t.dataset.bench;
      V.tab = 'report';
      V.form = null;
      await markSeen(t.dataset.bench);
      await load();
      return draw(main);
    }
    if (t.dataset.tab) {
      V.tab = t.dataset.tab;
      return draw(main);
    }
    const b = V.detail && V.detail.item;
    if (t.dataset.act === 'track-on' || t.dataset.act === 'track-off') {
      const id = t.dataset.id;
      try {
        await api('POST', `/api/benchmarks?${acc()}`, { id, tracking: t.dataset.act === 'track-on' });
        const item = V.items.find((x) => x.id === id);
        if (item) item.tracking = t.dataset.act === 'track-on';
        if (V.detail && V.detail.item.id === id) V.detail.item.tracking = item.tracking;
        toast(item && item.tracking ? '已开启追踪，agent 会按设置间隔检查新笔记' : '已停止追踪');
      } catch (err) {
        toast(err.message);
      }
      return draw(main);
    }
    switch (t.dataset.act) {
      case 'toggle-radar':
        V.showRadar = !V.showRadar;
        return draw(main);
      case 'check-now':
        return ask(`请按 playbooks/benchmark.md 的「追踪检查」检查对标账号「${b.name}」（对标 id：${b.id}，主页：${b.url || '未提供'}）：把新发现的笔记追加到 ${benchDir(b.id)}notes.json（写 firstSeenAt），并更新 index.json 的 newCount、radarNote、lastCheckedAt。`, true);
      case 'add':
        V.form = {};
        return draw(main);
      case 'edit':
        V.form = { ...b };
        return draw(main);
      case 'cancel-form':
        V.form = null;
        return draw(main);
      case 'back':
        V.current = null;
        V.detail = null;
        V.form = null;
        return draw(main);
      case 'delete':
        if (!confirm(`删除对标账号「${b.name}」？（数据会移到回收站）`)) return;
        await api('DELETE', `/api/benchmarks?${acc(`id=${b.id}`)}`).catch((err) => toast(err.message));
        V.current = null;
        await load();
        return draw(main);
      case 'recommend':
        return ask(`请按 playbooks/benchmark.md，根据我当前账号的定位推荐 5 个值得对标的小红书账号，说明理由，并逐个登记到 ${accDirRel()}/benchmarks/index.json（status 设为 pending）。`, true);
      case 'analyze': {
        const shots = V.detail.screenshots.length;
        await api('POST', `/api/benchmarks?${acc()}`, { id: b.id, status: 'analyzing' });
        return ask(
          `请按 playbooks/benchmark.md 拆解对标账号「${b.name}」（对标 id：${b.id}，主页：${b.url || '未提供'}）。数据目录：${benchDir(b.id)}。` +
            (shots ? `我在 ${benchDir(b.id)}screenshots/ 上传了 ${shots} 张截图，请一并分析。` : ''),
          true,
        );
      }
      case 'to-topics':
        return ask(`请读取对标账号「${b.name}」的拆解报告（${benchDir(b.id)}report.md），结合我的账号定位，按 playbooks/topics.md 生成 8 个可以借鉴的选题，写入选题池（source 填「对标拆解」，sourceRef 填 ${b.id}）。`, true);
      case 'to-kb':
        return ask(`请把对标账号「${b.name}」拆解报告（${benchDir(b.id)}report.md）里可复用的规律，按 playbooks/knowledge.md 沉淀到知识库（对标拆解/ 和 爆款方法论/ 目录），完成后告诉我改动了哪些文档。`, true);
    }
  };

  const form = $('#bench-form', main);
  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      if (V.form.id) data.id = V.form.id;
      try {
        const item = await api('POST', `/api/benchmarks?${acc()}`, data);
        V.form = null;
        V.current = item.id;
        await load();
        draw(main);
        toast('已保存');
      } catch (err) {
        toast(err.message);
      }
    };
  }

  const radarForm = $('#radar-form', main);
  if (radarForm) {
    radarForm.onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(radarForm);
      try {
        V.cfg = await api('POST', `/api/automation?${acc()}`, { radar: { everyHours: Number(f.get('everyHours')) || 0, likesThreshold: Number(f.get('likesThreshold')) || 1000 } });
        V.showRadar = false;
        draw(main);
        toast('追踪设置已保存');
      } catch (err) {
        toast(err.message);
      }
    };
  }

  const input = $('#shot-input', main);
  if (input) {
    input.onchange = async () => {
      const label = input.closest('label');
      label.classList.add('disabled');
      try {
        for (const file of input.files) {
          await api('POST', `/api/benchmarks/upload?${acc()}`, { id: V.current, filename: file.name, data: await readFileAsDataURL(file) });
        }
        toast(`已上传 ${input.files.length} 张`);
        await load();
        draw(main);
      } catch (err) {
        toast(err.message);
        label.classList.remove('disabled');
      }
    };
  }
}

