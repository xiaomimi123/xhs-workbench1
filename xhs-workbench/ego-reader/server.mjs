// 【来源】企业智能体中枢仓库 tools/ego-reader/server.mjs（那边是源头，改动请同步）。工作台的「ego lite 浏览器」方式用它：给 CodeBuddy 提供只读的小红书读取工具。
// 说明和测试见中枢仓库 tools/ego-reader/README.md、test.mjs。
// ego-reader：把 ego lite 包成一个只读的 MCP 小服务（stdio，零依赖），给 CodeBuddy 等 agent 读小红书用。  【原型，未接入工作台】
//
// 为什么要封装：`ego-browser nodejs` 执行的是任意 JavaScript，能访问本机文件系统，不能把 agent 写的脚本直接交给它。
// 这里只有两个工具，脚本是固定模板，agent 只能传校验过的参数（笔记 id、滚动次数）。没有点赞/收藏/关注/评论/发布/输入文字的能力。
//
// 工具：
//   xhs_check_login               检查是否真的登录（页面状态 loggedIn / guest），不读内容
//   xhs_read_me                   核对登录并读自己的主页（昵称、小红书号、简介、标签、可见笔记标题）
//   xhs_read_feed  {scrolls?: 0-3}   读首页信息流当前可见的笔记卡片（可先用鼠标滚轮向下滚动 0-3 次）
//   xhs_read_note  {id, scroll_note?: 0-3}  点开当前可见的某张卡片，读标题、正文、话题、作者、互动数，读完关闭
//
// 保护（纵深防御，真正的节奏 / 额度 / 总开关仍由工作台服务端 pace.mjs 管）：
//   两次读笔记至少间隔 EGO_READER_MIN_GAP_MS（默认 20000）、每小时最多 EGO_READER_MAX_PER_HOUR（默认 12）、
//   存在文件 EGO_READER_STOP_FILE（默认 %TEMP%/hub-ego-reader.STOP）时全部拒绝。
// 不做的事：随机停顿、鼠标轨迹抖动等伪装成真人的处理；滚动距离和间隔都是固定值。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const SPACE = process.env.EGO_READER_SPACE || 'hub-xhs-reader';
const MIN_GAP = Number(process.env.EGO_READER_MIN_GAP_MS || 20000);
const MAX_PER_HOUR = Number(process.env.EGO_READER_MAX_PER_HOUR || 12);
const STOP_FILE = process.env.EGO_READER_STOP_FILE || path.join(os.tmpdir(), 'hub-ego-reader.STOP');
const STATE_FILE = process.env.EGO_READER_STATE || path.join(os.tmpdir(), 'hub-ego-reader-state.json');
const EGO = process.env.EGO_BROWSER_BIN || 'ego-browser';
const NOTE_ID = /^[0-9a-f]{24}$/;
const WHEEL_PX = 700, WHEEL_GAP_MS = 3000;

// ---------------- 固定脚本模板（参数在校验后以 JSON 字面量嵌入） ----------------
const COMMON = `
const SPACE = ${JSON.stringify(SPACE)};
const out = (o) => console.log("RESULT:" + JSON.stringify(o));
const task = await taskSpace(SPACE);
const page = task.page("p1");
async function ensureFeed() {
  const u = (await page.url()).split("?")[0].replace(/\\/$/, "");
  if (!/^https:\\/\\/www\\.xiaohongshu\\.com\\/explore$/.test(u)) await page.goto("https://www.xiaohongshu.com/explore");
  await page.waitForSelector("section.note-item a.cover", { state: "visible", timeout: 10000 });
}
// 登录状态只认页面自己的状态（小红书游客也能看信息流，所以「找不到登录按钮」不能说明已登录）
const loginState = () => page.evaluate(() => {
  try {
    const unwrap = (x) => (x && typeof x === "object" && ("_rawValue" in x ? x._rawValue : "value" in x ? x.value : x));
    const u = window.__INITIAL_STATE__.user;
    const info = unwrap(u.userInfo) || {};
    return { loggedIn: unwrap(u.loggedIn) === true, guest: info.guest === true };
  } catch (e) { return { loggedIn: false, guest: null, unknown: true }; }
});
const visibleCards = () => page.evaluate(() => {
  const t = (el) => (el ? el.innerText.trim() : "");
  return Array.from(document.querySelectorAll("section.note-item")).map((s) => {
    const a = s.querySelector("a.cover");
    if (!a) return null;
    const r = a.getBoundingClientRect();
    // 整张卡片都要在固定导航栏（约 80px）下方、视口内，否则点击会被导航栏 / 搜索框拦截
    if (r.width < 20 || r.height < 20 || r.top < 100 || r.bottom > window.innerHeight - 10) return null;
    return { id: (a.getAttribute("href") || "").replace("/explore/", "").split("?")[0], title: t(s.querySelector(".title, [class*='title']")).slice(0, 60),
      author: t(s.querySelector(".author .name, .name")).slice(0, 30), likes: t(s.querySelector(".like-wrapper .count, .count")).slice(0, 12) };
  }).filter(Boolean);
});
`;
const feedScript = (scrolls) => `${COMMON}
await ensureFeed();
await page.waitForTimeout(1000);
if (${scrolls} > 0) {
  await page.mouse.move(700, 500, { label: "move over feed" });
  for (let i = 0; i < ${scrolls}; i++) { await page.mouse.wheel(0, ${WHEEL_PX}, { label: "scroll feed" }); await page.waitForTimeout(${WHEEL_GAP_MS}); }
}
out({ ok: true, ...(await loginState()), scrollY: await page.evaluate(() => Math.round(window.scrollY)), cards: await visibleCards() });
`;
const checkScript = () => `${COMMON}
await ensureFeed();
out({ ok: true, ...(await loginState()) });
`;
const meScript = () => `${COMMON}
await ensureFeed();
const st = await loginState();
if (!st.loggedIn) { out({ ok: true, ...st, hint: "not logged in: ask the user to scan the QR code in ego lite themselves, then call xhs_check_login" }); }
else {
  const ids = await page.evaluate(() => {
    const unwrap = (x) => (x && typeof x === "object" && ("_rawValue" in x ? x._rawValue : "value" in x ? x.value : x));
    const info = unwrap(window.__INITIAL_STATE__.user.userInfo) || {};
    return { userId: typeof info.userId === "string" ? info.userId : "", token: typeof info.xsecToken === "string" ? info.xsecToken : "" };
  });
  if (!/^[0-9a-f]{24}$/.test(ids.userId)) { out({ ok: false, error: "no_user_id", ...st }); }
  else {
    // 页面自己拼主页链接的方式：userId + 页面状态里的 xsecToken
    await page.goto("https://www.xiaohongshu.com/user/profile/" + ids.userId + "?xsec_token=" + encodeURIComponent(ids.token) + "&xsec_source=pc_feed");
    await page.waitForSelector(".user-name, .user-info, section.note-item", { state: "visible", timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const me = await page.evaluate(() => {
      const t = (sel) => { const e = document.querySelector(sel); return e ? e.innerText.trim() : ""; };
      const body = document.body.innerText;
      const pick = (re) => { const m = body.match(re); return m ? m[1].trim() : ""; };
      const redText = t(".user-redId") || pick(/小红书号[:：]\s*([^\s]+)/);
      return {
        nickname: t(".user-name").slice(0, 40),
        xhsId: (redText.match(/小红书号[:：]?\s*([^\s]+)/) || [null, redText])[1] || "",
        ip: pick(/IP属地[:：]\s*([^\s]+)/),
        bio: t(".user-desc").slice(0, 300),
        tags: Array.from(document.querySelectorAll(".user-tags > *")).map((e) => e.innerText.trim()).filter(Boolean).slice(0, 10),
        counts: t(".user-interactions").replace(/\s+/g, " ").slice(0, 80),
        noteTitles: Array.from(document.querySelectorAll("section.note-item .title, section.note-item [class*='title']")).map((e) => e.innerText.trim()).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).slice(0, 12),
        gone: /页面不见了|无法浏览/.test(body.slice(0, 300)),
      };
    });
    await page.goto("https://www.xiaohongshu.com/explore");
    out({ ok: true, ...st, ...me });
  }
}
`;
const noteScript = (id, scrollNote) => `${COMMON}
await ensureFeed();
const sel = 'a.cover[href^="/explore/${id}"]';
const here = (await visibleCards()).some((c) => c.id === ${JSON.stringify(id)});
if (!here) { out({ ok: false, error: "card_not_visible", hint: "call xhs_read_feed first; the note must be a currently visible card" }); }
else {
  await page.click(sel, { label: "open note to read" });
  await page.waitForSelector("#detail-desc, #detail-title", { state: "visible", timeout: 8000 });
  await page.waitForTimeout(1200);
  const rect = await page.evaluate(() => { const d = document.querySelector("#detail-desc") || document.querySelector("#detail-title"); const r = d.getBoundingClientRect(); return { x: Math.round(r.x + Math.min(r.width / 2, 120)), y: Math.round(r.y + 10) }; });
  if (${scrollNote} > 0) {
    await page.mouse.move(rect.x, rect.y, { label: "move over note text" });
    for (let i = 0; i < ${scrollNote}; i++) { await page.mouse.wheel(0, 500, { label: "scroll note" }); await page.waitForTimeout(${WHEEL_GAP_MS}); }
  }
  const note = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const t = (el) => (el ? el.innerText.trim() : "");
    const nums = (s) => t(q(s));
    return {
      title: t(q("#detail-title")).slice(0, 100),
      text: t(q("#detail-desc")).slice(0, 4000),
      tags: Array.from(document.querySelectorAll("#detail-desc a#hash-tag, #detail-desc a.tag")).map((a) => a.innerText.trim()).slice(0, 20),
      author: t(q(".author-container .username, .note-container .username, .author .username")).slice(0, 30),
      date: t(q(".bottom-container .date, .date")).slice(0, 40),
      images: document.querySelectorAll(".note-slider img, .swiper-slide img, .media-container img").length,
      hasVideo: !!q("video"),
      likes: nums(".interact-container .like-wrapper .count"), collects: nums(".interact-container .collect-wrapper .count"), comments: nums(".interact-container .chat-wrapper .count"),
      scrollTop: Math.round((q("#noteContainer") || { scrollTop: 0 }).scrollTop),
    };
  });
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(800);
  out({ ok: true, id: ${JSON.stringify(id)}, ...(await loginState()), ...note });
}
`;

// ---------------- 运行 ego-browser ----------------
function runScript(source, timeoutMs = 90000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ego-reader-'));
  const file = path.join(dir, 'task.mjs');
  fs.writeFileSync(file, source, 'utf8');
  const url = 'file:///' + file.replace(/\\/g, '/');
  return new Promise((resolve) => {
    const child = spawn(EGO, ['nodejs', '-e', `await import('${url}')`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '', se = '';
    child.stdout.on('data', (d) => { so += d; });
    child.stderr.on('data', (d) => { se += d; });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: 'ego_browser_not_found', detail: String(e.message).slice(0, 200) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.rmSync(dir, { recursive: true, force: true });
      const line0 = (so + '\n' + se).split('\n').find((l) => l.includes('RESULT:'));   // ego-browser 把 console.log 写到 stderr，两个流都找
      const line = line0 === undefined ? undefined : line0.slice(line0.indexOf('RESULT:'));
      if (line) { try { return resolve(JSON.parse(line.trim().slice(7))); } catch (e) { return resolve({ ok: false, error: 'bad_result', detail: String(e.message).slice(0, 120) + ' (length ' + line.length + ', tail ' + JSON.stringify(line.slice(-60)) + ')' }); } }
      const msg = (se || so).replace(/\s+/g, ' ').trim();
      if (/Control of this task space is with the user/i.test(msg)) return resolve({ ok: false, error: 'user_has_control', detail: 'the user took over the browser space; ask them to hand it back' });
      resolve({ ok: false, error: 'ego_script_failed', detail: (msg.slice(0, 300) || 'no output') + ' (exit ' + code + ')' });
    });
  });
}

// ---------------- 保护 ----------------
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { notes: [] }; } }
function checkGuard(now = Date.now()) {
  if (fs.existsSync(STOP_FILE)) return { ok: false, error: 'stopped', detail: 'stop file present: ' + STOP_FILE };
  const st = loadState();
  const recent = (st.notes || []).filter((t) => now - t < 3600_000);
  const last = recent.length ? Math.max(...recent) : 0;
  if (now - last < MIN_GAP) return { ok: false, error: 'too_soon', retry_after_ms: MIN_GAP - (now - last) };
  if (recent.length >= MAX_PER_HOUR) return { ok: false, error: 'hourly_limit', limit: MAX_PER_HOUR, retry_after_ms: 3600_000 - (now - Math.min(...recent)) };
  return null;
}
function recordNote(now = Date.now()) {
  const st = loadState();
  st.notes = [...(st.notes || []).filter((t) => now - t < 3600_000), now];
  fs.writeFileSync(STATE_FILE, JSON.stringify(st));
}

// ---------------- 工具 ----------------
const intIn = (v, lo, hi, dflt) => { if (v === undefined || v === null) return dflt; return Number.isInteger(v) && v >= lo && v <= hi ? v : NaN; };
export async function callTool(name, args = {}) {
  if (name === 'xhs_read_me') {
    if (Object.keys(args).length) return { ok: false, error: 'bad_argument', detail: 'xhs_read_me takes no arguments' };
    const g = checkGuard(); if (g) return g;
    recordNote();                                          // 读自己的主页也算一次页面访问，和读笔记共用间隔和每小时上限
    return runScript(meScript());
  }
  if (name === 'xhs_check_login') {
    if (Object.keys(args).length) return { ok: false, error: 'bad_argument', detail: 'xhs_check_login takes no arguments' };
    const stop = checkGuard(); if (stop && stop.error === 'stopped') return stop;
    return runScript(checkScript());
  }
  if (name === 'xhs_read_feed') {
    const scrolls = intIn(args.scrolls, 0, 3, 0);
    if (Number.isNaN(scrolls)) return { ok: false, error: 'bad_argument', detail: 'scrolls must be an integer 0-3' };
    const stop = checkGuard(); if (stop && stop.error === 'stopped') return stop;
    return runScript(feedScript(scrolls));
  }
  if (name === 'xhs_read_note') {
    if (typeof args.id !== 'string' || !NOTE_ID.test(args.id)) return { ok: false, error: 'bad_argument', detail: 'id must be a 24-character lowercase hex note id taken from xhs_read_feed' };
    const scrollNote = intIn(args.scroll_note, 0, 3, 0);
    if (Number.isNaN(scrollNote)) return { ok: false, error: 'bad_argument', detail: 'scroll_note must be an integer 0-3' };
    const g = checkGuard(); if (g) return g;
    recordNote();                                           // 先记账：失败的尝试也算一次，避免失败后立刻重试变成连续访问
    return runScript(noteScript(args.id, scrollNote));
  }
  return { ok: false, error: 'unknown_tool' };
}
export const TOOLS = [
  { name: 'xhs_read_me', description: '只读：核对登录并读取「我自己」的主页——是否登录（loggedIn）、昵称、小红书号、IP 属地、简介、标签、关注/粉丝/获赞、主页上可见的笔记标题。未登录时只返回 loggedIn:false，不读别的。只打开自己的主页这一页，不点开笔记，不改任何东西。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'xhs_check_login', description: '只读：检查 ego lite 里的小红书是否真的登录了（返回 loggedIn / guest）。小红书游客也能看信息流，所以读内容前先用它确认；loggedIn 为 false 时请让用户在 ego lite 里自己扫码登录，不要继续。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'xhs_read_feed', description: '只读：读小红书首页信息流当前可见的笔记卡片（id、标题、作者、点赞）。可选先用鼠标滚轮向下滚动 0-3 次加载更多。需要用户已在 ego lite 里登录小红书。',
    inputSchema: { type: 'object', properties: { scrolls: { type: 'integer', minimum: 0, maximum: 3 } }, additionalProperties: false } },
  { name: 'xhs_read_note', description: '只读：点开信息流里当前可见的某张笔记卡片，读标题、正文、话题、作者、日期、图片数、互动数，然后关闭。id 必须来自刚才的 xhs_read_feed。两次读取至少间隔 20 秒，每小时最多 12 篇。不点赞、不收藏、不关注、不评论。',
    inputSchema: { type: 'object', properties: { id: { type: 'string', pattern: '^[0-9a-f]{24}$' }, scroll_note: { type: 'integer', minimum: 0, maximum: 3 } }, required: ['id'], additionalProperties: false } },
];

// ---------------- MCP（stdio，换行分隔的 JSON-RPC 2.0） ----------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rl = readline.createInterface({ input: process.stdin });
  const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  rl.on('line', async (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ego-reader', version: '0.1.0' } } });
    if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } });
    if (m.method === 'tools/call') {
      const r = await callTool(m.params?.name, m.params?.arguments || {});
      return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(r) }], isError: r.ok === false } });
    }
    if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });   // ping 等
  });
}
