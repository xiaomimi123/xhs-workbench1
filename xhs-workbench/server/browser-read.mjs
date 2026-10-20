// 页面读取结果的纯函数：只有主页 URL + 唯一且可见的身份字段才能写入核实检查点。
const XHS_HOSTS = new Set(['www.xiaohongshu.com', 'xiaohongshu.com']);

export function canonicalProfileUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !XHS_HOSTS.has(url.hostname) || url.username || url.password
      || !/^\/user\/profile\/[\w-]+\/?$/.test(url.pathname)) return null;
    return `https://www.xiaohongshu.com${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return null;
  }
}

export function isXhsPage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'xiaohongshu.com' || url.hostname.endsWith('.xiaohongshu.com'));
  } catch {
    return false;
  }
}

export function pageWarning(text = '', url = '') {
  if (/AI不规范|商业权益|流量曝光|验证码|安全验证|操作频繁|访问受限|异常访问|风险提示|滑块验证|当前笔记暂时无法浏览|请打开小红书App扫码查看/.test(String(text).slice(0, 5000))) return '检测到验证码或访问限制，请在有头窗口由本人处理；本次采集已停止';
  if (/\/login(?:\/|\?|$)/i.test(url) || /扫码登录|手机号登录|请先登录/.test(String(text).slice(0, 1200))) return '需要在有头浏览器窗口由本人登录';
  return null;
}

function matches(values, expression) {
  return [...new Set([...String(values || '').matchAll(expression)].map((m) => m[1].trim()))];
}

export function readCreatorIdentity({ url = '', header = '', accountMenu = '', accountPanel = '', text = '' }) {
  const warning = pageWarning([header, accountMenu, accountPanel, text].join('\n'), url);
  if (warning) return { state: /登录/.test(warning) ? 'needsLogin' : 'needsReview', reason: warning };
  if (!isXhsPage(url) || new URL(url).hostname !== 'creator.xiaohongshu.com') {
    return { state: 'needsReview', reason: '创作者中心未能打开或发生跨站跳转' };
  }
  // 只信账号菜单/顶部区域及新版个人资料卡。正文推荐区可能出现其他创作者的小红书号。
  const ids = matches(`${header}\n${accountMenu}\n${accountPanel}`, /小红书(?:账号|号)\s*[：:]\s*([\w.-]{3,40})/g);
  if (ids.length !== 1) return { state: 'needsReview', reason: '创作者中心未显示唯一的小红书号，请人工核对登录账号' };
  return { state: 'ready', xhsId: ids[0] };
}

export function chooseSearchProfile(rows, benchmark) {
  const candidates = rows.slice(0, 12).map((row) => ({
    url: canonicalProfileUrl(row.url),
    name: String(row.name || '').trim().slice(0, 120),
    xhsId: matches(row.text, /小红书号\s*[：:]\s*([\w.-]{3,40})/g)[0] || '',
  })).filter((row) => row.url);
  const expectedId = String(benchmark.xhsId || '').trim();
  const exact = candidates.filter((row) => expectedId ? row.xhsId === expectedId : row.name === String(benchmark.name || '').trim());
  const unique = [...new Map(exact.map((row) => [row.url, row])).values()];
  if (unique.length !== 1) return { state: 'needsReview', reason: unique.length ? '搜索结果有多个同名账号，不能自动判定身份' : '搜索结果未找到唯一匹配的主页', candidates };
  return { state: 'ready', url: unique[0].url, candidates: unique };
}

export function readProfile({ url = '', name = '', details = '', text = '' }, benchmark, expectedUrl) {
  const warning = pageWarning(text, url);
  if (warning) return { state: /登录/.test(warning) ? 'needsLogin' : 'needsReview', reason: warning };
  const canonical = canonicalProfileUrl(url);
  if (!canonical || canonical !== expectedUrl) return { state: 'needsReview', reason: '打开的主页与预期链接不一致' };
  const profileName = String(name).trim().slice(0, 120);
  const ids = matches(details, /小红书号\s*[：:]\s*([\w.-]{3,40})/g);
  const followers = metricValues(details, '粉丝');
  if (!profileName || ids.length !== 1) return { state: 'needsReview', reason: '主页昵称或小红书号缺失/不唯一，未保存核实结果' };
  if (benchmark.xhsId && String(benchmark.xhsId).trim() !== ids[0]) return { state: 'needsReview', reason: '主页小红书号与已记录的小红书号不同' };
  if (!benchmark.xhsId && profileName !== String(benchmark.name || '').trim()) {
    return { state: 'needsReview', reason: '主页昵称与候选名称不一致，请人工确认' };
  }
  if (followers.length > 1) return { state: 'needsReview', reason: '主页粉丝数有多个不同值，未保存核实结果' };
  return { state: 'verified', url: canonical, profileName, xhsId: ids[0], followers: followers[0] || '',
    observedAt: new Date().toISOString(), source: '小红书主页可见的账号信息' };
}

/** 页面可见笔记的固定链接；去掉访问参数后才进入本地观察记录。 */
export function canonicalNoteUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !XHS_HOSTS.has(url.hostname) || url.username || url.password
      ) return null;
    const profileNote = /^\/user\/profile\/[\w-]{6,64}\/([\w-]{6,64})\/?$/.exec(url.pathname);
    if (profileNote) return `https://www.xiaohongshu.com/explore/${profileNote[1]}`;
    if (!/^\/(?:explore|discovery\/item)\/[\w-]{6,64}\/?$/.test(url.pathname)) return null;
    return `https://www.xiaohongshu.com${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return null;
  }
}

function metricValues(text, name) {
  // 真实主页使用“数字\n标签”；必须先识别此布局，避免读到下一项的数字。
  const before = matches(text, new RegExp(String.raw`(?:^|\n)[ \t]*([\d,.]+[ \t]*[万亿wWkK]?)[ \t]*\n[ \t]*${name}(?=\s|$)`, 'g'));
  if (before.length) return before;
  return matches(text, new RegExp(String.raw`(?:^|\n|\s)${name}\s*[·・:：]?\s*([\d,.]+\s*[万亿wWkK]?)`, 'g'));
}
function labeled(text, name) {
  const values = metricValues(text, name);
  return values.length === 1 ? values[0] : '';
}

export function readProfileExtras({ details = '', bio = '', countText = '' }) {
  const profile = {};
  const description = String(bio || '').trim().slice(0, 500);
  if (description) profile.bio = description;
  for (const [key, label] of [['following', '关注'], ['likesAndCollects', '获赞与收藏'], ['noteCount', '笔记']]) {
    const value = labeled(key === 'noteCount' ? countText : details, label);
    if (value) profile[key] = value;
  }
  return profile;
}

export function chooseVisibleNotes(rows) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  const result = [];
  for (const row of rows.slice(0, 40)) {
    const url = canonicalNoteUrl(row?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    result.push({ url, openUrl: row.url, title: String(row.title || '').trim().slice(0, 200) });
    if (result.length === 5) break;
  }
  return result;
}

export function readVisibleNote({ url = '', title = '', details = '', description = '', publishedAt = '', type = '' }) {
  const warning = pageWarning(details, url);
  if (warning) return { state: /登录/.test(warning) ? 'needsLogin' : 'needsReview', reason: warning };
  const canonical = canonicalNoteUrl(url);
  if (!canonical) return { state: 'needsReview', reason: '笔记跳转链接不合法' };
  const fields = {};
  const heading = String(title || '').trim().slice(0, 200);
  if (heading) fields.title = heading;
  const summary = String(description || '').trim().slice(0, 400);
  if (summary) fields.description = summary;
  const time = String(publishedAt || '').trim().slice(0, 80);
  if (time && /(?:\d{4}[-/.年]\d{1,2}|\d{1,2}[-/.月]\d{1,2}|\d+\s*(?:秒|分钟|小时|天|周|月|年)前|刚刚|昨天|前天|今天)/.test(time)) fields.publishedAt = time;
  if (type === '图文' || type === '视频') fields.type = type;
  for (const [key, label] of [['likes', '点赞'], ['collects', '收藏'], ['comments', '评论']]) {
    const value = labeled(details, label);
    if (value) fields[key] = value;
  }
  return { state: 'observed', url: canonical, ...fields };
}
