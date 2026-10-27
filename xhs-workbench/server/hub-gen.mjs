// 公司中枢的出图 / 出视频服务：走企业中枢的 HTTP 接口（/api/v1），用的是中枢「模型」页配置的通道
// （本机 ComfyUI / 第三方出图 API / H3 网关），权限、额度、审计都按员工的岗位包，员工电脑上不存任何密钥。
// 参考图出图只有中枢的出图通道是第三方 API 时支持，用 capabilities() 查。
// 身份：向本机的中枢接入器要令牌（hub_agent.py token，快过期会先续期），和员工在 agent 里用的是同一个令牌。
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { HUB_ENV } from './hub-mcp.mjs';
import { sanitizeAgentEnv } from './agent-env.mjs';
import { httpError } from './store.mjs';

export const HUB_IMAGE_ASPECTS = ['3:4', '1:1', '4:3', '9:16', '16:9'];
export const HUB_VIDEO_ASPECTS = ['9:16', '16:9', '1:1', '3:4', '4:3'];
const STATUS = { 排队中: 'queued', 生成中: 'running', 已完成: 'done', 失败: 'failed' };

/** 从接入器写给工作台的 MCP 配置里找到接入器（uv run <hub_agent.py> mcp --nested），据此调用 hub_agent.py token */
export function locateConnector(env = process.env, read = (p) => fs.readFileSync(p, 'utf8')) {
  const file = env[HUB_ENV];
  if (!file) return null;
  let servers;
  try { servers = JSON.parse(read(file)).mcpServers || {}; } catch { return null; }
  for (const s of Object.values(servers)) {
    const args = Array.isArray(s?.args) ? s.args : [];
    const i = args.findIndex((a) => /hub_agent\.py$/i.test(String(a)));
    if (typeof s?.command === 'string' && i >= 0) return { command: s.command, pre: args.slice(0, i), script: args[i] };
  }
  return null;
}

export class HubGen {
  constructor({ env = process.env, fetchImpl = globalThis.fetch, runToken, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.env = env; this.fetch = fetchImpl; this.cached = null; this.sleep = sleep;
    this.runToken = runToken || ((c) => new Promise((resolve, reject) => {
      const child = spawn(c.command, [...c.pre, c.script, 'token'], { env: sanitizeAgentEnv(env), windowsHide: true });
      let out = '', err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err = (err + d).slice(-800); });
      const timer = setTimeout(() => child.kill(), 60_000);
      child.on('error', (e) => { clearTimeout(timer); reject(httpError(502, `调不起中枢接入器：${e.message}`)); });
      child.on('close', (code) => {
        clearTimeout(timer);
        const line = out.trim().split(/\r?\n/).pop() || '';
        try { const t = JSON.parse(line); if (t.access_token && t.hub) return resolve(t); } catch { /* 下面报错 */ }
        reject(httpError(502, `没有拿到中枢令牌（接入器退出码 ${code}）：${err.trim().slice(-300) || '请重新运行中枢的接入命令登录'}`));
      });
    }));
  }

  available() { return !!locateConnector(this.env); }

  async token(force = false) {
    if (!force && this.cached && this.cached.expires_at - Date.now() / 1000 > 300) return this.cached;
    const c = locateConnector(this.env);
    if (!c) throw httpError(409, '这个工作台没有接上企业中枢：请从中枢打开（双击桌面图标或对 agent 说「打开小红书工作台」）');
    this.cached = await this.runToken(c);
    return this.cached;
  }

  async request(method, route, { json, form } = {}, retried = false) {
    const t = await this.token();
    let res;
    try {
      res = await this.fetch(`${t.hub}/api/v1${route}`, {
        method, headers: { Authorization: `Bearer ${t.access_token}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
        body: json ? JSON.stringify(json) : form, signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      const err = httpError(502, `连不上企业中枢：${e?.cause?.code || e.message}`); err.notSubmitted = method === 'GET'; throw err;
    }
    if (res.status === 401 && !retried) { this.cached = null; return this.request(method, route, { json, form }, true); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 参数校验失败（422）时 detail 是列表：[{loc, msg}]
      const detail = Array.isArray(data.detail) ? `参数不对（${data.detail.map((d) => `${(d.loc || []).slice(-1)[0] ?? ''} ${d.msg || ''}`.trim()).join('；')}）` : data.detail;
      const err = httpError(res.status === 429 ? 429 : res.status >= 500 ? 502 : res.status, `企业中枢：${res.status === 413 ? '图片太大，中枢没收下（每张参考图要在 10MB 以内；旧版中枢还要求整个请求在 1MB 以内，请管理员升级中枢）' : detail || `HTTP ${res.status}`}`);
      err.upstreamStatus = res.status;
      err.notSubmitted = res.status >= 400 && res.status < 500;  // 4xx：中枢明确拒绝，没有建任务（无权限、额度用完、排队已满、参数不对）
      throw err;
    }
    return data;
  }

  /** 中枢现在出图 / 出视频走哪条通道、出图能不能带参考图；缓存 1 分钟 */
  async capabilities() {
    if (this.caps && Date.now() - this.caps.at < 60_000) return this.caps.value;
    const value = await this.request('GET', '/capabilities');
    this.caps = { at: Date.now(), value };
    return value;
  }

  /** 出图：返回任务号。references 是参考图 [{data: Buffer, filename}]，只有中枢出图通道是第三方 API 时支持 */
  async submitImage({ prompt, aspect = '1:1', count = 1, references = [] }) {
    if (!HUB_IMAGE_ASPECTS.includes(aspect)) throw httpError(400, `公司中枢出图支持的画幅：${HUB_IMAGE_ASPECTS.join('、')}`);
    if (!references.length) return (await this.request('POST', '/images', { json: { prompt, aspect, count } })).task_id;
    const form = new FormData();
    for (const r of references) form.append('images', new Blob([r.data]), r.filename || 'reference.png');
    form.append('prompt', prompt);
    form.append('aspect', aspect);
    form.append('count', String(count));
    return (await this.request('POST', '/images/with-references', { form })).task_id;
  }

  async submitCover({ title, description }) {
    return (await this.request('POST', '/covers', { json: { title, description: description || null } })).task_id;
  }

  async submitVideo({ prompt, aspect = '9:16', seconds = 4 }) {
    if (!HUB_VIDEO_ASPECTS.includes(aspect)) throw httpError(400, `公司中枢出视频支持的画幅：${HUB_VIDEO_ASPECTS.join('、')}`);
    return (await this.request('POST', '/videos', { json: { prompt, aspect, seconds } })).task_id;
  }

  /** 图生视频：首帧图（PNG / JPEG / WEBP，≤10MB），画幅跟随首帧 */
  async submitVideoFromImage({ image, filename = 'first.png', prompt, seconds = 4 }) {
    const form = new FormData();
    form.append('image', new Blob([image]), filename);
    form.append('prompt', prompt);
    form.append('seconds', String(seconds));
    return (await this.request('POST', '/videos/from-image', { form })).task_id;
  }

  /** 查任务：{status: queued|running|done|failed, images: [链接], videos: [链接], error} */
  async poll(taskId) {
    if (typeof taskId !== 'string' || !/^[\w-]{1,80}$/.test(taskId)) throw httpError(400, '中枢任务编号无效');
    const r = await this.request('GET', `/tasks/${encodeURIComponent(taskId)}`);
    return { status: STATUS[r.status] || 'running', images: r.images || [], videos: r.videos || [], error: r.error || '', ahead: r.ahead };
  }

  /** 下载结果：只接受这个中枢的 /api/files/ 链接；图片可要求中枢转成 PNG */
  async download(url, { png = false, max = 20 * 1024 * 1024 } = {}) {
    const t = await this.token();
    let u;
    try { u = new URL(url); } catch { throw httpError(502, '中枢返回的下载链接无效'); }
    if (u.origin !== new URL(t.hub).origin || !u.pathname.startsWith('/api/files/')) throw httpError(502, '下载链接不是这个中枢的');
    if (png) u.searchParams.set('fmt', 'png');
    // 中枢到上游偶尔断流（SSL EOF 等）：网络错误和 5xx 自动再试两次（隔 1.5 秒、3 秒），4xx（链接过期等）不重试
    for (let attempt = 0; ; attempt++) {
      let res, buf;
      try {
        res = await this.fetch(u.href, { redirect: 'error', signal: AbortSignal.timeout(300_000) });
        if (res.ok) buf = Buffer.from(await res.arrayBuffer());
      } catch { res = null; }
      if (buf) {
        if (buf.length > max) throw httpError(502, '生成结果超过大小上限');
        return buf;
      }
      if (res && res.status < 500) throw httpError(502, `下载生成结果失败（HTTP ${res.status}），链接可能已过期，刷新任务会拿到新链接`);
      if (attempt >= 2) throw httpError(502, `下载生成结果失败（${res ? `HTTP ${res.status}` : '网络中断'}，已自动重试 2 次），稍后刷新任务会再下载`);
      await this.sleep(1500 * (attempt + 1));
    }
  }
}

export const hubGen = new HubGen();

/** 视频创作页用的「公司中枢」视频服务：和视频网关（video-service.mjs）同一套接口，供 VideoWorkflow 换用 */
const FRAMES_TO_SECONDS = { 73: 3, 124: 5, 192: 8, 243: 10 };
const SIZE_TO_RATIO = { '576x768': '3:4', '480x864': '9:16', '864x480': '16:9', '640x640': '1:1' };
export const HUB_VIDEO_MODES = ['t2v', 'i2v'];
export class HubVideoService {
  constructor(gen = hubGen) { this.gen = gen; }
  available() { return this.gen.available(); }
  config() {
    if (!this.gen.available()) throw httpError(409, '这个工作台没有接上企业中枢：请双击桌面「小红书运营工作台」图标从中枢打开，或改用视频网关');
    return { baseUrl: 'company-hub' };
  }
  async submit(input) {
    const { mode, prompt, width, height, total_frames: frames, reference_images: refs = [] } = input;
    const seconds = FRAMES_TO_SECONDS[frames];
    if (!HUB_VIDEO_MODES.includes(mode) || !seconds) {
      const e = httpError(400, '公司中枢目前只支持「文生视频」和「图片动起来」'); e.notSubmitted = true; throw e;
    }
    if (mode === 'i2v') {
      const r = refs[0];
      return { job_id: await this.gen.submitVideoFromImage({ image: Buffer.from(r.data_base64, 'base64'), filename: r.filename, prompt, seconds }) };
    }
    const aspect = SIZE_TO_RATIO[`${width}x${height}`];
    if (!aspect) { const e = httpError(400, '公司中枢不支持这个视频比例'); e.notSubmitted = true; throw e; }
    return { job_id: await this.gen.submitVideo({ prompt, aspect, seconds }) };
  }
  async poll(id) {
    this.id(id);
    const r = await this.gen.poll(id);
    return { status: { queued: 'queued', running: 'running', done: 'done', failed: 'error' }[r.status], error: r.error, ahead: r.ahead };
  }
  /** 中枢的下载链接带有效期：每次下载前重新查一次任务拿新链接 */
  async download(id) {
    const r = await this.gen.poll(id);
    if (!r.videos.length) throw httpError(502, '中枢任务已完成但没有视频文件');
    return this.gen.download(r.videos[0], { max: 200 * 1024 * 1024 });
  }
  id(id) { if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id)) throw httpError(400, '中枢任务编号无效'); }
}
export const hubVideoService = new HubVideoService();
