import { applyHubDefaults } from './hub-env.mjs';
import { decodeText } from './inbox-files.mjs';
import { readHubServers } from './hub-mcp.mjs';
import { readHubCapabilities, assertBrowserCapability } from './hub-capabilities.mjs';
import {VideoDescriptionWorkflow} from './video-description-workflow.mjs';
import {VideoRetrieval} from './video-retrieval.mjs';
import { hubGen } from './hub-gen.mjs';
import {videoService} from './video-service.mjs';
import {VideoWorkflow} from './video-workflow.mjs';
import { getImageServiceSettings, saveImageServiceSettings, testImageServiceConnection } from './image-service.mjs';
import {browserAccessStatus, assertBrowserAccess, lockBrowserAccess, resumeBrowserAccess, resolveBrowserRestriction} from './access-policy.mjs';
import {LiveTransferService} from './live-transfer.mjs';
import {LivePhotoWorkflow} from './live-photo-workflow.mjs';
import {ImageWorkflow} from './image-workflow.mjs';
import {EngageWorkflow} from './engage-workflow.mjs';
import {AnalyticsWorkflow} from './analytics-workflow.mjs';
import {CoverWorkflow} from './cover-workflow.mjs';
import {CopyWorkflow} from './copy-workflow.mjs';
import { TopicWorkflow, topicSources } from './topic-workflow.mjs';
import { stageDownloadedAvatar, stageVisualEvidence } from './benchmark-observation.mjs';
// 小红书运营工作台 · 本地服务（基础功能零依赖；后台只读浏览器按需加载）
import http from 'node:http';
import { BenchmarkQueue, collectionRoute, collectionStatus, observationComplete } from './benchmark-queue.mjs';
import { paceSummary, paceInstructions, paceText, updatePolicy, assertCollectionAllowed, recordSession, recordChat, onPaceViolation } from './pace.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { P, SKILL_DIR, WORKSPACE } from './paths.mjs';
import * as store from './store.mjs';
import { Bridge, detectAdapters, pingAdapter } from './bridge.mjs';
import { ADAPTERS, findAdapter, findDesktopAgent, detectDesktopAgents } from './adapters.mjs';
import { buildPrompt } from './prompt.mjs';
import { reportHealth } from './health-outbox.mjs';
import { ensureDefaultConnection, codebuddyStatus, checkCodebuddy, openCodebuddyLogin, setBrowserEngine, setBrowserMode, browserOptions } from './agent-setup.mjs';
import * as content from './content.mjs';
import * as ops from './automation.mjs';
import { browserStatus, detectRealBrowser, applyBrowser } from './browser.mjs';
import { BrowserWorker, workerCollectAllowed, WORKER_DISABLED } from './browser-worker.mjs';
import { browserRuntimeStatus, installBrowserRuntimeAsync } from './browser-runtime.mjs';
import { canonicalProfileUrl } from './browser-read.mjs';
import { createZip } from './zip.mjs';
import * as system from './system.mjs';
import * as backup from './backup.mjs';
import * as materials from './materials.mjs';

import { VERSION } from './version.mjs';
import { runStartupUpgrade, upgradeSummary } from './upgrade.mjs';
import { applyProfileSuggestion, suggestionSummary, SUGGESTION_FILE } from './profile-suggestion.mjs';

// 不是由中枢接入器启动时（agent 直接跑技能包副本、开机自启），自动接上本机接入器的配置；所有用到这些变量的地方都是用时才读
applyHubDefaults();
// 没有连接配置、本机装了 CodeBuddy CLI 时直接连它；然后在后台检查一次它有没有登录（网页上显示）
if (process.env.XHS_NO_AUTO_CONNECT !== '1') {  // 测试里关掉：不去碰开发机上真实的 CodeBuddy
  if (ensureDefaultConnection()) console.log('已自动连接 CodeBuddy CLI（可在「连接与设置」里修改）');
  if (codebuddyStatus().installed) checkCodebuddy().catch(() => {});
}
export { VERSION };
const PORT_RANGE = [17890, 17910];

const hadData = fs.existsSync(P.accounts);
store.ensureWorkspace();
// 版本变化时先自动备份再迁移；备份失败或数据来自更新版本时不改动任何数据
const startupUpgrade = runStartupUpgrade({
  appVersion: VERSION, hadData, workspace: WORKSPACE,
  backup: (kind) => backup.createBackup({ prefix: kind === 'legacy' ? 'upgrade-legacy' : 'upgrade' }),
});
if (startupUpgrade.kind === 'blocked') {
  console.error(startupUpgrade.error);
  process.exit(1);
}
await ensureSingleInstance();
const token = loadOrCreateToken();

// 同一个数据目录只允许一个工作台在运行，否则两个调度器会重复发布
async function ensureSingleInstance() {
  const other = store.readJson(P.serverInfo, null);
  if (!other || other.pid === process.pid) return;
  try {
    process.kill(other.pid, 0);
  } catch {
    return; // 进程已不在
  }
  try {
    const res = await fetch(`http://127.0.0.1:${other.port}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (res.ok && (await res.json()).name === 'xhs-workbench') {
      console.log(`工作台已在运行（pid ${other.pid}，端口 ${other.port}），本次启动退出。`);
      process.exit(0);
    }
  } catch {
    /* 端口没响应，视为旧记录 */
  }
}
const browserWorker = new BrowserWorker({
  detect: () => bridge.config()?.adapter?.browserChannel || detectRealBrowser(),
  onState: (account) => broadcast({ type: 'browser.changed', account }),
});
function workerInfo() {
  const cfg = bridge.config();
  const runtime = browserRuntimeStatus();
  const allowed = workerCollectAllowed();   // 停用时：不管设置里写的什么，都按「没开、不兼容」处理，采集只剩 WorkBuddy 插件这条路
  const enabled = allowed && !!store.readJson(P.settings, {}).backgroundBrowser;
  return { enabled, available: runtime.available, disabled: !allowed,
    compatible: allowed && cfg?.mode === 'cli' && cfg.browser === 'playwright' && !!cfg.adapter?.playwrightMcp
      && (cfg.adapter?.args?.includes('{mcpConfig}') || (cfg.adapter?.id==='codex' && cfg.adapter?.browserTransport==='codex')) && !cfg.adapter?.headless,
    fastModel: cfg?.adapter?.id === 'claude-code' ? store.readJson(P.settings, {}).fastReadModel || '' : '',
    accounts: browserWorker.status(), access: Object.fromEntries(store.listAccounts().map(a=>[a.id,browserAccessStatus(a.id)])) };
}

function writeVerifiedCheckpoint(task, result) {
  // 与 agent 相同的逐条检查点合同。先落盘、立即合并，冲突保留在 rejected/，不直改 index.json。
  const { accountId } = task;
  const liveAccount = store.getAccount(accountId);
  if (liveAccount?.xhsId !== task.account.xhsId) throw new Error('当前账号的小红书号在任务期间已改变，核实结果未保存；请重新核对');
  const current = content.benchmarkDetail(accountId, task.benchmark.id).item;
  if (['name', 'xhsId', 'url'].some((key) => (current[key] || '') !== (task.benchmark[key] || ''))) {
    throw new Error('对标账号身份信息在任务期间已修改，核实结果未保存；请重新核对');
  }
  const dir = path.join(P.accountsDir, accountId, 'benchmarks', 'checkpoints', 'pending');
  const file = path.join(dir, `${current.id}.verified.json`);
  if (fs.existsSync(file)) throw new Error('已有未处理的核实检查点，请先处理冲突后再重试');
  store.writeJson(file, { id: current.id, stage: 'verified', url: result.url,
    xhsId: result.xhsId, profileName: result.profileName, followers: result.followers,
    observedAt: result.observedAt, source: 'profile-visible' });
  const applied = content.reconcileBenchmarkCheckpoints(accountId);
  if (applied.verified !== 1) throw new Error('核实检查点未能合并，请检查 checkpoints/rejected/ 的原因文件');
  broadcast({ type: 'content.changed', account: accountId, area: 'benchmarks' });
}
function writeObservationCheckpoint(task, result) {
  const { accountId } = task;
  if (store.getAccount(accountId)?.xhsId !== task.account.xhsId) throw new Error('工作台账号信息在观察期间已改变');
  const current = content.benchmarkDetail(accountId, task.benchmark.id).item;
  if (current.name !== task.benchmark.name || canonicalProfileUrl(current.url) !== result.url || current.xhsId !== result.xhsId) {
    throw new Error('对标主页身份在观察期间已改变，未保存本次数据');
  }
  const pending = path.join(P.accountsDir, accountId, 'benchmarks', 'checkpoints', 'pending', `${current.id}.observation.json`);
  if (fs.existsSync(pending)) throw new Error('已有尚未处理的观察检查点，请先检查冲突');
  let avatarFile;
  let warning = '';
  if (result.avatarDownloaded) {
    try { avatarFile = stageDownloadedAvatar(accountId, current.id, result.avatarDownloaded.buffer, result.avatarDownloaded.ext); }
    catch (err) { warning = `下载头像未能保存：${err.message.slice(0, 100)}`; }
  } else if (result.avatarPng) {
    try { avatarFile = content.stageBenchmarkAvatar(accountId, current.id, result.avatarPng); }
    catch (err) { warning = `头像截图未能保存：${err.message.slice(0, 100)}`; }
  }
  const profileEvidence = result.profileEvidence ? stageVisualEvidence(accountId, current.id, result.profileEvidence) : undefined;
  const noteEvidence = result.noteEvidence ? stageVisualEvidence(accountId, current.id, result.noteEvidence) : undefined;
  const reason = [result.reason, warning].filter(Boolean).join('；').slice(0, 240);
  store.writeJson(pending, { stage: 'observation', id: current.id, url: result.url, xhsId: result.xhsId,
    profileName: result.profileName, observedAt: result.observedAt, source: 'worker-visible',
    state: warning && result.state === 'complete' ? 'partial' : result.state, reason,
    ...(result.profile ? { profile: result.profile } : {}),
    ...(result.notes ? { notes: result.notes.map(n => ({ ...n, ...(noteEvidence ? { evidence: noteEvidence } : {}) })) } : {}),
    ...(profileEvidence ? { profileEvidence } : {}),
    ...(result.visibleNoteUrls ? { visibleNoteUrls: result.visibleNoteUrls } : {}),
    ...(result.discoveredCount !== undefined ? { discoveredCount: result.discoveredCount } : {}),
    ...(result.attemptedCount !== undefined ? { attemptedCount: result.attemptedCount } : {}),
    ...(avatarFile ? { avatarFile } : {}) });
  const applied = content.reconcileBenchmarkCheckpoints(accountId);
  if (applied.observations !== 1) throw new Error('观察检查点未能合并，请检查 checkpoints/rejected/ 的原因文件');
  broadcast({ type: 'content.changed', account: accountId, area: 'benchmarks' });
  return { warning };
}

const bridge = new Bridge({ inboxFile: path.join(P.run, 'inbox-tasks.json'), browserWorker, onBenchmarkVerified: writeVerifiedCheckpoint, onBenchmarkObservation: writeObservationCheckpoint,
  onBrowserPrepared: (task, result) => {
    const acc = store.getAccount(task.accountId);
    if (acc && !acc.xhsId && result.filledXhsId) store.saveAccount({ id: acc.id, xhsId: result.xhsId });  // 没填小红书号：用扫码登录的这个
    if (store.getAccount(task.accountId)?.xhsId !== result.xhsId) throw new Error('账号设置已变化，请重新核对登录账号');
    if (browserAccessStatus(task.accountId).kind === 'login') resumeBrowserAccess(task.accountId);  // 「需要登录」的锁：登录好了就解开
    const file = path.join(P.accountsDir, task.accountId, 'browser.json');
    const previous = store.readJson(file, {});
    store.writeJson(file, { loggedIn: true, xhsId: result.xhsId,
      nickname: previous.xhsId === result.xhsId ? previous.nickname || '' : '', checkedAt: new Date().toISOString() });
    broadcast({ type: 'content.changed', account: task.accountId, area: 'browser' });
  },
});

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

// 数据目录被 agent 改动时通知前端刷新。恢复备份会整体替换目录，之后需重新建立监听
let watchers = [];
function watch(dir, onChange) {
  try {
    watchers.push(fs.watch(dir, { recursive: true }, onChange));
  } catch {
    /* 个别平台不支持递归监听，前端仍可手动刷新 */
  }
}
function debounced(fn, ms = 300) {
  let timer = null;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

// 账号业务数据：按「账号 + 模块」合并通知，前端只刷新相关面板
const contentChanges = new Map();
const flushContent = debounced(() => {
  for (const ev of contentChanges.values()) broadcast({ type: 'content.changed', ...ev });
  contentChanges.clear();
});

// agent 登录核对后写的主页分析建议：校验后填进账号里还是空的字段（文件可能被写多次，防抖后再处理）
const suggestionTimers = new Map();
function scheduleProfileSuggestion(accountId) {
  clearTimeout(suggestionTimers.get(accountId));
  suggestionTimers.set(accountId, setTimeout(() => {
    suggestionTimers.delete(accountId);
    try {
      const r = applyProfileSuggestion(accountId);
      if (r.applied.length || r.skipped.length) broadcast({ type: 'content.changed', account: accountId, area: 'accounts' });
    } catch (err) {
      console.error(`主页分析建议套用失败（${accountId}）：${err.message}`);
    }
  }, 600));
}

function startWatchers() {
  for (const w of watchers) w.close();
  watchers = [];
  store.ensureWorkspace();
  watch(P.knowledge, debounced(() => broadcast({ type: 'knowledge.changed' })));
  watch(P.config, debounced(() => broadcast({ type: 'config.changed' })));
  watch(P.accountsDir, (_evt, filename) => {
    if (!filename) return;
    const [account, rawArea] = String(filename).split(/[\\/]/);
    const area = rawArea && rawArea.replace(/\.json$/, '');
    if (!account || !area) return;
    if (rawArea === SUGGESTION_FILE) scheduleProfileSuggestion(account);
    contentChanges.set(`${account}/${area}`, { account, area });
    flushContent();
  });
}
startWatchers();

function flushBenchmarkCheckpoints(accountId) {
  try {
    const saved = content.reconcileBenchmarkCheckpoints(accountId);
    if (saved.candidates || saved.verified || saved.observations || saved.rejected) {
      broadcast({ type: 'content.changed', account: accountId, area: 'benchmarks' });
    }
  } catch (err) {
    console.error(`对标检查点合并失败（${accountId}）：${err.message}`);
  }
}

// 服务重启后也要接续上次已写完但尚未合并的检查点。
for (const account of store.listAccounts()) flushBenchmarkCheckpoints(account.id);

// ---------- 对话会话 ----------

const sessions = new Map(); // 内存缓存
const taskIndex = new Map(); // taskId -> { sessionId, msgId }
// 重启前还在队列里的对话任务：已从磁盘恢复，对应的助手消息保持“等待”，不当成中断
const restoredTaskIds = new Set();

function getSession(id) {
  if (sessions.has(id)) return sessions.get(id);
  const s = store.loadChat(id);
  if (!s) return null;
  // 服务重启前未完成的消息标记为中断
  for (const m of s.messages) {
    if (m.role === 'assistant' && (m.status === 'pending' || m.status === 'running') && !restoredTaskIds.has(m.id)) {
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

function normalModelKey(adapter) {
  if (!adapter) return '';
  const args = adapter.args || [];
  const flag = args.indexOf('--model');
  return flag >= 0 ? String(args[flag + 1] || '') : String(adapter.model || '');
}

function lookupTask(taskId) {
  const ref = taskIndex.get(taskId);
  if (!ref) return {};
  const session = getSession(ref.sessionId);
  const msg = session && session.messages.find((m) => m.id === ref.msgId);
  return { session, msg, ref };
}

const topicWorkflow = new TopicWorkflow({
  changed: account => { broadcast({type:'content.changed',account,area:'topics'}); broadcast({type:'content.changed',account,area:'notes'}); },
  submit: task => {
    const account=store.getAccount(task.accountId);
    if(!account)throw new Error('账号不存在');
    bridge.submit({...task, prompt:buildPrompt({session:{messages:[]},account,text:task.prompt,includeHistory:false})});
  },
});
topicWorkflow.recover();
const analyticsWorkflow=new AnalyticsWorkflow({
 changed:account=>broadcast({type:'content.changed',account,area:'analytics'}),
 submit:task=>{const account=store.getAccount(task.accountId);if(!account)throw new Error('账号不存在');bridge.submit({...task,prompt:buildPrompt({session:{messages:[]},account,text:task.prompt,includeHistory:false})});},
});
analyticsWorkflow.recover();
const engageWorkflow=new EngageWorkflow({
 changed:account=>broadcast({type:'content.changed',account,area:'engage'}),
 submit:task=>{const account=store.getAccount(task.accountId);if(!account)throw new Error('账号不存在');bridge.submit({...task,prompt:buildPrompt({session:{messages:[]},account,text:task.prompt,includeHistory:false})});},
});
engageWorkflow.recover();

const copyWorkflow = new CopyWorkflow({
  changed: account => broadcast({type:'content.changed',account,area:'notes'}),
  submit: task => {
    const account=store.getAccount(task.accountId);
    if(!account)throw new Error('账号不存在');
    bridge.submit({...task,prompt:buildPrompt({session:{messages:[]},account,text:task.prompt,includeHistory:false})});
  },
});
copyWorkflow.recover();
const videoWorkflow = new VideoWorkflow({changed:account=>broadcast({type:'content.changed',account,area:'videos'})});
const videoDescriptions = new VideoDescriptionWorkflow({references:videoWorkflow.videoReferences,changed:account=>broadcast({type:'content.changed',account,area:'videos'}),submit:task=>bridge.submitLocalDescription(task),
  // 换了 agent / 重新测试连接后，之前的看图自检结果不再沿用
  visionKey:()=>{const c=bridge.config()||{};return crypto.createHash('sha256').update(JSON.stringify([c.mode,c.adapter?.id,c.adapter?.command,c.hostAgent?.id,c.testedAt])).digest('hex').slice(0,16);}});
videoDescriptions.recover();
const videoRetrieval = new VideoRetrieval({workflow:videoWorkflow,accounts:store.listAccounts});
setInterval(()=>videoRetrieval.tick().catch(()=>{}),5000).unref();
const imageWorkflow = new ImageWorkflow({changed:account=>broadcast({type:'content.changed',account,area:'notes'})});
// 图片任务的后台取回：中枢 / APIMart 出好图后由工作台下载。以前只有「图片创作」页开着才会查，页面一关任务就一直显示「进行中」，
// 员工以为没成功、重复提交（白烧额度）。这里每 10 秒查一次进行中的任务（只查已有任务编号的，绝不提交新的生图）
setInterval(() => { for (const a of store.listAccounts()) imageWorkflow.pollActive(a.id).catch(() => {}); }, 10_000).unref();
const livePhotoWorkflow = new LivePhotoWorkflow({images:imageWorkflow,changed:account=>broadcast({type:'content.changed',account,area:'live'})});
livePhotoWorkflow.recover();
const liveTransfer = new LiveTransferService({live:livePhotoWorkflow});
const coverWorkflow = new CoverWorkflow({
  changed: account => broadcast({type:'content.changed',account,area:'notes'}),
  submit: task => {
    const account=store.getAccount(task.accountId);
    if(!account)throw new Error('账号不存在');
    bridge.submit({...task,prompt:buildPrompt({session:{messages:[]},account,text:task.prompt,includeHistory:false})});
  },
});
coverWorkflow.recover();

const restoredFromDisk = bridge.restored.length;
for (const t of bridge.restored) {
  restoredTaskIds.add(t.id);
  taskIndex.set(t.id, { sessionId: t.sessionId, msgId: t.id, accountId: t.accountId, adapterId: null, modelKey: '' });
}

bridge.on('claimed', ({ taskId }) => {
  topicWorkflow.progress(taskId, 'agent 正在处理');
  engageWorkflow.progress(taskId);
  analyticsWorkflow.progress(taskId);
  copyWorkflow.progress(taskId);
  videoDescriptions.progress(taskId);
  coverWorkflow.progress(taskId);
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
  engageWorkflow.progress(taskId);
  analyticsWorkflow.progress(taskId);
  copyWorkflow.progress(taskId);
  videoDescriptions.progress(taskId);
  coverWorkflow.progress(taskId);
  topicWorkflow.progress(taskId, ({Read:'读取资料',Write:'保存生成结果',Edit:'整理生成结果',Bash:'处理任务'})[name] || 'agent 正在处理');
  const { session, msg } = lookupTask(taskId);
  if (!msg) return;
  msg.status = 'running';
  msg.tools.push({ name, detail });
  saveSoon(session);
  broadcast({ type: 'chat.tool', sessionId: session.id, msgId: msg.id, name, detail });
});

bridge.on('session', ({ taskId, agentSessionId }) => {
  const { session, ref } = lookupTask(taskId);
  if (!session) return;
  session.agentSessionId = agentSessionId;
  session.agentAdapterId = ref.adapterId;
  session.agentAccountId = ref.accountId;
  session.agentModelTier = 'normal';
  session.agentModelKey = ref.modelKey;
});

bridge.on('done', ({ taskId, text, agentSessionId }) => {
  engageWorkflow.finish(taskId);
  analyticsWorkflow.finish(taskId);
  topicWorkflow.finish(taskId);
  copyWorkflow.finish(taskId);
  videoDescriptions.finish(taskId, '', text);
  coverWorkflow.finish(taskId);
  scheduler.onTaskFinished(taskId, true);
  for (const a of store.listAccounts()) flushBenchmarkCheckpoints(a.id);
  collectionQueue.finish(taskId, text);
  const { session, msg } = lookupTask(taskId);
  taskIndex.delete(taskId);
  if (!msg) return;
  flushBenchmarkCheckpoints(session.accountId);
  if (text) msg.text = text;
  if (agentSessionId) session.agentSessionId = agentSessionId;
  msg.status = 'done';
  msg.finishedAt = new Date().toISOString();
  saveNow(session);
  broadcast({ type: 'chat.done', sessionId: session.id, msg });
});

bridge.on('error', ({ taskId, message }) => {
  // 应用健康：任务失败回传企业中枢（用户取消、切换连接这类不是故障的不记）
  if (!/^(已取消|连接模式已变更)/.test(message || '')) reportHealth({ stage: 'task', ok: false, message, agent: bridge.config()?.adapter?.name || bridge.config()?.hostAgent?.name || '' });
  engageWorkflow.finish(taskId, message);
  analyticsWorkflow.finish(taskId, message);
  topicWorkflow.finish(taskId, message);
  copyWorkflow.finish(taskId, message);
  videoDescriptions.finish(taskId, message);
  coverWorkflow.finish(taskId, message);
  scheduler.onTaskFinished(taskId, false, message);
  for (const a of store.listAccounts()) flushBenchmarkCheckpoints(a.id);
  collectionQueue.finish(taskId, message);
  const { session, msg } = lookupTask(taskId);
  taskIndex.delete(taskId);
  if (!msg) return;
  flushBenchmarkCheckpoints(session.accountId);
  collectionQueue.block(session.accountId, message);
  msg.status = 'error';
  msg.error = /超时/.test(message) ? `${message}。已落盘的结果会保留；未写入的数据无法从浏览器记录自动恢复。` : message;
  msg.finishedAt = new Date().toISOString();
  saveNow(session);
  broadcast({ type: 'chat.done', sessionId: session.id, msg });
});

function sendChat({ sessionId, accountId, text, taskKind, benchmarkId }) {
  const account = store.getAccount(accountId);
  if (!account || (accountId && account.id !== accountId)) throw store.httpError(404, '账号不存在');
  let benchmark = null;
  const agentVerify = taskKind === 'benchmark.agent';  // 插件方式下的核实主页：提示词由网页给，服务端只加闸门、记账、数字
  if (taskKind !== undefined) {
    if (!['benchmark.verify', 'browser.prepare', 'benchmark.agent'].includes(taskKind)) throw store.httpError(400, '任务类型不支持');
    const worker = workerInfo();
    if (['benchmark.verify', 'browser.prepare'].includes(taskKind) && !workerCollectAllowed()) throw store.httpError(409, WORKER_DISABLED);
    if (taskKind === 'benchmark.agent') {
      // WorkBuddy 插件方式下的单个「核实主页」：本质是一次采集会话，和批量采集用同一套闸门和账本
      const c = bridge.config();
      if (!(c?.mode === 'cli' && c?.browser === 'workbuddy')) throw store.httpError(409, '这个入口只用于浏览器方式是 WorkBuddy 插件的情况');
      assertBrowserCapability();
      assertBrowserAccess(account.id);
      if (!/^b_[\w-]+$/.test(benchmarkId || '')) throw store.httpError(400, '对标 id 不合法');
      const gate = assertCollectionAllowed(account.id);
      benchmark = content.benchmarkDetail(account.id, benchmarkId).item;
      recordSession(account.id, benchmarkId);
      text = `${String(text || '').trim()}\n${paceInstructions(gate.limits)}`;
      taskKind = undefined;  // 交给 agent 当普通任务跑，不走后台组件
    } else if (taskKind === 'browser.prepare') {
      // 登录账号：员工本人扫码，由工作台自己的浏览器完成，只要求浏览器组件已安装（网页会先自动安装），不查 agent 连接、中枢能力和访问锁
      if (!worker.available) throw store.httpError(409, '浏览器组件还没安装，请再点一次「登录账号」（会自动安装，约 1 分钟）');
    } else {
      assertBrowserCapability(); // 中枢判定缺浏览器能力时只拦浏览器功能（先于访问锁：缺能力不该被记成平台风控）
      assertBrowserAccess(account.id);
      if (!worker.enabled || !worker.available || !worker.compatible) throw store.httpError(409, '后台有头读取尚未就绪，请在设置页开启并安装组件，或使用原 agent 路径');
    }
    if (agentVerify) { /* 上面已处理 */ } else if (taskKind === 'benchmark.verify') {
      if (!/^b_[\w-]+$/.test(benchmarkId || '')) throw store.httpError(400, '对标 id 不合法');
      benchmark = content.benchmarkDetail(account.id, benchmarkId).item;
      assertCollectionAllowed(account.id);   // 后台组件这条路也算一次采集：同一套总开关 / 冷静期 / 每日上限 / 采集间隔
      recordSession(account.id, benchmarkId);
      text = `只读核实对标账号「${benchmark.name}」的主页`;
    } else text = `在可见浏览器中检查「${account.name}」的登录账号`;
  }
  text = String(text || '').trim();
  if (!text) throw store.httpError(400, '消息不能为空');
  const cfg = bridge.config();
  if (!cfg) throw store.httpError(409, '尚未完成连接设置，请回到你的 agent 里说「运行小红书工作台连接自检」');

  let session = sessionId ? getSession(sessionId) : null;
  // 切换账号时新建对话，不能把另一个账号的历史消息带入当前提示词。
  if (session && session.accountId !== account.id) session = null;
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
  // 只读任务没有进入 agent 的会话；下一条普通消息必须带上其结果重新构造上下文。
  if (taskKind) {
    session.agentSessionId = null;
    session.agentAdapterId = null;
    session.agentAccountId = null;
    session.agentModelTier = null;
    session.agentModelKey = null;
  }

  if (cfg.browser && cfg.browser !== 'none') recordChat(account.id);  // 只记不拦：用户自己在聊天里让 agent 看网页，也要在「今天看了多少」里算上
  const now = new Date().toISOString();
  const userMsg = { id: store.newId('m_'), role: 'user', text, createdAt: now };
  session.messages.push(userMsg);

  // CLI 模式下能续接同一个 agent 会话时，不必重复塞历史
  const canResume =
    !taskKind && cfg.mode === 'cli' && cfg.adapter.resumeArgs && session.agentSessionId
    && session.agentAdapterId === cfg.adapter.id && session.agentAccountId === account.id
    && session.agentModelTier === 'normal' && session.agentModelKey === normalModelKey(cfg.adapter);
  const prompt = buildPrompt({ session, account, text, includeHistory: !canResume, allowHub: !taskKind });

  const asstMsg = {
    id: store.newId('m_'),
    role: 'assistant',
    text: '',
    status: 'pending',
    tools: [],
    createdAt: now,
  };
  session.messages.push(asstMsg);
  saveNow(session);

  const taskId = asstMsg.id;
  taskIndex.set(taskId, { sessionId: session.id, msgId: asstMsg.id, accountId: account.id,
    adapterId: cfg.adapter?.id || null, modelKey: normalModelKey(cfg.adapter) });
  try {
    bridge.submit({ id: taskId, sessionId: session.id, accountId: account.id, prompt,
      agentSessionId: canResume ? session.agentSessionId : null, kind: taskKind,
      account, benchmark, timeoutMs: taskKind === 'benchmark.verify' ? 180_000 : taskKind === 'browser.prepare' ? 6 * 60_000 : undefined,
      waitMs: taskKind === 'browser.prepare' ? 5 * 60_000 : undefined,  // 登录：停在登录页等员工扫码，最多 5 分钟
      fastModel: taskKind === 'benchmark.verify' ? workerInfo().fastModel : '' });
  } catch (err) {
    taskIndex.delete(taskId);
    asstMsg.status = 'error';
    asstMsg.error = err.message;
    saveNow(session);
  }
  return { session };
}

/** 采集只走 WorkBuddy 浏览器插件：不满足时告诉员工去哪里改（新机器的浏览器方式默认是 none，最容易漏） */
const PLUGIN_ONLY = '采集只走 WorkBuddy 浏览器插件，但现在还不满足：请到「连接与设置 → 执行 Agent 与浏览器」，确认对话通道是 CodeBuddy，并把浏览器方式选成「WorkBuddy 浏览器插件」（按钮是灰的就先在 WorkBuddy「设置 → 智能体 → 浏览器操控」里打开「让 WorkBuddy 控制浏览器」）';
const collectionQueue = new BenchmarkQueue({
  gate: (account) => { const s = paceSummary(account); return { ok: s.status === 'go', reason: s.reason }; },
  accounts: store.listAccounts,
  detail: content.benchmarkDetail,
  busy: (account) => bridge.activeProfiles.has(account)
    || [...bridge.running.values(), ...bridge.tasks.values()].some(t => t.accountId === account)
    || bridge.cliQueue.some(t => t.task.accountId === account),
  changed: (account) => broadcast({ type: 'content.changed', account, area: 'benchmarks' }),
  dispatch: (accountId, benchmarkId, id) => {
    const account = store.getAccount(accountId);
    if (!account?.xhsId) throw new Error('请先设置当前账号的小红书号并完成本人登录');
    const benchmark = content.benchmarkDetail(accountId, benchmarkId).item;
    const worker = workerInfo();
    const cfg = bridge.config();
    // 三条路：后台只读组件（Playwright，确定性读取）/ agent 浏览器（浏览器方式是 WorkBuddy 插件时，CodeBuddy 按手册读）/ 拒绝。
    // WorkBuddy 插件方式本来就只能走 agent（单个「核实主页」也是这样），批量队列以前漏了这条路，导致一律失败。
    const route = collectionRoute(worker, cfg), useWorker = route === 'worker', viaAgent = route === 'agent';
    if (!route) throw new Error(PLUGIN_ONLY);
    const timeoutMs = useWorker ? 180_000 : 600_000;  // agent 读页面慢：实测光核对登录就要约 3 分钟
    const pace = assertCollectionAllowed(accountId);  // 派发前再核一次（队列里等了一阵、或手动点了开始之后状态可能变了）
    recordSession(accountId, benchmarkId);
    const text = `按 playbooks/benchmark.md 自动接续对标资料采集，仅处理 id=${benchmarkId}。读取已登记目标，实时核对当前登录账号与目标身份；同一次浏览器占用内保存头像元素局部 PNG、主页字段、最多五篇可见笔记。先写 verified，再逐篇写独立 observation 检查点并写收尾；不要只回复文字。已有有效笔记保留，仅补缺项。登录/风控立即停止并报告原因。` + paceInstructions(pace.limits) +
      (viaAgent ? `用 WorkBuddy 浏览器工具（mcp__browser__*）在用户自己的浏览器里新开标签页操作，按 playbooks/browser.md 先核对登录账号；只读档没有点击工具，看笔记时用 tab_goto 打开页面上卡片链接的原文（带全部参数，不拼接不删参数）；不点赞、不评论、不关注、不私信、不发布；遇到验证码或风险提示立即停止并说明。` : '');
    bridge.submit({ id, accountId, account, benchmark, timeoutMs,
      kind: useWorker ? 'benchmark.verify' : undefined,
      prompt: buildPrompt({ session: { messages: [] }, account, text, includeHistory: false }) });
    if (cfg?.mode === 'inbox') setTimeout(() => {
      if (bridge.tasks.has(id)) bridge.cancel(id);
    }, timeoutMs).unref();
    return useWorker ? 'worker' : 'agent';
  },
});
collectionQueue.recover();
// 两篇笔记的检查点来得太快 = agent 在连发：停手，并把采集总开关关上，要人确认后才能重新开
onPaceViolation(({ accountId, gapSec, min }) => {
  const reason = `读得太快：两篇笔记只隔 ${gapSec} 秒（下限 ${min} 秒），已自动停止并关闭采集总开关，请先看一下账号有没有收到平台提示`;
  try { updatePolicy(accountId, { enabled: false }); } catch { /* 开关写不进去也要先停手 */ }
  collectionQueue.block(accountId, reason);
  bridge.cancelAccount(accountId);
  broadcast({ type: 'content.changed', account: accountId, area: 'benchmarks' });
});
setInterval(() => {
  for (const account of store.listAccounts()) flushBenchmarkCheckpoints(account.id);
  collectionQueue.tick();
}, 1000).unref();

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

// 防休眠：settings.json 的 keepAwake = off | auto | always
function keepAwakeMode() {
  return store.readJson(P.settings, {}).keepAwake || 'off';
}
function refreshKeepAwake() {
  system.applyKeepAwake(keepAwakeMode(), ops.needsAwake());
}
setInterval(refreshKeepAwake, 60_000).unref();

// 每天自动备份一次（settings.json 的 autoBackup 设为 off 可关闭）
function autoBackup() {
  if (store.readJson(P.settings, {}).autoBackup === 'off') return;
  try {
    const b = backup.autoBackupIfDue();
    if (b) log(`自动备份完成：${b.name}（${b.files} 个文件）`);
  } catch (err) {
    log(`自动备份失败：${err.message}`);
  }
}
setInterval(autoBackup, 3600_000).unref();
setTimeout(autoBackup, 60_000).unref();
setTimeout(refreshKeepAwake, 2_000).unref();

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
  '.heic': 'image/heic',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
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
      if (size > 80 * 1024 * 1024) {
        reject(store.httpError(413, '请求体过大'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        // 浏览器发的是 UTF-8；非 UTF-8 的调用方（例如 Windows 命令行里的 curl）按 GBK 兜底，避免中文被永久替换成 U+FFFD
        resolve(JSON.parse(decodeText(Buffer.concat(chunks))));
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
        upgrade: upgradeSummary(VERSION, startupUpgrade),
        hub: (() => { const h = readHubServers(); return { connected: Object.keys(h.servers).length > 0, servers: Object.keys(h.servers), problem: h.problem, capabilities: readHubCapabilities(), selfStarted: process.env.HUB_SELF_STARTED === '1' }; })(),
        workspace: WORKSPACE,
        skillDir: SKILL_DIR,
        bridge: { ...bridge.status(), browserWorker: workerInfo() },
        accounts: store.getAccounts(),
      });

    // ----- 连接 -----
    case 'GET /api/bridge':
      return sendJson(res, 200, { status: { ...bridge.status(), browserWorker: workerInfo() }, config: bridge.config() });
    case 'GET /api/bridge/detect':
      if (q.get('refresh')) detectedCache = null;
      return sendJson(res, 200, { adapters: detected(), desktop: detectDesktopAgents() });
    case 'POST /api/bridge/test': {
      const cfg = bridge.config();
      if (!cfg) throw store.httpError(409, '尚未配置连接');
      if (cfg.mode === 'inbox') return sendJson(res, 200, { ok: bridge.status().inboxOnline, mode: 'inbox' });
      const result = await pingAdapter(cfg.adapter);
      reportHealth({ stage: 'doctor', ok: result.ok, message: result.error || '', agent: cfg.adapter?.name });
      if (result.ok) store.saveBridgeConfig({ ...cfg, testedAt: new Date().toISOString() });
      broadcast({ type: 'bridge.changed' });
      return sendJson(res, 200, { ...result, mode: 'cli' });
    }
    case 'PUT /api/bridge': {
      const body = await readBody(req);
      const prev = bridge.config() || {};
      if (body.mode === 'inbox') {
        if (bridge.activeProfiles.size) throw store.httpError(409, '浏览器任务正在运行，请稍后切换连接');
        await bridge.closeBrowsers();
        const host = body.hostAgentId ? findDesktopAgent(body.hostAgentId) : null;
        if (body.hostAgentId && !host) throw store.httpError(400, '未知的桌面类 agent');
        const { hostAgent: _old, ...rest } = prev;
        store.saveBridgeConfig({ ...rest, mode: 'inbox', ...(host ? { hostAgent: { id: host.id, name: host.name } } : {}), testedAt: new Date().toISOString() });
        broadcast({ type: 'bridge.changed' });
        return sendJson(res, 200, { ok: true });
      }
      const base = findAdapter(body.adapterId);
      const found = detected().find((a) => a.id === body.adapterId);
      if (!base || !found) throw store.httpError(400, '本机未检测到该 agent');
      const adapter = { ...base, command: found.command };
      const result = await pingAdapter(adapter);
      reportHealth({ stage: 'doctor', ok: result.ok, message: result.error || '', agent: adapter.name });
      if (!result.ok) return sendJson(res, 200, result);
      if (bridge.activeProfiles.size) throw store.httpError(409, '浏览器任务正在运行，请稍后切换连接');
      await bridge.closeBrowsers();
      delete prev.hostAgent;
      // 切换 agent 不能悄悄关掉浏览器控制：之前开着 Playwright，新 agent 也支持的话就沿用（权限档按新 agent 的默认）
      let next = adapter, browser = 'none', kept = false;
      if (prev.browser === 'workbuddy' && prev.adapter?.workbuddyMcp && adapter.id === 'codebuddy') {
        try {
          next = applyBrowser({ ...adapter, browserMode: prev.adapter.browserMode }, 'workbuddy', prev.adapter.workbuddyMcp);
          browser = 'workbuddy'; kept = true;
        } catch { next = adapter; }
      } else if (prev.browser === 'ego' && prev.adapter?.egoMcp && adapter.id === 'codebuddy') {
        try {
          next = applyBrowser(adapter, 'ego', prev.adapter.egoMcp);
          browser = 'ego'; kept = true;
        } catch { next = adapter; }
      } else if (prev.browser === 'playwright' && prev.adapter?.playwrightMcp && ['codebuddy', 'codex'].includes(adapter.id)) {
        try {
          next = applyBrowser(adapter, 'playwright', prev.adapter.playwrightMcp);
          next.headless = prev.adapter.headless; next.browserChannel = prev.adapter.browserChannel;
          if (adapter.id === 'codebuddy' && prev.adapter.id === 'codebuddy') { next = applyBrowser({ ...next, browserMode: prev.adapter.browserMode }, 'playwright', prev.adapter.playwrightMcp); next.headless = prev.adapter.headless; next.browserChannel = prev.adapter.browserChannel; }
          browser = 'playwright'; kept = true;
        } catch { next = adapter; }
      }
      store.saveBridgeConfig({ ...prev, mode: 'cli', adapter: next, browser, testedAt: new Date().toISOString() });
      if (!kept && prev.browser && prev.browser !== 'none') result.notice = '浏览器控制没有沿用到新的 agent，已关闭；需要的话到「连接与设置」重新开启。';
      broadcast({ type: 'bridge.changed' });
      return sendJson(res, 200, result);
    }

    // ----- 账号 -----
    case 'GET /api/accounts': {
      // 附带每个账号的浏览器登录状态（agent 登录检查后写入）
      const data = store.getAccounts();
      data.accounts = data.accounts.map((a) => ({ ...a, browser: browserStatus(a.id), profileSuggestion: suggestionSummary(a.id) }));
      return sendJson(res, 200, data);
    }
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
      const sent = await readBody(req);
      // U+FFFD 是解码失败留下的替换字符，原文已不可恢复：宁可让用户重发，也不把残缺的消息交给 agent 去猜
      if (typeof sent.text === 'string' && sent.text.includes(String.fromCharCode(0xfffd))) throw store.httpError(400, '消息里有无法识别的字符（中文编码异常），请重新发送');
      const { session } = sendChat(sent);
      broadcast({ type: 'chats.changed' });
      return sendJson(res, 200, session);
    }
    // ----- 网页里完成 agent 设置（第一阶段：网页为主界面，CodeBuddy CLI 是唯一执行者） -----
    case 'GET /api/agent-setup':
      return sendJson(res, 200, { codebuddy: codebuddyStatus(), browser: browserOptions() });
    case 'POST /api/codebuddy/check':
      return sendJson(res, 200, await checkCodebuddy());
    case 'POST /api/codebuddy/login':
      return sendJson(res, 200, openCodebuddyLogin());
    case 'POST /api/bridge/browser': {
      const { engine } = await readBody(req);
      if (bridge.activeProfiles.size) throw store.httpError(409, '浏览器任务正在运行，请完成或取消后再切换');
      const result = await setBrowserEngine(engine);
      // 后台读取组件跟「工作台独立浏览器」配套；换成别的方式时关掉它（登录账号不需要它开着）
      const settings = store.readJson(P.settings, {});
      if (engine !== 'playwright' && settings.backgroundBrowser) {
        store.writeJson(P.settings, { ...settings, backgroundBrowser: false });
        await bridge.closeBrowsers();
      }
      broadcast({ type: 'bridge.changed' });
      return sendJson(res, 200, result);
    }
    case 'POST /api/bridge/browser-mode': {
      const { mode, confirmed } = await readBody(req);
      const result = setBrowserMode(mode, confirmed);
      broadcast({ type: 'bridge.changed' });
      return sendJson(res, 200, result);
    }
    case 'POST /api/browser/runtime': {
      // 「登录账号」第一次用时自动安装浏览器组件（playwright-core，浏览器用电脑上的 Edge / Chrome）
      try {
        const runtime = await installBrowserRuntimeAsync();
        broadcast({ type: 'bridge.changed' });
        return sendJson(res, 200, { ok: true, version: runtime.version });
      } catch (err) {
        reportHealth({ stage: 'runtime', ok: false, message: err.message });
        throw store.httpError(502, err.message);
      }
    }
    case 'POST /api/browser/worker': {
      const body = await readBody(req);
      const previous = store.readJson(P.settings, {});
      const next = { ...previous };
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== 'boolean') throw store.httpError(400, '启停设置不合法');
        if (bridge.activeProfiles.size) throw store.httpError(409, '浏览器任务正在运行，请完成或取消后切换');
        if (body.enabled && !workerCollectAllowed()) throw store.httpError(409, WORKER_DISABLED);
        if (body.enabled && (!workerInfo().available || !workerInfo().compatible)) throw store.httpError(409, '请先安装后台组件并配置有头 Playwright 浏览器');
        next.backgroundBrowser = body.enabled;
        if (!body.enabled) await bridge.closeBrowsers();
      }
      if (body.fastModel !== undefined) {
        if (typeof body.fastModel !== 'string' || (body.fastModel && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(body.fastModel))) {
          throw store.httpError(400, '快速模型名称不合法');
        }
        if (body.fastModel && bridge.config()?.adapter?.id !== 'claude-code') throw store.httpError(400, '当前 agent 不支持工作台指定快速模型');
        next.fastReadModel = body.fastModel;
      }
      store.writeJson(P.settings, next);
      broadcast({ type: 'bridge.changed' });
      return sendJson(res, 200, { ...workerInfo() });
    }
    case 'POST /api/bridge/headless': {
      const b = await readBody(req);
      const cfg = bridge.config();
      if (!cfg || cfg.mode !== 'cli' || !cfg.adapter) throw store.httpError(409, '尚未配置 CLI 连接');
      if (b.on && workerInfo().enabled) throw store.httpError(409, '请先关闭后台有头读取，再切换到无头模式');
      if (bridge.activeProfiles.size) throw store.httpError(409, '浏览器任务正在运行，请稍后切换');
      cfg.adapter.headless = !!b.on;
      // 保留用户选择的浏览器 channel，不对风控效果作保证。
      if (!cfg.adapter.browserChannel) cfg.adapter.browserChannel = detectRealBrowser() || 'chromium';
      store.saveBridgeConfig(cfg);
      broadcast({ type: 'bridge.changed' });
      return sendJson(res, 200, { ok: true, headless: !!cfg.adapter.headless });
    }
    case 'POST /api/chat/cancel':
      return sendJson(res, 200, { ok: cancelChat((await readBody(req)).sessionId) });

    // ----- 收件箱模式：agent 领取 / 回写任务 -----
    case 'GET /api/agent/next': {
      const wait = Math.min(Math.max(Number(q.get('wait')) || 0, 0), 600) * 1000;
      const before = bridge.status().inboxOnline;
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableEnded) ac.abort(); });
      const pending = bridge.next(wait, ac.signal);
      if (!before) broadcast({ type: 'bridge.changed' });
      const task = await pending;
      // 长轮询期间 agent 已断开：把任务放回队列，下次再领
      if (task && res.socket && res.socket.destroyed) return bridge.requeue(task.id);
      return sendJson(res, 200, { task });
    }
    case 'GET /api/agent/peek':
      return sendJson(res, 200, bridge.peek());
    case 'POST /api/agent/requeue': {
      const body = await readBody(req);
      if (!bridge.requeue(body.taskId)) throw store.httpError(404, '任务不存在');
      return sendJson(res, 200, { ok: true });
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
    case 'GET /api/benchmarks': {
      const items = content.listBenchmarks(acc);
      return { items, checkpointIssues: content.benchmarkCheckpointIssues(acc), collection: collectionStatus(acc), access: browserAccessStatus(acc) };
    }
    case 'GET /api/browse/pace':
      return paceSummary(acc);
    case 'POST /api/browse/policy': {
      // 总开关 / 冷静期 / 上限：只能由人在网页里改。放在状态目录，agent 直接改数据目录里的文件没用
      const b = await body();
      const patch = {};
      if (b.action === 'enable') patch.enabled = true;
      else if (b.action === 'disable') patch.enabled = false;
      else if (b.action === 'set-cooldown') { patch.cooldownDays = b.days; patch.cooldownReason = b.reason; patch.enabled = false; }
      else if (b.action === 'clear-cooldown') patch.clearCooldown = true;
      else if (b.action === 'set-limits') patch.limits = b.limits;
      else throw store.httpError(400, '策略动作不合法');
      return updatePolicy(acc, patch);
    }
    case 'POST /api/benchmarks/collection': {
      const { action } = await body();
      if (!['fill', 'pause', 'resume'].includes(action)) throw store.httpError(400, '采集动作不合法');
      if (action !== 'pause') {
        assertCollectionAllowed(acc);  // 总开关 / 冷静期 / 时段 / 每日上限 / 采集间隔
        if (!collectionRoute(workerInfo(), bridge.config())) throw store.httpError(409, PLUGIN_ONLY);  // 浏览器方式不对：当场拒绝，不让队列启动后再悄悄暂停
      }
      const items = content.listBenchmarks(acc);
      const ids = action === 'fill' ? items.filter(b => !observationComplete(content.benchmarkDetail(acc, b.id).observation)).map(b => b.id) : [];
      const result = collectionQueue.control(acc, action, ids);
      if(action==='pause') bridge.cancelAccount(acc);
      return result;
    }
    case 'POST /api/browser/access': {
      const {action,confirmed}=await body();
      if(action==='pause'||action==='restriction'){ const state=lockBrowserAccess(acc,action==='restriction'?'restriction':'paused',action==='restriction'?'用户报告平台处罚，等待人工确认解除':'用户暂停自动访问'); bridge.cancelAccount(acc); return state; }
      if(action==='resume')return resumeBrowserAccess(acc);
      if(action==='resolve-restriction')return resolveBrowserRestriction(acc,confirmed);
      throw store.httpError(400,'访问锁动作不合法');
    }
    case 'GET /api/benchmarks/detail':
      return content.benchmarkDetail(acc, q.get('id'));
    case 'POST /api/benchmarks':
      return content.saveBenchmark(acc, await body());
    case 'POST /api/benchmarks/avatar': {
      const b = await body();
      const path = content.uploadBenchmarkAvatar(acc, b.id, b.filename, b.data);
      broadcast({ type: 'content.changed', account: acc, area: 'benchmarks' });
      return { path, kind: 'manual' };
    }
    case 'POST /api/benchmarks/upload': {
      const b = await body();
      return { path: content.uploadBenchmarkShot(acc, b.id, b.filename, b.data) };
    }
    case 'DELETE /api/benchmarks':
      content.deleteBenchmark(acc, q.get('id'));
      return { ok: true };
    case 'POST /api/benchmarks/seen': {
      const b = await body();
      return { item: content.markBenchmarkSeen(acc, b.id) };
    }

    case 'GET /api/topics':
      return { items: content.listTopics(acc), jobs: topicWorkflow.jobs(acc), sources: topicSources(acc).map(({id,name,basis,notes})=>({id,name,basis,noteCount:notes.length})) };
    case 'POST /api/topics/generate':
      return topicWorkflow.generate(acc, await body());
    case 'POST /api/topics/write':
      return topicWorkflow.write(acc, await body());
    case 'POST /api/topics/retry':
      return topicWorkflow.retry(acc, (await body()).id);
    case 'POST /api/topics':
      return content.saveTopic(acc, await body());
    case 'DELETE /api/topics':
      content.deleteTopic(acc, q.get('id'));
      return { ok: true };

    case 'GET /api/live/receive/options':
      return {addresses:liveTransfer.addresses()};
    case 'POST /api/live/receive':
      return await liveTransfer.create(acc,await body());
    case 'GET /api/live/receive':
      return liveTransfer.status(acc,q.get('id'));
    case 'POST /api/live/receive/revoke':
      return liveTransfer.revoke(acc,(await body()).id);
    case 'GET /api/live/jobs':
      return {items:livePhotoWorkflow.list(acc)};
    case 'POST /api/live/start':
      return livePhotoWorkflow.start(acc,await body());
    case 'POST /api/live/confirm':
      return livePhotoWorkflow.confirm(acc,await body());
    case 'GET /api/videos/service': return {...videoService.settings(),hubAvailable:videoWorkflow.hub.available()};
    case 'PUT /api/videos/service': return videoService.save(await body());
    case 'POST /api/videos/service/test': return await videoService.test();
    case 'GET /api/videos/reference-videos': return {items:videoWorkflow.videoReferences.list(acc)};
    case 'POST /api/videos/reference-videos': return await videoWorkflow.videoReferences.upload(acc,await body());
    case 'GET /api/videos/descriptions': return {items:videoDescriptions.jobs(acc).map(({visionExpected,...j})=>j)};
    case 'POST /api/videos/descriptions': { const { visionExpected, ...started } = await videoDescriptions.start(acc, await body()); return started; }
    case 'GET /api/videos/jobs': return {items:videoWorkflow.jobs(acc)};
    case 'GET /api/videos/sources': return {items:videoWorkflow.sources(acc)};
    case 'POST /api/videos/start': return videoWorkflow.start(acc,await body());
    case 'POST /api/videos/refresh': return await videoWorkflow.refresh(acc,(await body()).id);
    case 'POST /api/videos/references': {
      const b=await body();
      if(typeof b.data!=='string'||b.data.length>14000000)throw store.httpError(400,'视频参考图不能超过10MB');
      return imageWorkflow.uploadReference(acc,{...b,role:'product'});
    }
    case 'GET /api/images/service': {
      // 接上中枢时顺带告诉网页：中枢出图现在走哪条通道、能不能带参考图（查不到不影响设置页）
      const s = getImageServiceSettings();
      if (!s.hubAvailable) return s;
      try { const c = await hubGen.capabilities(); return { ...s, hubImage: { via: c.image_via, references: !!c.image_references, maxReferences: c.max_references } }; }
      catch { return s; }
    }
    case 'PUT /api/images/service': {
      const result = saveImageServiceSettings(await body());
      broadcast({type:'config.changed'}); return result;
    }
    case 'POST /api/images/service/test':
      return await testImageServiceConnection();
    case 'POST /api/images/refresh':
      return await imageWorkflow.refresh(acc, (await body()).id);
    case 'GET /api/images/references':
      return {items:imageWorkflow.references(acc)};
    case 'POST /api/images/references':
      return imageWorkflow.uploadReference(acc,await body());
    case 'POST /api/images/library':
      return imageWorkflow.saveToLibrary(acc,await body());
    case 'GET /api/images/jobs':
      return {items:imageWorkflow.jobs(acc,q.get('noteId'))};
    case 'POST /api/images/start':
      return imageWorkflow.start(acc,await body());
    case 'POST /api/images/complete':
      return imageWorkflow.complete(acc,(await body()).id);
    case 'POST /api/images/apply':
      return imageWorkflow.apply(acc,await body());
    case 'GET /api/covers/state':
      return coverWorkflow.state(acc,q.get('noteId'));
    case 'GET /api/covers/jobs':
      return {items:coverWorkflow.jobs(acc,q.get('noteId'))};
    case 'POST /api/covers/run':
      return coverWorkflow.start(acc,await body());
    case 'POST /api/covers/retry':
      return coverWorkflow.retry(acc,(await body()).id);
    case 'POST /api/covers/render':
      return coverWorkflow.renderCard(acc,await body());
    case 'POST /api/covers/render-error': {
      const b=await body();return coverWorkflow.renderError(acc,b.id,b.error);
    }
    case 'POST /api/covers/save':
      return coverWorkflow.saveCover(acc,await body());
    case 'GET /api/notes/jobs':
      return {items:copyWorkflow.jobs(acc,q.get('noteId'))};
    case 'POST /api/notes/run':
      return copyWorkflow.start(acc,await body());
    case 'POST /api/notes/retry':
      return copyWorkflow.retry(acc,(await body()).id);
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
    // 大文件（视频）流式上传：请求体直接写盘，不走 JSON base64
    case 'POST /api/notes/upload-file':
      return { name: await content.saveNoteFileStream(acc, q.get('noteId'), q.get('filename'), req) };
    case 'POST /api/notes/video': {
      const b = await body();
      // 只传显式给出的键：只设封面时不能把 file 一起带过去（会误清视频）
      const input = {};
      if ('file' in b) input.file = b.file;
      if ('cover' in b) input.cover = b.cover;
      return content.setNoteVideo(acc, b.id, input);
    }
    case 'POST /api/notes/video/delete': {
      const b = await body();
      return content.deleteNoteVideoFile(acc, b.id, b.file);
    }
    case 'GET /api/notes/video-script': {
      const d = content.noteDetail(acc, q.get('id'));
      return { videoScript: d.videoScript };
    }
    case 'POST /api/notes/video-script': {
      const b = await body();
      return content.saveVideoScript(acc, b.id, b.markdown);
    }
    case 'GET /api/materials':
      return { items: materials.listMaterials() };
    case 'POST /api/materials':
      return materials.saveMaterial(await body());
    case 'POST /api/materials/upload': {
      const b = await body();
      return { name: materials.uploadMaterial(b.filename, b.data) };
    }
    case 'DELETE /api/materials':
      materials.deleteMaterial(q.get('id'));
      return { ok: true };
    case 'POST /api/notes/cover': {
      const b = await body();
      return content.saveCoverImage(acc, b.id, b.data, b.hash);
    }
    case 'DELETE /api/notes':
      content.deleteNote(acc, q.get('id'));
      return { ok: true };
    case 'POST /api/notes/media': {
      const b = await body();
      return content.saveMedia(acc, b.id, b.media);
    }
    case 'POST /api/notes/media/delete': {
      const b = await body();
      return content.deleteMedia(acc, b.id, b.file);
    }
    case 'POST /api/notes/media/crop': {
      const b = await body();
      return content.cropMedia(acc, b.id, b.file, b.data);
    }
  }
  return undefined;
}

// M3 运营接口：排期、评论私信、数据复盘、自动化设置、提醒
async function handleOpsApi(route, q, req) {
  const acc = q.get('account');
  const body = () => readBody(req);
  switch (route) {
    case 'GET /api/system':
      return { autostart: system.autostartStatus(), keepAwake: { mode: keepAwakeMode(), active: system.keepAwakeActive() } };
    case 'POST /api/system': {
      const b = await body();
      if (typeof b.autostart === 'boolean') system.setAutostart(b.autostart);
      if (['off', 'auto', 'always'].includes(b.keepAwake)) {
        store.writeJson(P.settings, { ...store.readJson(P.settings, {}), keepAwake: b.keepAwake });
        refreshKeepAwake();
      }
      return { autostart: system.autostartStatus(), keepAwake: { mode: keepAwakeMode(), active: system.keepAwakeActive() } };
    }
    case 'GET /api/backups':
      return { items: backup.listBackups(), autoBackup: store.readJson(P.settings, {}).autoBackup || 'daily' };
    case 'POST /api/backups':
      return backup.createBackup();
    case 'POST /api/backups/settings': {
      const b = await body();
      store.writeJson(P.settings, { ...store.readJson(P.settings, {}), autoBackup: b.autoBackup === 'off' ? 'off' : 'daily' });
      return { ok: true };
    }
    case 'POST /api/backups/restore': {
      if (bridge.activeProfiles.size) throw store.httpError(409, '浏览器任务运行中，请完成或取消后恢复');
      await bridge.closeBrowsers();
      const result = backup.restoreBackup((await body()).name);
      sessions.clear(); // 对话缓存作废，下次从恢复后的文件读取
      startWatchers();
      broadcast({ type: 'restored' });
      return result;
    }
    case 'GET /api/trash':
      return { items: store.listTrash() };
    case 'POST /api/trash/restore': {
      const result = store.restoreTrash((await body()).id);
      sessions.clear();
      startWatchers();
      broadcast({ type: 'restored' });
      return result;
    }
    case 'GET /api/alerts':
      return { items: ops.alerts() };
    case 'GET /api/automation':
      return ops.getAutomation(acc);
    case 'POST /api/automation':
      return ops.saveAutomation(acc, await body());

    case 'POST /api/schedule/check':
      return ops.preflight(acc, (await body()).noteId, {persist:true});
    case 'POST /api/schedule/draft':
      return ops.scheduleDraft(acc, await body());
    case 'POST /api/schedule/draft/cancel':
      return ops.cancelDraft(acc, (await body()).id);
    case 'GET /api/schedule':
      return { items: ops.listSchedule(acc) };
    case 'POST /api/schedule':
      return ops.scheduleNote(acc, await body());
    case 'POST /api/schedule/update':
      return ops.updateSchedule(acc, await body());
    case 'DELETE /api/schedule':
      ops.deleteSchedule(acc, q.get('id'));
      return { ok: true };

    case 'GET /api/engage/workflow':
      return engageWorkflow.state(acc);
    case 'POST /api/engage/review':
      return engageWorkflow.start(acc,await body());
    case 'POST /api/engage/review/retry':
      return engageWorkflow.retry(acc,(await body()).id);
    case 'POST /api/engage/review/edit':
      return engageWorkflow.edit(acc,await body());
    case 'POST /api/engage/review/confirm':
      return engageWorkflow.confirm(acc,await body());
    case 'POST /api/engage/review/revoke':
      return engageWorkflow.revoke(acc,await body());
    case 'GET /api/engage':
      return { items: ops.listEngage(acc) };
    case 'POST /api/engage':
      return ops.saveEngage(acc, await body());

    case 'GET /api/analytics/workflow':
      return analyticsWorkflow.state(acc);
    case 'POST /api/analytics/review':
      return analyticsWorkflow.start(acc,await body());
    case 'POST /api/analytics/review/retry':
      return analyticsWorkflow.retry(acc,(await body()).id);
    case 'POST /api/analytics/review/topic':
      return analyticsWorkflow.addTopic(acc,await body());
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

function sendZip(res, filename, entries) {
  const buf = createZip(entries);
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': buf.length,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function serveNoteBundle(res, q) {
  try {
    const { title, entries } = content.noteBundle(q.get('account'), q.get('id'));
    sendZip(res, `${title.replace(/[\\/:*?"<>|]/g, '_')}-发布包.zip`, entries);
  } catch (err) {
    sendJson(res, err.status || 500, { error: err.message });
  }
}

function serveBackup(res, q) {
  try {
    const file = backup.backupFile(q.get('name'));
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': fs.statSync(file).size, 'Content-Disposition': `attachment; filename="${path.basename(file)}"` });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    sendJson(res, err.status || 500, { error: err.message });
  }
}

// 笔记数据导出为 CSV（带 BOM，Excel 直接打开不乱码）
function serveAnalyticsCsv(res, q) {
  try {
    const { notes } = ops.getAnalytics(q.get('account'));
    const cols = [['title', '笔记'], ['publishedAt', '发布时间'], ['views', '阅读'], ['likes', '点赞'], ['collects', '收藏'], ['comments', '评论'], ['shares', '分享'], ['follows', '涨粉'], ['url', '链接']];
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = notes.map((n) => cols.map(([k]) => cell(k in (n.metrics || {}) ? n.metrics[k] : n[k])).join(','));
    const csv = '\ufeff' + [cols.map(([, name]) => cell(name)).join(','), ...rows].join('\r\n');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('笔记数据.csv')}` });
    res.end(csv);
  } catch (err) {
    sendJson(res, err.status || 500, { error: err.message });
  }
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
      const queryTokenOk = ['/api/events', '/api/files', '/api/notes/bundle', '/api/backup/download', '/api/analytics/export', '/api/live/bundle'].includes(pathname);
      const given = req.headers['x-workbench-token'] || (queryTokenOk ? url.searchParams.get('t') : null);
      if (given !== token) return sendJson(res, 401, { error: '令牌无效，请让 agent 重新打开工作台' });

      if (pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ type: 'hello', bridge: bridge.status() })}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }
      if (pathname === '/api/live/bundle') {
        try {const data=livePhotoWorkflow.bundle(url.searchParams.get('account'),url.searchParams.get('id'),url.searchParams.get('format'));
        res.writeHead(200,{'Content-Type':'application/zip','Content-Length':data.length,'Content-Disposition':url.searchParams.get('format')==='pvt'?'attachment; filename=Live-Photo.pvt.zip':'attachment; filename=Live-Photo.zip','Cache-Control':'no-store'});return res.end(data);
        }catch(err){return sendJson(res,err.status||500,{error:err.message});}
      }
      if (pathname === '/api/files') return serveAccountFile(res, url.searchParams);
      if (pathname === '/api/notes/bundle') return serveNoteBundle(res, url.searchParams);
      if (pathname === '/api/backup/download') return serveBackup(res, url.searchParams);
      if (pathname === '/api/analytics/export') return serveAnalyticsCsv(res, url.searchParams);
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

const previousInstance = (() => {
  const prev = store.readJson(P.serverInfo, null);
  if (!prev || prev.pid === process.pid) return null;
  let alive = false;
  try { process.kill(prev.pid, 0); alive = true; } catch { /* 不在了 */ }
  return { pid: prev.pid, alive };
})();
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
log(`工作台已启动 ${info.url}（pid ${process.pid}，父进程 pid ${process.ppid}${previousInstance ? `，上一个实例 pid ${previousInstance.pid} ${previousInstance.alive ? '仍在运行' : '已不在'}` : ''}${restoredFromDisk ? `，从磁盘恢复 ${restoredFromDisk} 个收件箱任务` : ''}）`);
process.on('exit', (code) => { try { log(`工作台进程退出（pid ${process.pid}，退出码 ${code}）`); } catch { /* 日志目录不可写时忽略 */ } });
process.on('uncaughtException', (err) => { try { log(`未捕获的异常，进程退出：${err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err}`); } catch { /* 忽略 */ } process.exit(1); });
process.on('unhandledRejection', (err) => { try { log(`未处理的 Promise 拒绝：${err && err.message ? err.message : err}`); } catch { /* 忽略 */ } });
console.log(`工作台已启动：${info.openUrl}`);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await liveTransfer.close();
  await bridge.closeBrowsers().catch((err) => log(`关闭浏览器失败：${err.message}`));
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
