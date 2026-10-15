// 小红书运营工作台 · 本地服务（零依赖，仅用 Node 内置模块）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { P, SKILL_DIR, WORKSPACE } from './paths.mjs';
import * as store from './store.mjs';
import { Bridge, detectAdapters, pingAdapter } from './bridge.mjs';
import { ADAPTERS, findAdapter } from './adapters.mjs';
import { buildPrompt } from './prompt.mjs';
import * as content from './content.mjs';
import * as ops from './automation.mjs';

export const VERSION = '0.3.0';
const PORT_RANGE = [17890, 17910];

store.ensureWorkspace();
const token = loadOrCreateToken();
const bridge = new Bridge();

function loadOrCreateToken() {
  try {
    const t = fs.readFileSync(P.token, 'utf8').trim();
    if (t) return t;
  } catch {
    /* 首次启动 */
  }
  const t = crypto.randomBytes(18).toString('hex');
  fs.writeFileSync(P.token, t, { mode: 0o600 });
  return t;
}

// ---------- 实时推送（SSE） ----------

const sseClients = new Set();
function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) res.write(data);
}
setInterval(() => {
  for (const res of sseClients) res.write(': ping\n\n');
}, 25_000).unref();

// 数据目录被 agent 改动时通知前端刷新
function watch(dir, type) {
  let timer = null;
  try {
    fs.watch(dir, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => broadcast({ type }), 300);
    });
  } catch {
    /* 个别平台不支持递归监听，前端仍可手动刷新 */
  }
}
watch(P.knowledge, 'knowledge.changed');
watch(P.config, 'config.changed');

// 账号业务数据：按「账号 + 模块」合并通知，前端只刷新相关面板
const contentChanges = new Map();
let contentTimer = null;
try {
  fs.watch(P.accountsDir, { recursive: true }, (_evt, filename) => {
    if (!filename) return;
    const [account, rawArea] = String(filename).split(/[\\/]/);
    const area = rawArea && rawArea.replace(/\.json$/, '');
    if (!account || !area) return;
    contentChanges.set(`${account}/${area}`, { account, area });
    clearTimeout(contentTimer);
    contentTimer = setTimeout(() => {
      for (const ev of contentChanges.values()) broadcast({ type: 'content.changed', ...ev });
      contentChanges.clear();
    }, 300);
  });
} catch {
  /* 同上 */
}

// ---------- 对话会话 ----------

const sessions = new Map(); // 内存缓存
const taskIndex = new Map(); // taskId -> { sessionId, msgId }

function getSession(id) {
  if (sessions.has(id)) return sessions.get(id);
  const s = store.loadChat(id);
  if (!s) return null;
  // 服务重启前未完成的消息标记为中断
  for (const m of s.messages) {
    if (m.role === 'assistant' && (m.status === 'pending' || m.status === 'running')) {
      m.status = 'error';
      m.error = '服务重启，任务已中断';
    }
  }
  sessions.set(id, s);
  return s;
}

function isBusy(session) {
  const last = session.messages[session.messages.length - 1];
  return !!last && last.role === 'assistant' && (last.status === 'pending' || last.status === 'running');
}

const saveTimers = new Map();
function saveSoon(session) {
  clearTimeout(saveTimers.get(session.id));
  saveTimers.set(session.id, setTimeout(() => store.saveChat(session), 800));
}
function saveNow(session) {
  clearTimeout(saveTimers.get(session.id));
  store.saveChat(session);
}

function lookupTask(taskId) {
  const ref = taskIndex.get(taskId);
  if (!ref) return {};
  const session = getSession(ref.sessionId);
  const msg = session && session.messages.find((m) => m.id === ref.msgId);
  return { session, msg };
}

bridge.on('claimed', ({ taskId }) => {
  const { session, msg } = lookupTask(taskId);
  if (!msg) return;
  msg.status = 'running';
  saveSoon(session);
  broadcast({ type: 'chat.status', sessionId: session.id, msgId: msg.id, status: 'running' });
});

bridge.on('delta', ({ taskId, text }) => {
  const { session, msg } = lookupTask(taskId);
  if (!msg) return;
  msg.status = 'running';
  msg.text += text;
  saveSoon(session);
  broadcast({ type: 'chat.delta', sessionId: session.id, msgId: msg.id, text });
});

bridge.on('tool', ({ taskId, name, detail }) => {
  const { session, msg } = lookupTask(taskId);
  if (!msg) return;
  msg.status = 'running';
  msg.tools.push({ name, detail });
  saveSoon(session);
  broadcast({ type: 'chat.tool', sessionId: session.id, msgId: msg.id, name, detail });
});

bridge.on('session', ({ taskId, agentSessionId }) => {
  const { session } = lookupTask(taskId);
  if (!session) return;
  session.agentSessionId = agentSessionId;
  session.agentAdapterId = bridge.config()?.adapter?.id || null;
});

bridge.on('done', ({ taskId, text, agentSessionId }) => {
  scheduler.onTaskFinished(taskId, true);
  const { session, msg } = lookupTask(taskId);
  taskIndex.delete(taskId);
  if (!msg) return;
  if (text) msg.text = text;
  if (agentSessionId) session.agentSessionId = agentSessionId;
  msg.status = 'done';
  msg.finishedAt = new Date().toISOString();
  saveNow(session);
  broadcast({ type: 'chat.done', sessionId: session.id, msg });
});

bridge.on('error', ({ taskId, message }) => {
  scheduler.onTaskFinished(taskId, false, message);
  const { session, msg } = lookupTask(taskId);
  taskIndex.delete(taskId);
  if (!msg) return;
  msg.status = 'error';
  msg.error = message;
  msg.finishedAt = new Date().toISOString();
  saveNow(session);
  broadcast({ type: 'chat.done', sessionId: session.id, msg });
});

function sendChat({ sessionId, accountId, text }) {
  text = String(text || '').trim();
  if (!text) throw store.httpError(400, '消息不能为空');
  const cfg = bridge.config();
  if (!cfg) throw store.httpError(409, '尚未完成连接设置，请回到你的 agent 里说「运行小红书工作台连接自检」');

  const account = store.getAccount(accountId);
  let session = sessionId ? getSession(sessionId) : null;
  if (!session) {
    session = {
      id: store.newId('chat_'),
      title: text.slice(0, 24),
      accountId: account.id,
      createdAt: new Date().toISOString(),
      agentSessionId: null,
      agentAdapterId: null,
      messages: [],
    };
    sessions.set(session.id, session);
  }
  if (isBusy(session)) throw store.httpError(409, '上一条消息还在处理中');
  session.accountId = account.id;

  const now = new Date().toISOString();
  const userMsg = { id: store.newId('m_'), role: 'user', text, createdAt: now };
  session.messages.push(userMsg);

  // CLI 模式下能续接同一个 agent 会话时，不必重复塞历史
  const canResume =
    cfg.mode === 'cli' && cfg.adapter.resumeArgs && session.agentSessionId && session.agentAdapterId === cfg.adapter.id;
  const prompt = buildPrompt({ session, account, text, includeHistory: !canResume });

  const asstMsg = {
    id: store.newId('m_'),
    role: 'assistant',
    text: '',
    status: cfg.mode === 'cli' ? 'running' : 'pending',
    tools: [],
    createdAt: now,
  };
  session.messages.push(asstMsg);
  saveNow(session);

  const taskId = asstMsg.id;
  taskIndex.set(taskId, { sessionId: session.id, msgId: asstMsg.id });
  try {
    bridge.submit({ id: taskId, sessionId: session.id, prompt, agentSessionId: canResume ? session.agentSessionId : null });
  } catch (err) {
    taskIndex.delete(taskId);
    asstMsg.status = 'error';
    asstMsg.error = err.message;
    saveNow(session);
  }
  return { session };
}

function cancelChat(sessionId) {
  const session = getSession(sessionId);
  if (!session) throw store.httpError(404, '会话不存在');
  const last = session.messages[session.messages.length - 1];
  if (!last || !isBusy(session)) return false;
  return bridge.cancel(last.id);
}

// ---------- 定时自动任务 ----------

// 自动任务统一发到每个账号的「⏰ 自动任务」会话里，用户随时可以去对话里看过程
function runAutomationTask(accountId, text) {
  const cfg = ops.getAutomation(accountId);
  let session = cfg.sessionId ? getSession(cfg.sessionId) : null;
  if (session && isBusy(session)) return null;
  try {
    const res = sendChat({ sessionId: session ? session.id : null, accountId, text });
    session = res.session;
  } catch (err) {
    log(`自动任务未能提交：${err.message}`);
    return null;
  }
  if (session.title !== '⏰ 自动任务') {
    session.title = '⏰ 自动任务';
    saveNow(session);
  }
  if (cfg.sessionId !== session.id) ops.saveAutomation(accountId, { sessionId: session.id });
  broadcast({ type: 'chats.changed' });
  const last = session.messages[session.messages.length - 1];
  return last.status === 'error' ? null : last.id;
}

const scheduler = new ops.Scheduler({ runTask: runAutomationTask, notify: broadcast, log });
scheduler.start();

// ---------- HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 25 * 1024 * 1024) {
        reject(store.httpError(413, '请求体过大'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(store.httpError(400, 'JSON 格式错误'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  let file;
  try {
    file = store.safeJoin(P.web, rel);
  } catch {
    return sendJson(res, 400, { error: '路径不合法' });
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return sendJson(res, 404, { error: '未找到' });
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

let detectedCache = null;
function detected() {
  if (!detectedCache) detectedCache = detectAdapters(ADAPTERS).map(({ id, name, command }) => ({ id, name, command }));
  return detectedCache;
}

async function handleApi(req, res, url) {
  const { pathname, searchParams: q } = url;
  const method = req.method;
  const route = `${method} ${pathname}`;

  switch (route) {
    case 'GET /api/state':
      return sendJson(res, 200, {
        version: VERSION,
        workspace: WORKSPACE,
        skillDir: SKILL_DIR,
        bridge: bridge.status(),
        accounts: store.getAccounts(),
      });

    // ----- 连接 -----
    case 'GET /api/bridge':
      return sendJson(res, 200, { status: bridge.status(), config: bridge.config() });
    case 'GET /api/bridge/detect':
      if (q.get('refresh')) detectedCache = null;
      return sendJson(res, 200, { adapters: detected() });
    case 'POST /api/bridge/test': {
      const cfg = bridge.config();
      if (!cfg) throw store.httpError(409, '尚未配置连接');
      if (cfg.mode === 'inbox') return sendJson(res, 200, { ok: bridge.status().inboxOnline, mode: 'inbox' });
      const result = await pingAdapter(cfg.adapter);
      if (result.ok) store.saveBridgeConfig({ ...cfg, testedAt: new Date().toISOString() });
      broadcast({ type: 'bridge.changed' });
      return sendJson(res, 200, { ...result, mode: 'cli' });
    }
    case 'PUT /api/bridge': {
      const body = await readBody(req);
      const prev = bridge.config() || {};
      if (body.mode === 'inbox') {
        store.saveBridgeConfig({ ...prev, mode: 'inbox', testedAt: new Date().toISOString() });
        broadcast({ type: 'bridge.changed' });
        return sendJson(res, 200, { ok: true });
      }
      const base = findAdapter(body.adapterId);
      const found = detected().find((a) => a.id === body.adapterId);
      if (!base || !found) throw store.httpError(400, '本机未检测到该 agent');
      const adapter = { ...base, command: found.command };
      const result = await pingAdapter(adapter);
      if (!result.ok) return sendJson(res, 200, result);
      store.saveBridgeConfig({ ...prev, mode: 'cli', adapter, testedAt: new Date().toISOString() });
      broadcast({ type: 'bridge.changed' });
      return sendJson(res, 200, result);
    }

    // ----- 账号 -----
    case 'GET /api/accounts':
      return sendJson(res, 200, store.getAccounts());
    case 'POST /api/accounts': {
      const acc = store.saveAccount(await readBody(req));
      broadcast({ type: 'accounts.changed' });
      return sendJson(res, 200, acc);
    }
    case 'POST /api/accounts/default': {
      store.setDefaultAccount((await readBody(req)).id);
      broadcast({ type: 'accounts.changed' });
      return sendJson(res, 200, { ok: true });
    }

    // ----- 知识库 -----
    case 'GET /api/knowledge':
      return sendJson(res, 200, store.listKnowledge());
    case 'GET /api/knowledge/search':
      return sendJson(res, 200, { results: store.searchKnowledge(q.get('q')) });
    case 'GET /api/knowledge/file':
      return sendJson(res, 200, store.readKnowledge(q.get('path')));
    case 'PUT /api/knowledge/file': {
      const body = await readBody(req);
      return sendJson(res, 200, store.writeKnowledge(body.path, body.content));
    }
    case 'DELETE /api/knowledge/file':
      store.trashKnowledge(q.get('path'));
      return sendJson(res, 200, { ok: true });

    // ----- 对话 -----
    case 'GET /api/chats':
      return sendJson(res, 200, { sessions: store.listChats() });
    case 'GET /api/chat': {
      const s = getSession(q.get('id') || '');
      if (!s) throw store.httpError(404, '会话不存在');
      return sendJson(res, 200, s);
    }
    case 'DELETE /api/chat':
      sessions.delete(q.get('id'));
      store.trashChat(q.get('id') || '');
      return sendJson(res, 200, { ok: true });
    case 'POST /api/chat/send': {
      const { session } = sendChat(await readBody(req));
      broadcast({ type: 'chats.changed' });
      return sendJson(res, 200, session);
    }
    case 'POST /api/chat/cancel':
      return sendJson(res, 200, { ok: cancelChat((await readBody(req)).sessionId) });

    // ----- 收件箱模式：agent 领取 / 回写任务 -----
    case 'GET /api/agent/next': {
      const wait = Math.min(Math.max(Number(q.get('wait')) || 0, 0), 600) * 1000;
      const before = bridge.status().inboxOnline;
      const pending = bridge.next(wait);
      if (!before) broadcast({ type: 'bridge.changed' });
      const task = await pending;
      // 长轮询期间 agent 已断开：把任务放回队列，下次再领
      if (task && res.socket && res.socket.destroyed) return bridge.requeue(task.id);
      return sendJson(res, 200, { task });
    }
    case 'POST /api/agent/reply': {
      const body = await readBody(req);
      const ok = bridge.reply(body.taskId, { text: body.text, final: !!body.final, error: body.error });
      if (!ok) throw store.httpError(410, '任务不存在或已被取消');
      return sendJson(res, 200, { ok: true });
    }
  }
  const result = (await handleContentApi(route, q, req)) ?? (await handleOpsApi(route, q, req));
  if (result !== undefined) return sendJson(res, 200, result);
  throw store.httpError(404, `未知接口 ${route}`);
}

// M2 内容接口：对标、选题、笔记、封面。返回 undefined 表示不是这里的接口
async function handleContentApi(route, q, req) {
  const acc = q.get('account');
  const body = () => readBody(req);
  switch (route) {
    case 'GET /api/benchmarks':
      return { items: content.listBenchmarks(acc) };
    case 'GET /api/benchmarks/detail':
      return content.benchmarkDetail(acc, q.get('id'));
    case 'POST /api/benchmarks':
      return content.saveBenchmark(acc, await body());
    case 'POST /api/benchmarks/upload': {
      const b = await body();
      return { path: content.uploadBenchmarkShot(acc, b.id, b.filename, b.data) };
    }
    case 'DELETE /api/benchmarks':
      content.deleteBenchmark(acc, q.get('id'));
      return { ok: true };

    case 'GET /api/topics':
      return { items: content.listTopics(acc) };
    case 'POST /api/topics':
      return content.saveTopic(acc, await body());
    case 'DELETE /api/topics':
      content.deleteTopic(acc, q.get('id'));
      return { ok: true };

    case 'GET /api/notes':
      return { items: content.listNotes(acc) };
    case 'GET /api/notes/detail':
      return content.noteDetail(acc, q.get('id'));
    case 'POST /api/notes':
      return content.saveNote(acc, await body());
    case 'POST /api/notes/upload': {
      const b = await body();
      return { name: content.uploadNoteImage(acc, b.id, b.filename, b.data) };
    }
    case 'POST /api/notes/cover': {
      const b = await body();
      return content.saveCoverImage(acc, b.id, b.data, b.hash);
    }
    case 'DELETE /api/notes':
      content.deleteNote(acc, q.get('id'));
      return { ok: true };
  }
  return undefined;
}

// M3 运营接口：排期、评论私信、数据复盘、自动化设置、提醒
async function handleOpsApi(route, q, req) {
  const acc = q.get('account');
  const body = () => readBody(req);
  switch (route) {
    case 'GET /api/alerts':
      return { items: ops.alerts() };
    case 'GET /api/automation':
      return ops.getAutomation(acc);
    case 'POST /api/automation':
      return ops.saveAutomation(acc, await body());

    case 'GET /api/schedule':
      return { items: ops.listSchedule(acc) };
    case 'POST /api/schedule':
      return ops.scheduleNote(acc, await body());
    case 'POST /api/schedule/update':
      return ops.updateSchedule(acc, await body());
    case 'DELETE /api/schedule':
      ops.deleteSchedule(acc, q.get('id'));
      return { ok: true };

    case 'GET /api/engage':
      return { items: ops.listEngage(acc) };
    case 'POST /api/engage':
      return ops.saveEngage(acc, await body());

    case 'GET /api/analytics':
      return ops.getAnalytics(acc);
    case 'GET /api/analytics/report':
      return ops.readReport(acc, q.get('name'));
    case 'POST /api/analytics/upload': {
      const b = await body();
      return { name: ops.uploadImport(acc, b.filename, b.data) };
    }
  }
  return undefined;
}

function serveAccountFile(res, q) {
  let file;
  try {
    file = content.accountFile(q.get('account'), q.get('path'));
  } catch (err) {
    return sendJson(res, err.status || 500, { error: err.message });
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

function hostAllowed(req, port) {
  const host = (req.headers.host || '').toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function createServer(port) {
  return http.createServer(async (req, res) => {
    // 只接受本机地址访问，防 DNS 重绑定
    if (!hostAllowed(req, port)) return sendJson(res, 403, { error: 'forbidden host' });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const { pathname } = url;

    if (pathname === '/api/health') return sendJson(res, 200, { ok: true, name: 'xhs-workbench', version: VERSION });

    if (pathname.startsWith('/api/')) {
      // 所有接口都要求令牌；自定义请求头让跨站请求无法通过预检
      // EventSource 和 <img> 无法带请求头，这两个只读接口允许用查询参数传令牌
      const queryTokenOk = pathname === '/api/events' || pathname === '/api/files';
      const given = req.headers['x-workbench-token'] || (queryTokenOk ? url.searchParams.get('t') : null);
      if (given !== token) return sendJson(res, 401, { error: '令牌无效，请让 agent 重新打开工作台' });

      if (pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ type: 'hello', bridge: bridge.status() })}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }
      if (pathname === '/api/files') return serveAccountFile(res, url.searchParams);
      try {
        return await handleApi(req, res, url);
      } catch (err) {
        if (!err.status) log(`接口错误 ${req.method} ${pathname}: ${err.stack || err.message}`);
        return sendJson(res, err.status || 500, { error: err.message });
      }
    }
    return serveStatic(req, res, pathname);
  });
}

function log(line) {
  fs.appendFileSync(path.join(P.logs, 'server.log'), `[${new Date().toISOString()}] ${line}\n`);
}

// 依次尝试端口，第一个可用的即用
async function listen() {
  for (let port = PORT_RANGE[0]; port <= PORT_RANGE[1]; port++) {
    const server = createServer(port);
    const ok = await new Promise((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (ok) return { server, port };
  }
  throw new Error(`端口 ${PORT_RANGE[0]}-${PORT_RANGE[1]} 都被占用`);
}

const { port } = await listen();
const info = {
  pid: process.pid,
  port,
  url: `http://127.0.0.1:${port}/`,
  openUrl: `http://127.0.0.1:${port}/?t=${token}`,
  startedAt: new Date().toISOString(),
  version: VERSION,
  skillDir: SKILL_DIR,
};
store.writeJson(P.serverInfo, info);
log(`工作台已启动 ${info.url}（pid ${process.pid}）`);
console.log(`工作台已启动：${info.openUrl}`);

function shutdown() {
  try {
    const cur = store.readJson(P.serverInfo, null);
    if (cur && cur.pid === process.pid) fs.unlinkSync(P.serverInfo);
  } catch {
    /* 忽略 */
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
