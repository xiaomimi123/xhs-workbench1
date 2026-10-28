import {renderReview} from '../analytics-review.js';
import {metric,interactionRate,coverage} from '../analytics-metrics.js';
// 数据复盘：agent 抓取笔记 / 账号数据 → 指标卡 + 趋势图 + 笔记排行 → agent 写复盘报告并沉淀到知识库
import { md, esc } from '../md.js';
import { icon } from '../icons.js';
import { S, $, api, acc, toast, fmtTime, ask, opt, readFileAsDataURL, accDirRel } from '../core.js';

/**
 * 数据复盘要在创作者中心读数据：浏览器方式是 WorkBuddy 插件时，提示词必须明确让 agent 在聊天里直接用 mcp__browser__* 工具（虚拟机测试里 agent 把
 * browser.md 里「别在聊天里自己开 Bash」读成了「聊天里不能开浏览器」，一次都没采）；并要求它自己实时核对登录，不因为 browser.json 过期就停下。
 */
export function browserFetchHint() {
  if (!(S.bridge?.mode === 'cli' && S.bridge?.browser === 'workbuddy')) return '';
  return ' 浏览器方式是 WorkBuddy 插件：请直接用 WorkBuddy 浏览器工具（mcp__browser__*）在我自己的浏览器里新开标签页读取——这是在聊天里用浏览器读取工具，不属于「自己开 Bash」，不需要另外启动受控任务。'
    + '先按 playbooks/browser.md 实时核对登录账号（browser.json 只是上一次的记录，超过 30 分钟也由你自己重新核对，不要因此停下）；只读档没有点击工具，进入页面用 tab_goto 打开页面上链接的原文，或常见入口（可能随改版变化，打不开就从页面里的菜单链接找）：'
    + '创作者中心首页 https://creator.xiaohongshu.com/new/home （账号概览）、笔记管理 https://creator.xiaohongshu.com/new/note-manager 、数据分析 https://creator.xiaohongshu.com/statistics/data-analysis 。'
    + '读取节奏：动作之间停 3–8 秒，不要短时间打开大量页面。账号还没有已发布的笔记时，也要更新账号概览（粉丝数等），笔记数据留空，并如实告诉我；拿不到的数据留空，不要估算。';
}

const METRICS = [
  ['views', '阅读'],
  ['likes', '点赞'],
  ['collects', '收藏'],
  ['comments', '评论'],
  ['shares', '分享'],
  ['follows', '涨粉'],
];
const METRIC_NAME = Object.fromEntries([...METRICS, ['followers', '粉丝数']]);

const V = { data: null, cfg: null, metric: 'views', sort: 'views', report: null, showSettings: false };

// "1.2万" / "3,450" / 1200 → 数字
export function num(v) { return metric(v); }

function fmtNum(n) {
  if(n===null||n===undefined)return '未知';
  if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}万`;
  return Math.round(n).toLocaleString('zh-CN');
}

async function load() {
  const account=S.accountId,seq=V.sequence=(V.sequence||0)+1;
  const [data, cfg, workflow] = await Promise.all([api('GET', `/api/analytics?${acc()}`), api('GET', `/api/automation?${acc()}`),api('GET', `/api/analytics/workflow?${acc()}`)]);
  if(account!==S.accountId||S.view!=='analytics'||seq!==V.sequence)return false;
  V.workflow=workflow;
  V.data = data;
  V.cfg = cfg;
  return true;
}

export async function render(main) {
  const account=S.accountId;
  if (V.accountId !== S.accountId) {
    V.accountId = S.accountId;
    V.report = null;
  }
  main.innerHTML = '<div class="empty">加载中…</div>';
  try {
    if(!await load())return;
  } catch (err) {
    if(account===S.accountId&&S.view==='analytics')main.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  draw(main);
}

export async function onContent(ev) {
  if (!['analytics', 'automation','topics'].includes(ev.area)) return;
  if(document.activeElement?.closest('#analytics-settings'))return;
  if(!await load())return;
  draw($('#main'));
}

// ---------- 数据整理 ----------

// 账号级每日序列：优先用 account.json；没有该指标时按日期汇总各笔记的 history
function hasAccountMetric(key){return V.data.account.some(h=>h.date&&num(h[key])!==null);}
function series(metric) {
  const acct = V.data.account.filter((h) => h.date && num(h[metric])!==null);
  if (acct.length) return acct.map((h) => ({ date: h.date, value: num(h[metric]) })).sort((a, b) => a.date.localeCompare(b.date));
  const byDate = new Map(),counts=new Map();
  for (const n of V.data.notes) {
    for (const h of n.history || []) {
      if (!h.date || num(h[metric])===null) continue;
      counts.set(h.date,(counts.get(h.date)||0)+1);
      byDate.set(h.date, (byDate.get(h.date) || 0) + num(h[metric]));
    }
  }
  return [...byDate].filter(([date])=>counts.get(date)===V.data.notes.length).map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));
}

function totals() {
  const t = {};
  for (const [k] of METRICS) t[k] = coverage(V.data.notes.map(n=>n.metrics||{}),k);
  return t;
}

function rate(n) { return interactionRate(n.metrics); }

// ---------- 图表（单序列折线，带悬停读数） ----------

// 刻度取整：步长取 1 / 2 / 5 × 10^n，保证 4-5 条刻度都是整数
function niceScale(v) {
  if (v <= 0) return { max: 4, step: 1 };
  const raw = v / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((x) => x * p).find((x) => x >= raw);
  return { max: Math.ceil(v / step) * step, step };
}

function lineChart(points, label) {
  if (points.length < 2) {
    return `<div class="chart-empty muted">${points.length ? '只有 1 天的数据，多抓几天就能看到趋势。' : '还没有趋势数据。'}</div>`;
  }
  const W = 720, H = 240, L = 56, R = 56, T = 16, B = 28;
  const { max, step: yStep } = niceScale(Math.max(...points.map((p) => p.value)));
  const x = (i) => L + (i * (W - L - R)) / (points.length - 1);
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const area = `${line}L${x(points.length - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`;
  const ticks = [];
  for (let v = 0; v <= max + yStep / 2; v += yStep) ticks.push(v);
  const last = points[points.length - 1];
  const step = Math.max(1, Math.ceil(points.length / 7));
  return `<div class="chart" data-points='${esc(JSON.stringify(points))}' data-label="${esc(label)}">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}趋势">
      ${ticks.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${fmtNum(v)}</text>`).join('')}
      ${points.map((p, i) => ((i % step === 0 && points.length - 1 - i > step / 2) || i === points.length - 1 ? `<text class="tick" x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(p.date.slice(5))}</text>` : '')).join('')}
      <path class="area" d="${area}"/>
      <path class="line" d="${line}"/>
      <circle class="end" cx="${x(points.length - 1)}" cy="${y(last.value)}" r="5"/>
      <text class="end-label" x="${x(points.length - 1) + 10}" y="${y(last.value) + 4}">${fmtNum(last.value)}</text>
      <g class="hover" visibility="hidden"><line class="cross" y1="${T}" y2="${H - B}"/><circle class="dot" r="5"/></g>
      <rect class="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}"/>
    </svg>
    <div class="tooltip" hidden></div>
  </div>`;
}

function bindChart(box) {
  const chart = $('.chart', box);
  if (!chart) return;
  const points = JSON.parse(chart.dataset.points);
  const svg = $('svg', chart);
  const tip = $('.tooltip', chart);
  const hover = $('.hover', svg);
  const [W, L, R, T, B, H] = [720, 56, 56, 16, 28, 240];
  const { max } = niceScale(Math.max(...points.map((p) => p.value)));
  const show = (evt) => {
    const rect = svg.getBoundingClientRect();
    const px = ((evt.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(points.length - 1, Math.round(((px - L) / (W - L - R)) * (points.length - 1))));
    const cx = L + (i * (W - L - R)) / (points.length - 1);
    const cy = T + (H - T - B) * (1 - points[i].value / max);
    hover.setAttribute('visibility', 'visible');
    $('.cross', hover).setAttribute('x1', cx);
    $('.cross', hover).setAttribute('x2', cx);
    $('.dot', hover).setAttribute('cx', cx);
    $('.dot', hover).setAttribute('cy', cy);
    tip.hidden = false;
    tip.innerHTML = `<div class="muted">${esc(points[i].date)}</div><strong>${fmtNum(points[i].value)}</strong> ${esc(chart.dataset.label)}`;
    const left = (cx / W) * rect.width;
    tip.style.left = `${Math.min(rect.width - 120, Math.max(0, left + 12))}px`;
    tip.style.top = `${(cy / H) * rect.height - 10}px`;
  };
  const hit = $('.hit', svg);
  hit.addEventListener('mousemove', show);
  hit.addEventListener('mouseleave', () => {
    hover.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  });
}

function sparkline(history, metric) {
  const pts = (history || []).filter((h) => h.date&&num(h[metric])!==null).sort((a, b) => a.date.localeCompare(b.date)).map((h) => num(h[metric]));
  if (pts.length < 2) return '<span class="muted">—</span>';
  const max = Math.max(...pts) || 1;
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${((i * 80) / (pts.length - 1)).toFixed(1)},${(22 - (v / max) * 20).toFixed(1)}`).join('');
  return `<svg class="spark" viewBox="0 0 80 24" aria-hidden="true"><path d="${d}"/></svg>`;
}

// ---------- 页面 ----------

function kpiHtml() {
  const t = totals();
  const fol = V.data.account.filter((h) => num(h.followers)!==null).sort((a, b) => a.date.localeCompare(b.date));
  const tiles = [
    ['笔记', V.data.notes.length, null],
    ...METRICS.slice(0, 4).map(([k, n]) => [`${n}（${t[k].known}/${t[k].total} 篇有数据）`, t[k].value, null]),
    ['粉丝', fol.length ? num(fol[fol.length - 1].followers) : null, fol.length > 1 ? num(fol[fol.length - 1].followers) - num(fol[fol.length - 2].followers) : null],
  ];
  return `<div class="kpis">${tiles
    .map(([name, v, delta]) => `<div class="card kpi"><div class="muted">${name}</div><div class="kpi-value">${v === null ? '—' : fmtNum(v)}</div>${delta !== null ? `<div class="kpi-delta">${delta >= 0 ? '▲' : '▼'} ${fmtNum(Math.abs(delta))} 较上次</div>` : ''}</div>`)
    .join('')}</div>`;
}

function tableHtml() {
  const notes = [...V.data.notes].sort((a, b) =>
    V.sort === 'rate' ? (rate(b) ?? -1) - (rate(a) ?? -1) : V.sort === 'publishedAt' ? String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')) : (num(b.metrics?.[V.sort])??-1) - (num(a.metrics?.[V.sort])??-1),
  );
  const th = (key, name) => `<th><button class="sort${V.sort === key ? ' active' : ''}" data-sort="${key}">${name}${V.sort === key ? ' ↓' : ''}</button></th>`;
  return `<div class="card table-wrap" style="padding:0"><table class="data-table">
    <thead><tr><th>笔记</th>${th('publishedAt', '发布')}${METRICS.slice(0, 4).map(([k, n]) => th(k, n)).join('')}${th('rate', '互动率')}<th>阅读趋势</th></tr></thead>
    <tbody>${notes.map((n) => {
      const r = rate(n);
      return `<tr>
        <td class="note-cell">${n.url ? `<a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a>` : esc(n.title)}</td>
        <td>${esc(String(n.publishedAt || '').slice(0, 10))}</td>
        ${METRICS.slice(0, 4).map(([k]) => `<td class="num">${n.metrics && n.metrics[k] !== undefined ? fmtNum(num(n.metrics[k])) : '—'}</td>`).join('')}
        <td class="num">${r === null ? '—' : `${(r * 100).toFixed(1)}%`}</td>
        <td>${sparkline(n.history, 'views')}</td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
}

function settingsHtml() {
  return `<div class="card" style="margin-bottom:16px;max-width:560px">
    <h3 style="margin-top:0">数据抓取设置（当前账号）</h3>
    <form class="form" id="analytics-settings">
      <label>每天定时抓取数据（留空表示不自动抓取）<input type="time" name="dailyAt" value="${esc(V.cfg.analytics.dailyAt)}"></label>
      <p class="muted" style="margin:0;font-size:12px">${V.cfg.lastRuns.analytics ? `上次自动抓取：${fmtTime(V.cfg.lastRuns.analytics)}。` : ''}需要工作台保持运行、agent 能控制浏览器并已登录创作者中心。</p>
      <div class="row"><button class="btn primary" type="submit">保存设置</button><button class="btn ghost" type="button" data-act="toggle-settings">收起</button></div>
    </form>
  </div>`;
}

function draw(main) {
  if(S.view!=='analytics')return;
  const d = V.data;
  const hasData = d.notes.length || d.account.length;
  const metricOptions = [...METRICS, ['followers', '粉丝数']];
  main.innerHTML = `
    <div class="row page-head">
      <div><h1 class="page-title">${icon("chart")} 数据复盘</h1><div class="muted">${d.updatedAt ? `数据更新于 ${fmtTime(d.updatedAt)}。` : ''}区分历史账号表现与对标观察，复盘建议可回流选题池。</div></div>
      <div class="spacer"></div>
      <button class="btn" data-act="toggle-settings">${icon("sliders")} 设置</button>
      <button class="btn" data-act="fetch">让 agent 抓取数据</button>
      <button class="btn" data-act="import-notes" title="把账号里已发布的笔记导入进来，复盘就有历史数据了">导入历史笔记</button>
      ${d.notes.length ? `<a class="btn" href="/api/analytics/export?${acc()}&t=${encodeURIComponent(S.token)}">导出 CSV</a>` : ''}
      <button class="btn" data-act="report" ${hasData ? '' : 'disabled'}>旧版自由复盘</button>
    </div>
    <div id="analytics-review" class="card" style="margin-bottom:16px"></div>
    ${V.showSettings ? settingsHtml() : ''}
    ${hasData ? `
      <p class="muted">以下仅为本账号已保存数据。累计指标按已知样本汇总，未知不等于零；更新日期不代表本次重新核实。</p>${kpiHtml()}
      <div class="card" style="margin-top:16px">
        <div class="row"><h3 style="margin:0">${hasAccountMetric(V.metric) ? '每日趋势' : '累计趋势'}</h3><span class="muted" style="font-size:12px">${hasAccountMetric(V.metric) ? (V.metric === 'followers' ? '当天粉丝总数' : '当天新增') : '按笔记累计值汇总，仅显示覆盖全部笔记的日期'}</span><div class="spacer"></div>
          <select data-metric aria-label="指标">${metricOptions.map(([k, n]) => opt(k, n, V.metric)).join('')}</select>
        </div>
        <div id="chart-box">${lineChart(series(V.metric), METRIC_NAME[V.metric])}</div>
      </div>
      <h3 class="section-title">笔记数据</h3>
      ${d.notes.length ? tableHtml() : '<div class="muted">还没有笔记级数据。</div>'}`
    : `<div class="card empty-card">
        <p>还没有数据。</p>
        <p class="muted">点「让 agent 抓取数据」，agent 会到创作者中心读取笔记数据；如果它不能控制浏览器，可以在下方上传从创作者中心导出的表格或数据截图。</p>
      </div>`}
    <div class="analytics-bottom">
      <div class="card">
        <h3 style="margin-top:0">复盘报告</h3>
        ${d.reports.length ? `<div class="report-list">${d.reports.map((r) => `<button class="note-item${V.report && V.report.name === r.name ? ' active' : ''}" data-report="${esc(r.name)}"><span class="note-item-text"><span class="note-item-title">${esc(r.name.replace(/\.md$/, ''))}</span><span class="muted">${fmtTime(r.updatedAt)}</span></span></button>`).join('')}</div>` : '<div class="muted">还没有复盘报告。</div>'}
      </div>
      <div class="card">
        <h3 style="margin-top:0">导入数据</h3>
        <p class="muted" style="font-size:13px;margin-top:0">从创作者中心导出的 Excel / CSV，或数据页面截图。</p>
        <label class="btn small upload-btn">上传文件<input type="file" id="import-input" accept=".csv,.xlsx,.xls,.txt,.json,image/*" multiple hidden></label>
        ${d.imports.length ? `<ul class="import-list">${d.imports.map((f) => `<li>${esc(f)}</li>`).join('')}</ul><button class="btn small" data-act="parse-imports">让 agent 读取导入的数据</button>` : ''}
      </div>
    </div>
    ${V.report ? `<div class="card md report-view">${md(V.report.content)}</div>` : ''}`;
  bindChart(main);
  bind(main);
  renderReview(main.querySelector('#analytics-review'),V.workflow,async()=>{try{if(await load())draw(main);}catch(err){if(S.view==='analytics')toast(err.message);}});
}

function bind(main) {
  const dir = `${accDirRel()}/analytics/`;
  main.onclick = async (e) => {
    const t = e.target.closest('[data-act],[data-sort],[data-report]');
    if (!t) return;
    if (t.dataset.sort) {
      V.sort = t.dataset.sort;
      return draw(main);
    }
    if (t.dataset.report) {
      const account=S.accountId,seq=V.reportSeq=(V.reportSeq||0)+1;
      const report = V.report && V.report.name === t.dataset.report ? null : await api('GET', `/api/analytics/report?${acc(`name=${encodeURIComponent(t.dataset.report)}`)}`).catch((err) => toast(err.message));
      if(account!==S.accountId||S.view!=='analytics'||seq!==V.reportSeq)return;
      V.report=report;
      draw(main);
      if (V.report) $('.report-view', main).scrollIntoView({ behavior: 'smooth' });
      return;
    }
    switch (t.dataset.act) {
      case 'toggle-settings':
        V.showSettings = !V.showSettings;
        return draw(main);
      case 'fetch':
        return ask(`请按 playbooks/analytics.md 抓取当前账号最新的笔记数据和账号数据，更新 ${dir}notes.json 和 account.json。${browserFetchHint()}`, true);
      case 'import-notes':
        return ask(`请按 playbooks/analytics.md 的「首次导入历史笔记」，把我账号里已发布的笔记导入 ${dir}notes.json：按 url 跳过已有条目，新条目写当前累计数据和 imported: true。${browserFetchHint()}`, true);
      case 'report':
        return ask(`请按 playbooks/analytics.md 写一份最近一周的复盘报告，保存到 ${dir}reports/，并把可执行的结论沉淀到知识库「复盘结论/」。`, true);
      case 'parse-imports':
        return ask(`请读取 ${dir}imports/ 里我上传的数据文件，按 playbooks/analytics.md 的格式合并进 ${dir}notes.json 和 account.json。`, true);
    }
  };
  main.onchange = async (e) => {
    if (e.target.dataset.metric !== undefined) {
      V.metric = e.target.value;
      return draw(main);
    }
    if (e.target.id === 'import-input') {
      try {
        for (const f of e.target.files) await api('POST', `/api/analytics/upload?${acc()}`, { filename: f.name, data: await readFileAsDataURL(f) });
        toast(`已上传 ${e.target.files.length} 个文件`);
        if(!await load())return;
        draw(main);
      } catch (err) {
        toast(err.message);
      }
    }
  };
  main.onsubmit = async (e) => {
    e.preventDefault();
    if (e.target.id !== 'analytics-settings') return;
    try {
      await api('POST', `/api/automation?${acc()}`, { analytics: { dailyAt: new FormData(e.target).get('dailyAt') || '' } });
      toast('设置已保存');
      if(!await load())return;
      draw(main);
    } catch (err) {
      toast(err.message);
    }
  };
}
