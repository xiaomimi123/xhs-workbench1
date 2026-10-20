// 竞品对标：录入对标账号 → agent 拆解（报告 + 笔记数据）→ 生成选题 / 沉淀知识库
import { md, esc } from '../md.js';
import { icon } from '../icons.js';
import { S, $, api, acc, fileUrl, toast, fmtTime, ask, readFileAsDataURL, accDirRel } from '../core.js';

const V = { items: [], current: null, detail: null, tab: 'observed', form: null, cfg: null, issues: null, showRadar: false };

function benchDir(id) {
  return `${accDirRel()}/benchmarks/${id}/`;
}

const STATUS = { pending: ['待拆解', ''], analyzing: ['拆解未完成', 'warn'], analyzed: ['已拆解', 'brand'] };

function followerLabel(b) {
  if (b.observedFollowers) {
    const manual = b.followers && b.followers !== b.observedFollowers && b.followers !== '待核实'
      ? ` · 手填 ${esc(b.followers)}` : '';
    return `粉丝（页面） ${esc(b.observedFollowers)}${manual}`;
  }
  return b.followers && b.followers !== '待核实' ? `粉丝（未核实） ${esc(b.followers)}` : '粉丝待核实';
}

const OBS_SOURCE = { 'worker-ocr': '本地 OCR 与页面交叉核对', 'worker-visible': '后台只读采集', 'agent-visible': 'agent 页面观察', 'profile-visible': '主页身份核实' };

function safeXhsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['xiaohongshu.com', 'www.xiaohongshu.com'].includes(url.hostname) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function portraitHtml(b, large = false) {
  const name = b.profileName || b.name || '';
  const initials = [...name].slice(0, 2).join('') || '未';
  return `<div class="benchmark-avatar${large ? ' large' : ''}">
    ${b.avatar?.path ? `<img src="${fileUrl(b.avatar.path, b.avatar.observedAt || '')}" alt="${esc(name)}的头像" loading="lazy">`
      : `<span aria-label="头像未采集">${esc(initials)}</span>`}
  </div>`;
}

function observedValue(field, fallback = '未抓到') {
  return field?.value ? `<span title="${esc(`观察于 ${fmtTime(field.observedAt)} · ${OBS_SOURCE[field.source] || '页面观察'}`)}">${esc(field.value)}</span>`
    : `<span class="muted">${fallback}</span>`;
}

function captureLabel(b) {
  if (!b.observation) return '主页数据待补齐';
  const n = b.observation.noteCount || 0;
  return `${b.observation.state === 'complete' ? '已采集' : '部分采集'} · 主页可见笔记 ${n} 篇`;
}

function evidenceHtml(evidence, label) {
  return evidence ? `<p class="muted"><a href="${fileUrl(evidence.screenshot)}" target="_blank" rel="noopener noreferrer">${label}截图</a> · <a href="${fileUrl(evidence.ocr)}" target="_blank" rel="noopener noreferrer">识别/采集原文</a></p>` : '';
}

function noteObservationHtml(n, index) {
  const f = n.fields || {};
  return `<article class="benchmark-note-card">
    <div class="row"><span class="badge">${index + 1}</span><strong>${observedValue(f.title, '标题未抓到')}</strong><div class="spacer"></div>
      <a class="btn small" href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">打开笔记</a></div>
    ${evidenceHtml(n.evidence, '笔记')}
    <div class="benchmark-note-meta">${observedValue(f.type, '类型未抓到')} · 发布时间 ${observedValue(f.publishedAt)} · 观察于 ${fmtTime(n.observedAt)}</div>
    ${f.description?.value ? `<p class="muted">${esc(f.description.value)}</p>` : ''}
    <div class="benchmark-note-metrics"><span>点赞 ${observedValue(f.likes)}</span><span>收藏 ${observedValue(f.collects)}</span><span>评论 ${observedValue(f.comments)}</span></div>
  </article>`;
}

function observationHtml(detail) {
  const { item: b, observation: data, observationIssue } = detail;
  const profile = data?.profile || {};
  const source = OBS_SOURCE[data?.source] || '页面观察';
  const fields = [
    ['粉丝（页面）', profile.followers || (b.observedFollowers ? { value: b.observedFollowers, observedAt: b.verifiedAt, source: 'profile-visible' } : null)],
    ['关注', profile.following], ['获赞与收藏', profile.likesAndCollects], ['主页笔记数', profile.noteCount],
  ];
  return `<div class="benchmark-observation">
    <div class="row"><h3 style="margin:0">主页可见数据</h3><div class="spacer"></div><span class="badge ${data?.state === 'complete' ? 'brand' : 'warn'}">${data ? data.state === 'complete' ? '本次采集完成' : '部分数据待补' : '尚未采集'}</span></div>
    <p class="muted" style="margin:8px 0 14px">${data ? `${source} · 观察于 ${fmtTime(data.observedAt)}` : b.verifiedAt ? `主页身份核实于 ${fmtTime(b.verifiedAt)}；详细数据尚未采集` : '主页尚未核实'}。页面未显示的数字不会填 0。</p>
    ${observationIssue ? `<div class="benchmark-capture-warning">${icon('warning')} ${esc(observationIssue)}</div>` : ''}
    ${data?.state !== 'complete' && data?.reason ? `<div class="benchmark-capture-warning">${icon('warning')} ${esc(data.reason)}</div>` : ''}
    ${evidenceHtml(data?.profileEvidence, '主页 OCR')}
    <div class="benchmark-metrics">${fields.map(([label, value]) => `<div><span>${label}</span><strong>${observedValue(value)}</strong></div>`).join('')}</div>
    <div class="benchmark-bio"><span class="muted">主页简介</span><p>${observedValue(profile.bio)}</p></div>
    <div class="row" style="margin:22px 0 10px"><h3 style="margin:0">主页可见笔记</h3><span class="badge">${data?.notes?.length || 0} / 最多 5 篇</span></div>
    <p class="muted" style="font-size:12px;margin:0 0 12px">仅显示实际打开并读到的页面字段；未能确认排序时不称“最新”。深度拆解在「拆解报告 / agent 笔记」中。</p>
    ${data?.notes?.length ? `<div class="benchmark-note-list">${data.notes.map(noteObservationHtml).join('')}</div>`
      : `<div class="empty">${b.url ? '尚无笔记观察。自动采集进度见列表；遇到阻塞后可整体继续。' : '先核实主页，再读取笔记数据。'}</div>`}
  </div>`;
}

async function load() {
  const listing = await api('GET', `/api/benchmarks?${acc()}`);
  V.items = listing.items;
  V.issues = listing.checkpointIssues;
  V.collection = listing.collection;
  V.access = listing.access;
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
    V.tab = 'observed';
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
      return `<div class="card benchmark-card" data-bench="${esc(b.id)}" role="button" tabindex="0" aria-label="查看对标账号 ${esc(b.name)} 的详细数据">
        <div class="benchmark-card-head">${portraitHtml(b)}<div class="benchmark-card-title"><h3>${esc(b.profileName || b.name)}</h3>
          <span class="muted">${b.xhsId ? `小红书号 ${esc(b.xhsId)}` : '小红书号待核实'}</span></div>
          ${b.newCount ? `<span class="badge brand">新 ${b.newCount}</span>` : ''}</div>
        <div class="benchmark-card-status"><span class="badge ${b.verifiedAt ? 'brand' : 'warn'}">${b.verifiedAt ? '已核实主页' : '主页待核实'}</span>
          <span class="badge ${cls}">${label}</span></div>
        <div class="benchmark-card-stat"><span>${followerLabel(b)}</span><span>${captureLabel(b)}</span></div>
        ${b.avatar?.kind === 'manual' ? '<div class="muted" style="font-size:11px">头像：手动上传</div>' : b.avatar?.kind === 'downloaded' ? '<div class="muted" style="font-size:11px">头像：原图下载</div>' : b.avatar ? '<div class="muted" style="font-size:11px">头像：页面截图</div>' : '<div class="muted" style="font-size:11px">头像尚未采集</div>'}
        ${b.radarNote ? `<p class="radar-note">${icon('radar')} ${esc(b.radarNote)}</p>` : b.summary && b.status === 'analyzed' ? `<p>${esc(b.summary)}</p>` : b.remark ? `<p>备注：${esc(b.remark)}</p>` : ''}
        <div class="benchmark-card-footer"><button class="chip${b.tracking ? ' active' : ''}" data-act="${b.tracking ? 'track-off' : 'track-on'}" data-id="${esc(b.id)}">${b.tracking ? `${icon('radar')} 追踪中` : `${icon('radar')} 追踪`}</button>
          <span class="benchmark-open">查看数据 →</span></div>
      </div>`;
    })
    .join('');

  main.innerHTML = `
    <div class="row page-head">
      <div><h1 class="page-title">${icon("target")} 竞品对标</h1><div class="muted">录入值得学习的账号，让 agent 拆解它们的选题、标题、封面和结构规律；开启追踪后会定时提醒你手动启动检查。</div></div>
      <div class="spacer"></div>
      <button class="btn" data-act="toggle-radar">${icon("radar")} 追踪设置${V.cfg && V.cfg.radar.everyHours > 0 ? `（每 ${V.cfg.radar.everyHours} 小时）` : '（关）'}</button>
      <button class="btn" data-act="recommend">让 agent 推荐对标账号</button>
      <button class="btn primary" data-act="add">添加对标账号</button>
    </div>
    <div class="card" style="margin-bottom:12px">
      <div class="row"><strong>按需资料采集</strong><span>已完成 ${V.collection?.items.filter(x => x.state === 'complete').length || 0} · 待处理 ${V.collection?.items.filter(x => ['pending', 'running', 'blocked', 'partial'].includes(x.state)).length || 0}</span>
      <button class="btn small" data-act="collect-fill">补齐缺失的已登记对标</button>
      <button class="btn small" data-act="prepare-browser">核对登录账号</button><button class="btn small" data-act="resume-access">恢复普通暂停</button><button class="btn small" data-act="lock-restriction">报告平台限制</button><button class="btn small" data-act="resolve-restriction">确认限制已解除</button><button class="btn small" data-act="collect-pause">停止自动访问</button><button class="btn small" data-act="collect-resume">启动现有待办</button></div>
      <p class="muted">${esc((V.access?.kind !== 'open' ? V.access?.reason : '') || V.collection?.reason || '推荐只登记待办。先核对登录账号，再明确启动本次采集；随机等待不保证免风控。')}</p>
      ${(V.collection?.items || []).filter(x => ['running', 'partial', 'blocked'].includes(x.state)).map(x => `<div>${esc(V.items.find(b => b.id === x.id)?.name || x.id)}：${x.state === 'running' ? '采集中' : '未完整采集'} · 尝试 ${x.attempts} 次 ${esc(x.reason || '')}</div>`).join('')}
    </div>
    ${V.issues?.rejected ? `<div class="card" style="margin-bottom:12px">${icon('warning')} ${V.issues.rejected} 个对标检查点有冲突，未导入；请查看数据目录的 checkpoints/rejected/ 和原因文件。</div>` : ''}
    ${V.issues?.incomplete ? `<div class="muted" style="margin-bottom:12px">${V.issues.incomplete} 个检查点尚未完整写入，未作为结果显示。</div>` : ''}
    ${V.showRadar && V.cfg ? radarFormHtml() : ''}
    ${V.form ? formHtml(V.form) : ''}
    ${V.items.length ? `<div class="grid benchmark-grid">${cards}</div>` : V.form ? '' : `<div class="card empty-card">
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
      <p class="muted" style="margin:0;font-size:12px">开启追踪后只按这个间隔提醒，不会自动访问主页或采集笔记。${V.cfg.lastRuns.radar ? `上次提醒：${fmtTime(V.cfg.lastRuns.radar)}。` : ''}提醒需要工作台保持运行。</p>
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
      <label>手填定位（可选，不会被页面抓取覆盖）<input type="text" name="positioning" value="${esc(f.positioning)}"></label>
      <label>备注（为什么对标它、想学什么）<textarea name="remark" rows="2">${esc(f.remark)}</textarea></label>
      <div class="row"><button class="btn primary" type="submit">保存</button><button class="btn ghost" type="button" data-act="cancel-form">取消</button></div>
    </form>
  </div>`;
}

function drawDetail(main) {
  const { item: b, report, notes, screenshots } = V.detail;
  const [label, cls] = STATUS[b.status] || STATUS.pending;
  const tabs = [
    ['observed', '主页数据'],
    ['report', '拆解报告'],
    ['notes', `agent 笔记（${notes.length}）`],
    ['shots', `截图素材（${screenshots.length}）`],
  ];
  let body = '';
  if (V.tab === 'observed') {
    body = observationHtml(V.detail);
  } else if (V.tab === 'report') {
    body = report
      ? `${b.status !== 'analyzed' ? '<div class="benchmark-capture-warning">报告文件尚未标记为已完成拆解，请勿将它当成完整分析。</div>' : ''}<div class="md">${md(report)}</div>`
      : `<div class="empty">还没有拆解报告。先看「主页数据」，需要规律分析时再点「让 agent 拆解」。</div>`;
  } else if (V.tab === 'notes') {
    const isNew = (n) => n.firstSeenAt && Date.now() - new Date(n.firstSeenAt).getTime() < 48 * 3600_000;
    body = notes.length
      ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>标题</th><th>类型 / 发布时间</th><th>点赞</th><th>收藏</th><th>评论</th><th>选题类型 / 标题套路</th></tr></thead><tbody>
          ${notes.map((n) => `<tr><td>${safeXhsUrl(n.url) ? `<a href="${esc(safeXhsUrl(n.url))}" target="_blank" rel="noopener noreferrer">${esc(n.title || '未填写')}</a>` : esc(n.title || '未填写')}${isNew(n) ? ' <span class="badge brand">新</span>' : ''}</td><td>${esc(n.type || '—')}<br>${esc(n.publishedAt || '时间未填')}</td><td>${esc(n.likes || '—')}</td><td>${esc(n.collects || '—')}</td><td>${esc(n.comments || '—')}</td><td>${esc(n.topicType || '—')}<br>${esc(n.titlePattern || '')}${n.coverText ? `<br>封面：${esc(n.coverText)}` : ''}</td></tr>`).join('')}
        </tbody></table></div>`
      : '<div class="empty">agent 还没有完成笔记拆解。这与上方「主页可见笔记」的原始观察是两种数据。</div>';
  } else {
    body = `
      <label class="btn upload-btn">上传参考截图<input type="file" accept="image/*" multiple id="shot-input" hidden></label>
      <span class="muted" style="margin-left:8px">主页、爆款笔记、评论区截图供 agent 分析；不会自动当成头像。</span>
      <div class="gallery">${screenshots.map((p) => `<a href="${fileUrl(p)}" target="_blank" rel="noopener noreferrer"><img src="${fileUrl(p)}" alt="对标截图"></a>`).join('')}</div>`;
  }

  main.innerHTML = `
    <div class="row page-head"><button class="btn ghost small" data-act="back">← 全部对标账号</button></div>
    <div class="card benchmark-hero">
      <div class="benchmark-hero-head">${portraitHtml(b, true)}
        <div class="benchmark-hero-title"><div class="row"><h2>${esc(b.profileName || b.name)}</h2><span class="badge ${b.verifiedAt ? 'brand' : 'warn'}">${b.verifiedAt ? '已核实主页' : '主页待核实'}</span><span class="badge ${cls}">${label}</span></div>
          <div class="muted">${b.xhsId ? `小红书号 ${esc(b.xhsId)}` : '小红书号待核实'}${b.profileName && b.profileName !== b.name ? ` · 登记名 ${esc(b.name)}` : ''}</div>
          <div class="muted" style="font-size:12px">头像：${b.avatar?.kind === 'downloaded' ? '主页头像原图下载' : b.avatar?.kind === 'captured' ? '页面头像截图' : b.avatar?.kind === 'manual' ? '手动上传' : '未采集'}</div>
        </div>
        <div class="spacer"></div><button class="btn small" data-act="edit">编辑</button><button class="btn small ghost danger" data-act="delete">删除</button>
      </div>
      <div class="benchmark-hero-sub">${[followerLabel(b), safeXhsUrl(b.url) && `<a href="${esc(safeXhsUrl(b.url))}" target="_blank" rel="noopener noreferrer">打开主页</a>`, b.analyzedAt && `拆解于 ${fmtTime(b.analyzedAt)}`].filter(Boolean).join(' · ')}</div>
      ${b.positioning ? `<p>手填定位：${esc(b.positioning)}</p>` : ''}
      ${b.remark ? `<p class="muted">备注：${esc(b.remark)}</p>` : ''}
      ${b.summary && b.status === 'analyzed' ? `<div class="summary">${esc(b.summary)}</div>` : ''}
      <div class="row benchmark-actions">
        <button class="btn primary small" data-act="verify">${b.observation ? '刷新主页与近 5 篇笔记' : '补齐头像和主页数据'}</button>

        <label class="btn small upload-btn">手动上传头像<input type="file" accept="image/png,image/jpeg,image/webp" id="avatar-input" hidden></label>
        <button class="btn small" data-act="analyze">${b.status === 'analyzed' ? '让 agent 重新拆解' : '让 agent 拆解'}</button>
        <button class="btn small" data-act="check-now" ${b.tracking ? '' : 'disabled'} title="检查这个账号有没有新笔记">立即检查新笔记</button>
        <button class="chip${b.tracking ? ' active' : ''}" data-act="${b.tracking ? 'track-off' : 'track-on'}" data-id="${esc(b.id)}">${b.tracking ? `${icon('radar')} 追踪中` : `${icon('radar')} 追踪`}</button>
        <button class="btn small" data-act="to-topics" ${V.detail.observation?.notes?.length || report && b.status==='analyzed' ? '' : 'disabled'}>根据已采集资料生成选题</button>
        <button class="btn small" data-act="to-kb" ${report && b.status === 'analyzed' ? '' : 'disabled'}>沉淀到知识库</button>
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
      V.tab = 'observed';
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
      const target = V.items.find((x) => x.id === id);
      if (t.dataset.act === 'track-on' && !target?.url) return toast('先核实主页链接，再开启追踪');
      try {
        await api('POST', `/api/benchmarks?${acc()}`, { id, tracking: t.dataset.act === 'track-on' });
        const item = V.items.find((x) => x.id === id);
        if (item) item.tracking = t.dataset.act === 'track-on';
        if (V.detail && V.detail.item.id === id) V.detail.item.tracking = item.tracking;
        toast(item && item.tracking ? '已开启追踪提醒，到点需你手动启动检查' : '已停止追踪');
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
      case 'collect-fill':
      case 'collect-pause':
      case 'collect-resume':
        await api('POST', `/api/benchmarks/collection?${acc()}`, { action: t.dataset.act.slice(8) });
        await load(); return draw(main);
      case 'prepare-browser':
        return ask('独立核对当前登录账号，不采集对标资料', true, {taskKind:'browser.prepare'});
      case 'resume-access':
        await api('POST', `/api/browser/access?${acc()}`, {action:'resume'}); await load(); return draw(main);
      case 'lock-restriction':
        await api('POST', `/api/browser/access?${acc()}`, {action:'restriction'}); await load(); return draw(main);
      case 'resolve-restriction':
        if(!confirm('仅在你已在官方应用确认平台限制解除后继续。此操作不启动采集。确认已解除？')) return;
        await api('POST', `/api/browser/access?${acc()}`, {action:'resolve-restriction',confirmed:true}); await load(); return draw(main);
      case 'recommend':
        return ask(`根据现有本地资料推荐候选，写入 ${accDirRel()}/benchmarks/checkpoints/pending/ 的 candidate 检查点。只登记待办；不要打开浏览器或自动采集，没有资料时说明缺项。`, true);
      case 'verify':
        if (S.bridge?.browserWorker?.enabled && S.bridge.browserWorker.available && S.bridge.browserWorker.compatible) {
          return ask(`只读核实对标账号「${b.name}」的主页`, true, { taskKind: 'benchmark.verify', benchmarkId: b.id });
        }
        return toast('只读采集组件不可用，请先在连接设置中配置；不会自动切换采集工具');
      case 'analyze': {
        const shots = V.detail.screenshots.length;
        if (!b.url && !shots) return toast('先核实主页，或上传主页和笔记截图，再拆解');
        return ask(
          `请按 playbooks/benchmark.md 拆解对标账号「${b.name}」（对标 id：${b.id}，主页：${b.url || '未提供'}）。数据目录：${benchDir(b.id)}。` +
            (shots ? `我在 ${benchDir(b.id)}screenshots/ 上传了 ${shots} 张截图，请一并分析。` : ''),
          true,
        );
      }
      case 'to-topics':
        try { await api('POST', `/api/topics/generate?${acc()}`, {benchmarkId:b.id}); go('topics'); } catch(err){toast(err.message);} return;
      case 'to-kb':
        return ask(`请把对标账号「${b.name}」拆解报告（${benchDir(b.id)}report.md）里可复用的规律，按 playbooks/knowledge.md 沉淀到知识库（对标拆解/ 和 爆款方法论/ 目录），完成后告诉我改动了哪些文档。`, true);
    }
  };

  main.onkeydown = (e) => {
    if (!['Enter', ' '].includes(e.key) || !e.target.matches('.benchmark-card')) return;
    e.preventDefault();
    e.target.click();
  };

  const avatarInput = $('#avatar-input', main);
  if (avatarInput) avatarInput.onchange = async () => {
    const file = avatarInput.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return toast('头像图片不能超过 2MB');
    try {
      await api('POST', `/api/benchmarks/avatar?${acc()}`, { id: V.current, filename: file.name, data: await readFileAsDataURL(file) });
      await load();
      draw(main);
      toast('手动头像已保存；自动截图可在下次采集时替换显示');
    } catch (err) { toast(err.message); }
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

