// 持久复用的只读有头浏览器。Bridge 保证与同账号 MCP 任务互斥；这里不接收任意 URL/脚本。
import path from 'node:path';
import { assertBrowserAccess, lockBrowserAccess, warningKind } from './access-policy.mjs';
import { recognizeScreenshot, corroborateProfile, downloadAvatar } from './visual-capture.mjs';
import { PROFILES_DIR, detectRealBrowser, migrateLegacyProfile, profileHasLock } from './browser.mjs';
import { loadPlaywright } from './browser-runtime.mjs';
import { canonicalProfileUrl, chooseSearchProfile, chooseVisibleNotes, isXhsPage, pageWarning, readCreatorIdentity, readProfile, readProfileExtras, readVisibleNote } from './browser-read.mjs';

const CREATOR = 'https://creator.xiaohongshu.com/';
const SEARCH = 'https://www.xiaohongshu.com/search_result?keyword=';
const NAV_TIMEOUT = 22_000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** 后台组件读两篇笔记之间的随机间隔（毫秒） */
export const NOTE_GAP_MS = [20_000, 45_000];
const interrupted = (signal) => { if (signal?.aborted) throw new Error('已取消'); };

export class BrowserWorker {
  constructor({ load = loadPlaywright, profileRoot = PROFILES_DIR, detect = detectRealBrowser, onState = () => {}, delay = pause, recognize = recognizeScreenshot, download = downloadAvatar, now = Date.now, random = Math.random, proofTtlMs = 15 * 60_000, assertAccess = assertBrowserAccess, lockAccess = lockBrowserAccess } = {}) {
    this.load = load;
    Object.assign(this, { now, random, proofTtlMs, assertAccess, lockAccess });
    this.recognize = recognize;
    this.download = download;
    this.profileRoot = profileRoot;
    this.detect = detect;
    this.onState = onState;
    this.delay = delay;
    this.instances = new Map();
    this.states = new Map();
    this.opening = new Map();
  }

  status(accountId) {
    if (accountId) return this.states.get(accountId) || { phase: 'idle', window: 'closed' };
    return Object.fromEntries(this.states);
  }

  #set(accountId, fields) {
    this.states.set(accountId, { ...this.status(accountId), ...fields, changedAt: new Date().toISOString() });
    this.onState(accountId);
  }

  async #open(accountId) {
    if (this.instances.has(accountId)) return this.instances.get(accountId);
    if (this.opening.has(accountId)) return this.opening.get(accountId);
    const loading = (async () => {
      if (!/^[\w-]+$/.test(accountId)) throw new Error('账号 id 不合法');
      migrateLegacyProfile();
      const profile = path.join(this.profileRoot, accountId);
      // 其他进程占用时不尝试接管、更不删除 Chromium 锁或复制 Cookie。
      if (profileHasLock(profile)) throw new Error('浏览器资料被其他进程占用；请先关闭使用这份资料的浏览器，再重试（不会删除锁文件）');
      const { chromium } = await this.load();
      const channel = this.detect();
      this.#set(accountId, { phase: 'starting', window: 'visible', browser: channel || 'chromium' });
      let context;
      try {
        context = await chromium.launchPersistentContext(profile, {
          ...(channel && channel !== 'chromium' ? { channel } : {}),
          headless: false, viewport: null, timeout: NAV_TIMEOUT,
        });
        await context.route('**/*', (route) => {
          const request = route.request();
          return request.isNavigationRequest() && !isXhsPage(request.url()) ? route.abort('blockedbyclient') : route.continue();
        });
        const page = context.pages()[0] || await context.newPage();
        page.on('popup', async (popup) => {
          await popup.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
          if (!isXhsPage(popup.url())) popup.close().catch(() => {});
        });
        const instance = { context, page, window: 'visible', startedAt: Date.now() };
        this.instances.set(accountId, instance);
        context.on('close', () => {
          if (this.instances.get(accountId)?.context === context) {
            this.instances.delete(accountId);
            this.#set(accountId, { phase: 'idle', window: 'closed', reason: '浏览器窗口已关闭；下次读取会重新打开' });
          }
        });
        this.#set(accountId, { phase: 'ready', window: 'visible', reused: false });
        return instance;
      } catch (err) {
        await context?.close().catch(() => {});
        throw err;
      }
    })();
    this.opening.set(accountId, loading);
    try {
      return await loading;
    } catch (err) {
      this.#set(accountId, { phase: 'error', window: 'closed', reason: err.message });
      throw err;
    } finally {
      this.opening.delete(accountId);
    }
  }

  async close(accountId) {
    // 等待启动完成再释放：不能让 CLI 与一个仍在启动的浏览器抢同一资料。
    try { await this.opening.get(accountId); } catch { /* 启动失败时没有资料持有者 */ }
    const current = this.instances.get(accountId);
    if (!current) return;
    this.instances.delete(accountId);
    try {
      await current.context.close();
    } finally {
      this.#set(accountId, { phase: 'idle', window: 'closed' });
    }
  }

  async closeAll() {
    await Promise.all([...new Set([...this.instances.keys(), ...this.opening.keys()])].map((id) => this.close(id)));
  }

  async #window(accountId, mode) {
    const instance = this.instances.get(accountId);
    if (!instance) return;
    try {
      if (!instance.cdp) {
        instance.cdp = await instance.context.newCDPSession(instance.page);
        instance.windowId = (await instance.cdp.send('Browser.getWindowForTarget')).windowId;
      }
      await instance.cdp.send('Browser.setWindowBounds', { windowId: instance.windowId,
        bounds: { windowState: mode === 'minimized' ? 'minimized' : 'normal' } });
      instance.window = mode;
      this.#set(accountId, { window: mode, windowNote: '' });
    } catch {
      const hidden = mode === 'visible' && ['minimized', 'unknown'].includes(instance.window);
      instance.window = hidden ? 'unknown' : 'visible';
      this.#set(accountId, { window: instance.window, windowNote: hidden
        ? '无法自动恢复最小化窗口，请在系统任务栏或 Dock 手动打开浏览器完成登录/核对'
        : '系统不支持窗口最小化；仍使用可见有头窗口，可能影响焦点' });
    }
  }

  async #pace(signal, min = 900, max = 1800) {
    interrupted(signal);
    let remaining = min + Math.floor(Math.max(0, Math.min(1, this.random())) * (max - min));
    while (remaining > 0) {
      const step = Math.min(100, remaining);
      await this.delay(step);
      interrupted(signal);
      remaining -= step;
    }
  }

  async #ready(page, kind, signal) {
    interrupted(signal);
    await page.waitForFunction((kind) => {
      const visible = el => el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
      if (/AI不规范|商业权益|流量曝光|验证码|安全验证|操作频繁|访问受限|异常访问|风险提示|滑块验证|扫码登录|手机号登录|请先登录|当前笔记暂时无法浏览|请打开小红书App扫码查看/.test(document.body?.innerText || '') || /\/login(?:\/|\?|$)/.test(location.href)) return true;
      if (kind === 'profile') return [...document.querySelectorAll('.user-info, .user-profile, [class*="profile-info"]')].some(el => visible(el) && /小红书号/.test(el.innerText)) && !!document.querySelector('[class*="note-list"], [class*="noteList"], [class*="feeds-container"], [class*="user-posts"]');
      if (kind === 'search') return [...document.querySelectorAll('a[href*="/user/profile/"]')].some(visible);
      if (kind === 'creator') return /小红书(?:账号|号)/.test(document.querySelector('header, [class*="header"], .personal .base')?.innerText || '') || [...document.querySelectorAll('.personal .base')].some(el => visible(el) && /小红书(?:账号|号)/.test(el.innerText));
      return [...document.querySelectorAll('[class*="note-detail"], [class*="note-container"], [class*="note-scroller"], [class*="noteDetail"]')].some(el => visible(el) && (el.querySelector('[class*="title"], h1, #detail-desc, .desc, .note-text')?.textContent || '').trim());
    }, kind, { timeout: 8000, polling: 200 });
    interrupted(signal);
  }

  async #returnToProfile(accountId, page, url, signal) {
    interrupted(signal);
    this.assertAccess(accountId);
    const close = page.locator('[class*="note-detail"] [aria-label="关闭"]:visible, .close-circle:visible, .close-box:visible, button[aria-label="关闭"]:visible').first();
    if (await close.count()) await close.click({ timeout: 5000 });
    else await page.goBack({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await this.#ready(page, 'profile', signal);
    if (canonicalProfileUrl(page.url()) !== url) throw new Error('无法返回原主页，已停止采集');
    const warning = pageWarning(await page.locator('body').innerText({ timeout: 5000 }), page.url());
    if (warning) throw new Error(warning);
  }

  #warning(accountId, reason) {
    const kind = warningKind(reason);
    if (!kind) return;
    const instance = this.instances.get(accountId);
    if (instance) delete instance.proof;
    this.lockAccess(accountId, kind, reason);
  }

  async #goto(accountId, page, url, signal, { login = false } = {}) {
    if (!login) this.assertAccess(accountId);
    interrupted(signal);
    if (!isXhsPage(url)) throw new Error('只允许访问小红书页面');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    if (!isXhsPage(page.url())) throw new Error('页面跳转到非小红书域名，已停止');

    interrupted(signal);
  }

  async #snapshot(page) {
    return page.evaluate(() => {
      const top = document.querySelector('header, [class*="header"], [class*="Header"]');
      const menu = top?.querySelector('[class*="account-info"], [class*="user-info"], [class*="userInfo"]');
      const panels = [...document.querySelectorAll('.personal .base')].filter(el => el.querySelector('.account-name') && el.getClientRects().length);
      return { url: location.href, accountPanel: panels.map(el => el.innerText).join('\n').slice(0, 1200), header: top?.innerText?.slice(0, 1000) || '',
        accountMenu: menu?.innerText?.slice(0, 600) || '', text: document.body?.innerText?.slice(0, 5000) || '' };
    });
  }

  async #creator(accountId, signal, { login = false } = {}) {
    const { page } = await this.#open(accountId);
    this.#set(accountId, { phase: 'checking-login' });
    await this.#goto(accountId, page, CREATOR, signal, { login });
    await this.#ready(page, 'creator', signal).catch(err => { if (signal?.aborted) throw err; });
    let snapshot;
    for (let i = 0; i < 3; i++) {
      interrupted(signal);
      snapshot = await this.#snapshot(page);
      const identity = readCreatorIdentity(snapshot);
      if (identity.state === 'ready') return { page, identity };
      if (identity.state !== 'needsLogin' && (i > 0 || /验证码|访问限制|操作频繁/.test(identity.reason))) return { page, identity };
      if (i < 2) await this.#pace(signal, 500, 1000);
    }
    return { page, identity: readCreatorIdentity(snapshot) };
  }

  /**
   * 「登录账号」：打开这个账号自己的浏览器到创作者中心；没登录就把窗口亮出来，停在登录页等员工本人扫码（最多 waitMs），
   * 扫完自动核对。登录是员工本人的操作，不受自动访问锁限制（锁拦的是自动访问；否则「需要登录」锁会把登录本身锁死）。
   * 工作台账号还没填小红书号时，用浏览器里登录的这个（由调用方保存）；填了但不一致时不放行，请员工换号。
   */
  async prepare(account, { signal, waitMs = 0 } = {}) {
    const existing = this.instances.get(account.id);
    if (existing) delete existing.proof;
    let { page, identity } = await this.#creator(account.id, signal, { login: true });
    const deadline = this.now() + waitMs;
    // 员工就在浏览器前：要扫码、或小红书弹了验证码 / 安全验证，都把窗口亮出来等本人处理，不像自动采集那样立刻停手上锁
    const needsUser = (id) => id.state === 'needsLogin' || (id.state === 'needsReview' && /验证|访问限制|操作频繁|风险/.test(id.reason || ''));
    while (needsUser(identity) && this.now() < deadline) {
      await this.#window(account.id, 'visible');
      this.#set(account.id, { phase: identity.state === 'needsLogin' ? 'needsLogin' : 'needsUser',
        reason: identity.state === 'needsLogin' ? '请在弹出的浏览器里用小红书 App 扫码登录' : '小红书要求验证：请在弹出的浏览器里完成验证' });
      await this.#pace(signal, 3000, 4000);
      identity = readCreatorIdentity(await this.#snapshot(page).catch(() => ({ url: '' })));
    }
    if (identity.state !== 'ready') {
      // 登录流程里只记「需要登录」（登录好会自动解开）；验证码没处理完不记成平台限制——那是给自动采集的规则，之后采集再遇到会照常停手
      if (identity.state === 'needsLogin') this.#warning(account.id, identity.reason);
      await this.#window(account.id, 'visible');
      this.#set(account.id, { phase: identity.state, reason: identity.reason });
      return identity;
    }
    if (account.xhsId && account.xhsId.trim() !== identity.xhsId) {
      const reason = `当前浏览器登录的小红书号（${identity.xhsId}）与工作台账号填写的（${account.xhsId.trim()}）不一致，请在浏览器里换成对应的账号后再点一次`;
      await this.#window(account.id, 'visible');
      this.#set(account.id, { phase: 'needsReview', reason });
      return { state: 'needsReview', reason };
    }
    this.instances.get(account.id).proof = { xhsId: identity.xhsId, checkedAt: this.now() };
    await this.#window(account.id, 'minimized');
    this.#set(account.id, { phase: 'ready', reason: '' });
    return { state: 'ready', xhsId: identity.xhsId, filledXhsId: !account.xhsId, window: this.status(account.id).window };
  }

  async verify(account, benchmark, { signal, onProgress = () => {}, onVerified = async () => {}, onNote = async () => {}, onFinish = async () => {} } = {}) {
    const started = Date.now();
    this.assertAccess(account.id);
    const instance = this.instances.get(account.id);
    const proof = instance?.proof;
    if (!proof || proof.xhsId !== account.xhsId?.trim() || this.now() - proof.checkedAt >= this.proofTtlMs) {
      const reason = '请先显式准备浏览器并核对登录账号；准备凭据不存在或已过期';
      this.#set(account.id, { phase: 'needsReview', reason });
      return { state: 'needsReview', reason, elapsedMs: Date.now() - started };
    }
    const { page } = instance;
    try {
      const review = async (result) => {
        this.#warning(account.id, result.reason);
        await this.#window(account.id, 'visible');
        this.#set(account.id, { phase: result.state, reason: result.reason, lastElapsedMs: Date.now() - started });
        return { ...result, elapsedMs: Date.now() - started };
      };
      let url = benchmark.url ? canonicalProfileUrl(benchmark.url) : null;
      if (benchmark.url && !url) return review({ state: 'needsReview', reason: '对标账号的现有主页链接不合法，请人工核对' });
      if (!url) {
        this.#set(account.id, { phase: 'searching' });
        onProgress('查找主页', '只搜索一个候选账号，不浏览无关页面');
        const term = String(benchmark.xhsId || benchmark.name || '').trim().slice(0, 80);
        if (!term) return review({ state: 'needsReview', reason: '候选账号缺少名称或小红书号' });
        await this.#goto(account.id, page, `${SEARCH}${encodeURIComponent(term)}&source=web_explore_feed`, signal);
        await this.#ready(page, 'search', signal);
        const rows = await page.evaluate(() => [...document.querySelectorAll('a[href*="/user/profile/"]')].slice(0, 30).map((a) => ({
          url: a.href, name: (a.querySelector('[class*="name"], [class*="Name"]')?.textContent || a.innerText?.split('\n').find((line) => line.trim()))?.trim()?.slice(0, 120) || '',
          text: a.innerText?.slice(0, 400) || '',
        })));
        const warning = pageWarning(await page.locator('body').innerText({ timeout: 5000 }).then((s) => s.slice(0, 1200)), page.url());
        if (warning) return review({ state: /登录/.test(warning) ? 'needsLogin' : 'needsReview', reason: warning });
        const found = chooseSearchProfile(rows, benchmark);
        if (found.state !== 'ready') return review(found);
        url = found.url;
        await this.#pace(signal);
      }
      if (benchmark.url) await this.#pace(signal);
      this.#set(account.id, { phase: 'reading-profile' });
      onProgress('读取主页', '只读昵称、小红书号、可见指标和头像元素');
      await this.#goto(account.id, page, url, signal);
      await this.#ready(page, 'profile', signal);
      const snapshot = await page.evaluate(() => {
        const info = document.querySelector('.user-info, .user-profile, [class*="user-info"], [class*="profile-info"]');
        const name = info?.querySelector('.user-name, [class*="user-name"], h1') || document.querySelector('.user-name, [class*="user-name"], h1');
        const grid = document.querySelector('[class*="note-list"], [class*="noteList"], [class*="feeds-container"], [class*="user-posts"]');
        const noteRows = grid ? [...grid.querySelectorAll('a.cover[href], a[href*="/explore/"], a[href*="/discovery/item/"]')].filter(a => a.getClientRects().length && getComputedStyle(a).visibility !== 'hidden').slice(0, 40).map((a) => ({
          url: a.href, title: a.parentElement?.querySelector('[class*="title"]')?.textContent?.trim()?.slice(0, 200) || '',
        })) : null;
        return { url: location.href, name: name?.textContent?.trim()?.slice(0, 120) || '',
          details: info?.innerText?.slice(0, 1800) || '', bio: info?.querySelector('[class*="desc"], [class*="bio"]')?.textContent?.trim()?.slice(0, 500) || '',
          countText: grid?.parentElement?.innerText?.slice(0, 500) || '', noteRows,
          text: document.body?.innerText?.slice(0, 1600) || '' };
      });
      interrupted(signal);
      const result = readProfile(snapshot, benchmark, url);
      if (result.state !== 'verified') return review(result);
      const domProfile = { ...readProfileExtras(snapshot), ...(result.followers ? { followers: result.followers } : {}) };
      const visible = chooseVisibleNotes(snapshot.noteRows);
      await this.#window(account.id, 'visible');
      let profile = {}, profileEvidence, profileReason = '';
      try {
        const region = page.locator('.user-info:visible, .user-profile:visible, [class*="profile-info"]:visible').first();
        const png = await region.screenshot({ timeout: 8000, animations: 'disabled' });
        profileEvidence = { png, ocr: { engine: 'unavailable', text: '', lines: [] } };
        profileEvidence.ocr = await this.recognize(png, { signal });
        profile = corroborateProfile(domProfile, profileEvidence.ocr);
        if (Object.keys(profile).length < Object.keys(domProfile).length) profileReason = '部分主页字段 OCR 未核对成功，保留原文待核对';
      } catch (err) { profileReason = `主页截图/OCR 未完成：${err.message.slice(0, 100)}`; }
      let avatarDownloaded = null;
      let avatarPng = null;
      let avatarReason = '';
      try {
        const avatar = page.locator('.avatar-wrapper > img.user-image:visible');
        if (await avatar.count() === 1) {
          await this.#window(account.id, 'visible');
          try {
            const src = await avatar.evaluate(el => el.currentSrc || el.src);
            avatarDownloaded = await this.download(src, { signal });
          } catch { /* 下载不可用时只截目标头像元素 */ }
          const shot = avatarDownloaded ? null : await avatar.screenshot({ timeout: 5000 });
          if (avatarDownloaded) { /* 原图已获取 */ }
          else if (shot.length <= 2 * 1024 * 1024 && shot.length >= 24
            && shot.readUInt32BE(16) <= 2048 && shot.readUInt32BE(20) <= 2048) avatarPng = shot;
          else avatarReason = '主页头像截图超过大小或尺寸限制';
        } else avatarReason = '主页头像元素未找到';
      } catch {
        avatarReason = '无法截取主页头像元素';
      }
      interrupted(signal);
      await onVerified({ ...result, profile, profileEvidence, avatarPng, avatarDownloaded, ...(snapshot.noteRows ? { discoveredCount: visible.length, visibleNoteUrls: visible.map(n => n.url) } : {}),
        reason: [profileReason, avatarReason, !snapshot.noteRows ? '主页笔记列表未显示' : ''].filter(Boolean).join('；') });
      const failures = [];
      if (profileReason) failures.push(profileReason);
      if (avatarReason) failures.push(avatarReason);
      if (!snapshot.noteRows) failures.push('主页笔记列表未显示');
      let captured = 0;
      let attempted = 0;
      for (let i = 0; i < visible.length; i++) {
        interrupted(signal);
        attempted = i + 1;
        this.#set(account.id, { phase: 'reading-note' });
        onProgress('读取可见笔记', `${i + 1}/${visible.length} · 只读取页面上的标题和互动字段`);
        let note;
        try {
          // 笔记之间的间隔：以前是 0.9–1.8 秒，太密。这是后台组件（默认关）这条路的下限，和 agent 路径的「两篇至少隔 25 秒」同一个量级
          const gap = process.env.XHS_PACE_RELAX === '1' ? [900, 1800] : NOTE_GAP_MS;  // 开发 / 自动测试用，见 pace.mjs
          await this.#pace(signal, gap[0], gap[1]);
          const noteId = visible[i].url.split('/').pop();
          const card = page.locator(`a[href*="/explore/${noteId}"]:visible, a[href*="/discovery/item/${noteId}"]:visible, a.cover[href*="/${noteId}"]:visible`).first();
          const warningBefore = pageWarning(await page.locator('body').innerText({ timeout: 5000 }), page.url());
          if (warningBefore) { failures.push(warningBefore); break; }
          this.assertAccess(account.id);
          await card.click({ timeout: 8000 });
          await this.#ready(page, 'note', signal);
          interrupted(signal);
          const notePage = await page.evaluate(() => {
            const detail = document.querySelector('[class*="note-detail"], [class*="note-container"], [class*="note-scroller"], [class*="noteDetail"]');
            const title = detail?.querySelector('[class*="title"], h1');
            const metrics = detail?.querySelector('.interact-container');
            const counts = [['点赞', '.like-wrapper .count'], ['收藏', '.collect-wrapper .count'], ['评论', '.chat-wrapper .count']]
              .map(([label, selector]) => { const text = metrics?.querySelector(selector)?.textContent?.trim() || ''; return /^[\d,.]+\s*[万亿kKwW]?$/.test(text) ? `${label}・${text}` : ''; }).filter(Boolean).join('\n');
            return { url: location.href, title: title?.textContent?.trim()?.slice(0, 200) || '',
              details: counts,
              description: detail?.querySelector('#detail-desc, .desc, .note-text')?.textContent?.trim()?.slice(0, 400) || '',
              publishedAt: detail?.querySelector('.date, time[datetime], [class*="publish-time"]')?.textContent?.trim()?.slice(0, 80) || '',
              type: detail?.querySelector('video') ? '视频' : '',
              pageText: document.body?.innerText?.slice(0, 5000) || '' };
          });
          const warning = pageWarning(notePage.pageText, notePage.url);
          if (warning) { failures.push(warning); await this.#window(account.id, 'visible'); break; }
          if (!notePage.title && !notePage.description) { failures.push(`第 ${i + 1} 篇详情内容尚未读到，未计入成功`); break; }
          note = readVisibleNote(notePage);
          if (note.state !== 'observed' || note.url !== visible[i].url) { failures.push(note.reason || '笔记页面与主页链接不一致'); break; }
        } catch (err) {
          if (signal?.aborted) throw err;
          failures.push(`第 ${i + 1} 篇笔记未能读取：${err.message.slice(0, 100)}`);
          break;
        }
        // 持久化失败是任务错误，不是页面缺字段；不可吞掉后继续报“部分采集”。
        interrupted(signal);
        let noteEvidence;
        try {
          const region = page.locator('[class*="note-detail"]:visible, [class*="note-container"]:visible, [class*="note-scroller"]:visible').first();
          noteEvidence = { png: await region.screenshot({ timeout: 8000, animations: 'disabled' }), ocr: { engine: 'dom-visible', text: JSON.stringify(note), lines: [] } };
        } catch (err) { failures.push(`第 ${i + 1} 篇截图未保存：${err.message.slice(0, 60)}`); }
        await onNote({ ...result, noteEvidence, note: { ...note, title: note.title || visible[i].title, position: i },
          observedAt: new Date().toISOString(), attemptedCount: i + 1 });
        captured++;
        try { await this.#returnToProfile(account.id, page, url, signal); }
        catch (err) {
          if (signal?.aborted) throw err;
          this.#warning(account.id, err.message);
          failures.push(`无法返回主页：${err.message.slice(0, 120)}`);
          break;
        }
      }
      interrupted(signal);
      // Classify each complete failure before shortening the display summary.
      // Earlier OCR/screenshot diagnostics must never hide a later access warning.
      for (const failure of failures) this.#warning(account.id, failure);
      const fullReason = failures.join('；');
      const reason = fullReason.slice(0, 240);
      await onFinish({ ...result, observedAt: new Date().toISOString(),
        state: failures.length ? 'partial' : 'complete', reason, captured, attemptedCount: attempted });
      if (!/登录|验证|访问限制|无法浏览|扫码查看/.test(fullReason)) await this.#window(account.id, 'minimized');
      this.#set(account.id, { phase: /登录/.test(fullReason) ? 'needsLogin' : /验证|访问限制|无法浏览/.test(fullReason) ? 'needsReview' : 'ready', reason, reused: true, lastElapsedMs: Date.now() - started });
      return { ...result, captureState: failures.length ? 'partial' : 'complete', captured, reason, elapsedMs: Date.now() - started };
    } catch (err) {
      await this.#window(account.id, 'visible');
      this.#set(account.id, { phase: 'error', reason: err.message });
      throw err;
    }
  }
}
