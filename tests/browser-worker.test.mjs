// 后台只读浏览器：保守字段解析、资料占用、窗口状态、与 MCP CLI 的交接
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempWorkspace, server, fakeAdapter, PNG_1PX } from './helpers.mjs';

const WS = useTempWorkspace();
const { canonicalProfileUrl, canonicalNoteUrl, chooseSearchProfile, chooseVisibleNotes, readCreatorIdentity, readProfile, readProfileExtras, readVisibleNote } = await server('browser-read.mjs');
const { BrowserWorker } = await server('browser-worker.mjs');
const { profileHasLock } = await server('browser.mjs');
const { Bridge, fastModelAdapter } = await server('bridge.mjs');
const store = await server('store.mjs');
store.ensureWorkspace();
const url = 'https://www.xiaohongshu.com/user/profile/abc123';
const account = { id: 'default', xhsId: 'my-account', name: '我的账号' };
const benchmark = { id: 'b_demo', name: '目标作者', url };

function mockBrowser({ minimizeFails = false, restoreFails = false, creator = 'my-account', profile = '目标作者', resultUrl = url, noteCount = 0, visibleEmpty = false, challengeAt = 0, blankNote = false, avatarSrc = '', returnFails = false } = {}) {
  let creatorReads = 0;
  const events = [];
  const contexts = [];
  const chromium = { async launchPersistentContext(dir, opts) {
    events.push(['launch', dir, opts]);
    const page = {
      current: '', on() {}, async waitForFunction() {}, async goBack() { if (returnFails) throw new Error('history unavailable'); this.current = url; events.push(['back']); }, url() { return this.current; },
      async goto(target) { this.current = target.startsWith('https://www.xiaohongshu.com/user/profile/') ? resultUrl : target; events.push(['goto', target]); },
      async evaluate() {
        if (this.current.startsWith('https://creator.')) return { url: this.current,
          header: `我的账户 小红书号：${typeof creator === 'function' ? creator(++creatorReads) : creator}`, accountMenu: '', text: '创作者中心首页' };
        if (this.current.includes('/search_result')) return [{ url, name: profile, text: `${profile} 小红书号：somebody` }];
        if (this.current.includes('/explore/')) {
          const index = Number(/note(\d+)/.exec(this.current)?.[1]);
          return { url: this.current, title: blankNote ? '' : `笔记 ${index}`, details: '点赞・12 收藏・3 评论・1',
            pageText: challengeAt === index ? '安全验证' : '正常页面', publishedAt: '3天前', type: '图文' };
        }
        return { url: this.current, name: profile, details: `小红书号：somebody 粉丝・1.3万 关注・42 获赞与收藏・8.6万`,
          bio: '分享真实经验', noteRows: noteCount || visibleEmpty ? Array.from({ length: noteCount }, (_, i) => ({ url: `https://www.xiaohongshu.com/explore/note${i + 1}abcd`, title: `笔记 ${i + 1}` })) : undefined,
          text: `${profile} 粉丝` };
      },
      locator(selector) { return { click: async () => { const id = /note\d+abcd/.exec(selector)?.[0]; page.current = `https://www.xiaohongshu.com/explore/${id}`; events.push(['click', page.current]); }, evaluate: async () => avatarSrc, count: async () => selector.includes('close') ? 0 : 1, screenshot: async () => PNG_1PX, innerText: async () => '用户搜索结果', first() { return this; } }; },
    };
    const context = { pages: () => [page], on(event, callback) { if (event === 'close') this.closed = callback; }, async route() {}, async newCDPSession() { return { async send(cmd, arg) {
      events.push(['cdp', cmd, arg]);
      if (cmd === 'Browser.getWindowForTarget') return { windowId: 1 };
      if ((minimizeFails && arg?.bounds.windowState === 'minimized') || (restoreFails && arg?.bounds.windowState === 'normal')) throw new Error('not supported');
      return {};
    } }; }, async close() { events.push(['close', dir]); this.closed?.(); } };
    contexts.push(context);
    return context;
  } };
  return { events, contexts, load: async () => ({ chromium }) };
}

const workerFor = (options = {}) => {
  const fake = mockBrowser(options);
  return { worker: new BrowserWorker({ assertAccess: () => {}, lockAccess: () => {}, load: fake.load, profileRoot: fs.mkdtempSync(path.join(WS, 'profiles-')), detect: () => 'chrome', ...(options.download ? {download: options.download} : {}), recognize: async () => ({ engine: 'fixture', text: '分享真实经验\n42 关注\n1.3万 粉丝\n8.6万 获赞与收藏', lines: [] }), delay: async () => {}, ...options.workerOptions }), events: fake.events, contexts: fake.contexts };
};

test('URL 和字段解析拒绝跨域、登录挑战、缺字段和同名歧义', () => {
  assert.equal(canonicalProfileUrl(`${url}?xsec_token=sensitive`), url);
  for (const bad of ['https://evil.example/user/profile/abc', 'https://www.xiaohongshu.com.evil/user/profile/abc', 'http://www.xiaohongshu.com/user/profile/abc', 'https://user:pass@www.xiaohongshu.com/user/profile/abc']) {
    assert.equal(canonicalProfileUrl(bad), null);
  }
  assert.equal(readCreatorIdentity({ url: 'https://creator.xiaohongshu.com/login', text: '扫码登录' }).state, 'needsLogin');
  assert.equal(readCreatorIdentity({ url: 'https://creator.xiaohongshu.com/', header: '小红书号：a123 小红书号：b456' }).state, 'needsReview');
  assert.equal(readCreatorIdentity({ url: 'https://creator.xiaohongshu.com/', text: '小红书号：my-account' }).state, 'needsReview'); // 正文不是账号菜单
  const rows = [{ url, name: '同名', text: '小红书号：u123' }, { url: url.replace('abc123', 'xyz'), name: '同名', text: '小红书号：u456' }];
  assert.equal(chooseSearchProfile(rows, { name: '同名' }).state, 'needsReview');
  assert.equal(chooseSearchProfile(rows, { name: '同名', xhsId: 'u456' }).url, rows[1].url);
  assert.equal(readProfile({ url, name: '目标作者', details: '', text: '正常' }, benchmark, url).state, 'needsReview');
  assert.equal(readProfile({ url, name: '其他作者', details: '小红书号：somebody', text: '正常' }, benchmark, url).state, 'needsReview');
  assert.equal(readProfile({ url, name: '目标作者', details: '小红书号：somebody 粉丝・1万', text: '验证码' }, benchmark, url).state, 'needsReview');
  assert.equal(readProfile({ url: 'https://evil.example/user/profile/abc', name: '目标作者', details: '小红书号：somebody' }, benchmark, url).state, 'needsReview');
});

test('可见数据解析只接受小红书笔记，不把缺失互动量猜成零', () => {
  assert.equal(canonicalNoteUrl('https://evil.example/explore/note1abcd'), null);
  assert.equal(canonicalNoteUrl('https://www.xiaohongshu.com/explore/note1abcd?xsec_token=secret'), 'https://www.xiaohongshu.com/explore/note1abcd');
  assert.equal(chooseVisibleNotes([{ url: 'https://evil.example/explore/note1abcd' },
    { url: 'https://www.xiaohongshu.com/explore/note1abcd' }]).length, 1);
  const profile = readProfileExtras({ details: '关注・42 获赞与收藏・8.6万', bio: '简介' });
  assert.equal(profile.following, '42');
  assert.equal(profile.likesAndCollects, '8.6万');
  const note = readVisibleNote({ url: 'https://www.xiaohongshu.com/explore/note1abcd', title: '标题', details: '点赞・12 评论・1' });
  assert.equal(note.likes, '12');
  assert.equal(note.comments, '1');
  assert.equal(note.collects, undefined);
});

test('有头 worker 只读取前五篇并逐篇回调；挑战页保留已完成项', async () => {
  const complete = workerFor({ noteCount: 8 });
  const observed = [];
  let profile;
  let summary;
  await complete.worker.prepare(account);
  const result = await complete.worker.verify(account, benchmark, {
    onVerified: async (data) => { profile = data; },
    onNote: async (data) => observed.push(data.note),
    onFinish: async (data) => { summary = data; },
  });
  assert.equal(result.state, 'verified');
  assert.equal(result.captured, 5);
  assert.equal(observed.length, 5);
  assert.ok(Buffer.isBuffer(profile.avatarPng));
  assert.equal(profile.profile.following, '42');
  assert.ok(Buffer.isBuffer(profile.profileEvidence.png));
  assert.match(profile.profileEvidence.ocr.text, /关注/);
  assert.equal(complete.events.filter(([kind, target]) => kind === 'goto' && target.includes('/explore/')).length, 0);
  assert.equal(summary.state, 'complete');
  assert.equal(complete.events.filter(([kind, target]) => kind === 'click' && target.includes('/explore/')).length, 5);
  await complete.worker.closeAll();

  const challenged = workerFor({ noteCount: 6, challengeAt: 3 });
  const kept = [];
  let partial;
  await challenged.worker.prepare(account);
  await challenged.worker.verify(account, benchmark, {
    onNote: async (data) => kept.push(data.note), onFinish: async (data) => { partial = data; },
  });
  assert.equal(kept.length, 2);
  assert.equal(partial.state, 'partial');
  assert.match(partial.reason, /验证/);
  assert.equal(challenged.events.filter(([kind, target]) => kind === 'click' && target.includes('/explore/')).length, 3);
  await challenged.worker.closeAll();
});

test('笔记检查点写入失败不能被当成页面缺字段；取消保留已经回调的笔记', async () => {
  const { worker } = workerFor({ noteCount: 2 });
  let finished = false;
  await worker.prepare(account);
  await assert.rejects(worker.verify(account, benchmark, {
    onNote: async () => { throw new Error('checkpoint-write-failed'); },
    onFinish: async () => { finished = true; },
  }), /checkpoint-write-failed/);
  assert.equal(finished, false);
  await worker.closeAll();
  const cancelled = workerFor({ noteCount: 3 });
  const signal = new AbortController();
  const persisted = [];
  await cancelled.worker.prepare(account);
  await assert.rejects(cancelled.worker.verify(account, benchmark, {
    signal: signal.signal,
    onNote: async ({ note }) => { persisted.push(note.url); signal.abort(); },
  }), /已取消/);
  assert.equal(persisted.length, 1);
  assert.equal(cancelled.events.filter(([kind, target]) => kind === 'click' && target.includes('/explore/')).length, 1);
  await cancelled.worker.closeAll();
});

test('同一账号复用有头资料；CLI 请求前可关闭；不同账号隔离', async () => {
  const { worker, events } = workerFor();
  await worker.prepare(account);
  assert.equal((await worker.verify(account, benchmark)).state, 'verified');
  assert.equal((await worker.verify(account, benchmark)).state, 'verified');
  assert.equal(events.filter(([type]) => type === 'launch').length, 1);
  assert.equal(events[0][2].headless, false);
  assert.equal(worker.status('default').window, 'minimized');
  await worker.prepare({ ...account, id: 'second' });
  assert.equal(events.filter(([type]) => type === 'launch').length, 2);
  await worker.close('default');
  assert.equal(worker.status('default').window, 'closed');
  assert.equal(worker.status('second').window, 'minimized');
  await worker.closeAll();
  assert.equal(events.filter(([type]) => type === 'close').length, 2);
});

test('用户手动关闭工作进程窗口后，下次任务会重新打开资料', async () => {
  const { worker, events, contexts } = workerFor();
  assert.equal((await worker.prepare(account)).state, 'ready');
  contexts[0].closed();
  assert.equal(worker.status('default').window, 'closed');
  assert.equal((await worker.prepare(account)).state, 'ready');
  assert.equal(events.filter(([kind]) => kind === 'launch').length, 2);
  await worker.closeAll();
});

test('无法最小化则明确留在可见有头模式；外部锁不删除、不抢占', async () => {
  const { worker } = workerFor({ minimizeFails: true });
  await worker.prepare(account);
  assert.equal((await worker.verify(account, benchmark)).state, 'verified');
  assert.equal(worker.status('default').window, 'visible');
  assert.match(worker.status('default').windowNote, /可能影响焦点/);
  await worker.closeAll();
  const profile = path.join(worker.profileRoot, 'default');
  fs.mkdirSync(profile, { recursive: true });
  const lock = path.join(profile, 'SingletonLock');
  fs.writeFileSync(lock, 'external');
  await assert.rejects(worker.prepare(account), /其他进程占用/);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'external');
  fs.unlinkSync(lock);
  fs.symlinkSync('host-and-pid-that-does-not-exist', lock);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(profileHasLock(profile), true);
  await assert.rejects(worker.prepare(account), /其他进程占用/);
  assert.equal(fs.lstatSync(lock).isSymbolicLink(), true);
});

test('已最小化窗口无法恢复时提示用户从系统任务栏手动打开', async () => {
  const { worker } = workerFor({ restoreFails: true, creator: (n) => n === 1 ? 'my-account' : 'other-account' });
  assert.equal((await worker.prepare(account)).state, 'ready');
  assert.equal((await worker.prepare(account)).state, 'needsReview');
  assert.equal(worker.status('default').window, 'unknown');
  assert.match(worker.status('default').windowNote, /手动打开浏览器/);
  await worker.closeAll();
});

test('资料租约：worker 结束后 MCP 才能接管；取消和超时不写检查点', async () => {
  const adapter = fakeAdapter('text', { args: [fakeAdapter().args[0], '--mcp-config', '{mcpConfig}'], playwrightMcp: '@playwright/mcp@0.0.1' });
  store.saveBridgeConfig({ mode: 'cli', adapter });
  process.env.FAKE_AGENT_MODE = 'text';
  const events = [];
  let finish;
  const fake = {
    async verify(_account, _benchmark, { signal }) {
      events.push('worker-start');
      await new Promise((resolve) => { finish = resolve; signal.addEventListener('abort', resolve, { once: true }); });
      if (signal.aborted) throw new Error('已取消');
      return { state: 'verified', profileName: '目标作者', xhsId: 'someone', elapsedMs: 1 };
    },
    async close(id) { events.push(`close:${id}`); },
    async closeAll() {},
  };
  const bridge = new Bridge({ browserWorker: fake, onBenchmarkVerified: () => events.push('saved') });
  bridge.on('claimed', ({ taskId }) => events.push(`start:${taskId}`));
  bridge.on('done', ({ taskId }) => events.push(`done:${taskId}`));
  bridge.on('error', ({ taskId }) => events.push(`error:${taskId}`));
  const done = (id) => new Promise((resolve) => {
    const onEnd = ({ taskId }) => { if (taskId === id) { bridge.off('done', onEnd); bridge.off('error', onEnd); resolve(); } };
    bridge.on('done', onEnd); bridge.on('error', onEnd);
  });
  const first = done('w');
  const second = done('cli');
  bridge.submit({ id: 'w', kind: 'benchmark.verify', accountId: 'default', account, benchmark });
  bridge.submit({ id: 'cli', accountId: 'default', prompt: 'x' });
  assert.equal(bridge.status().pending, 1);
  finish();
  await first; await second;
  assert.ok(events.indexOf('close:default') > events.indexOf('done:w'));
  assert.ok(events.indexOf('start:cli') > events.indexOf('close:default'));
  assert.ok(events.includes('saved'));
  const cancelled = done('cancel');
  bridge.submit({ id: 'cancel', kind: 'benchmark.verify', accountId: 'default', account, benchmark });
  bridge.cancel('cancel');
  await cancelled;
  assert.equal(events.filter((e) => e === 'saved').length, 1);
  const timeout = done('timeout');
  bridge.submit({ id: 'timeout', kind: 'benchmark.verify', accountId: 'default', account, benchmark, timeoutMs: 10 });
  await timeout;
  assert.equal(events.filter((e) => e === 'saved').length, 1);
  delete process.env.FAKE_AGENT_MODE;
});

test('快速模型适配器与普通模型隔离：没有浏览器、写工具或续接', () => {
  const original = { id: 'claude-code', command: 'claude', bins: ['claude'], args: ['--mcp-config', '{mcpConfig}'], resumeArgs: ['--resume', '{agentSessionId}'] };
  const isolated = fastModelAdapter(original, 'claude-haiku-5-5');
  assert.ok(isolated.args.includes('--model'));
  assert.ok(isolated.args.includes('--tools'));
  assert.equal(isolated.args[isolated.args.indexOf('--tools') + 1], '');
  assert.ok(isolated.args.includes('--strict-mcp-config'));
  assert.ok(isolated.args.includes('--no-chrome'));
  assert.ok(!isolated.args.includes('--mcp-config'));
  assert.equal(isolated.resumeArgs, undefined);
  assert.deepEqual(original.args, ['--mcp-config', '{mcpConfig}']);
  assert.throws(() => fastModelAdapter(original, 'bad model; rm -rf /'), /不合法/);
});

test('主页明确可见 0～4 篇时只处理实际篇数，不补满五篇', async () => {
  for (const count of [0, 1, 2, 3, 4]) {
    const { worker, events } = workerFor({ noteCount: count, visibleEmpty: true });
    let summary; const notes = [];
    await worker.prepare(account);
    await worker.verify(account, benchmark, { onNote: async data => notes.push(data.note), onFinish: async data => { summary = data; } });
    assert.equal(summary.state, 'complete'); assert.equal(summary.captured, count);
    assert.equal(notes.length, count);
    assert.equal(events.filter(([kind, target]) => kind === 'click' && target.includes('/explore/')).length, count);
    await worker.closeAll();
  }
});

test('创作者新版个人资料卡的小红书账号可核验，正文及冲突账号仍拒绝', () => {
  const input = { url: 'https://creator.xiaohongshu.com/new/home', header: '创作服务平台',
    accountPanel: '测试创作者\n79\n关注数\n小红书账号: owner123\n简介' };
  assert.deepEqual(readCreatorIdentity(input), { state: 'ready', xhsId: 'owner123' });
  assert.equal(readCreatorIdentity({ ...input, header: '小红书号：other123' }).state, 'needsReview');
  assert.equal(readCreatorIdentity({ url: input.url, text: input.accountPanel }).state, 'needsReview');
});

test('主页数字在标签前时不把下一项误作粉丝或关注', () => {
  const details = '小红书号：target123\n简介\n6\n关注\n1464\n粉丝\n1.8万\n获赞与收藏\n关注';
  assert.equal(readProfile({ url, name: '目标作者', details }, { ...benchmark, xhsId: 'target123' }, url).followers, '1464');
  assert.deepEqual(readProfileExtras({ details }), { following: '6', likesAndCollects: '1.8万' });
});

test('平台要求 App 扫码查看时报告访问限制并停止', () => {
  assert.equal(readVisibleNote({ url: 'https://www.xiaohongshu.com/404', details: '当前笔记暂时无法浏览\n请打开小红书App扫码查看' }).state, 'needsReview');
  assert.match(readVisibleNote({ url: 'https://www.xiaohongshu.com/404', details: '当前笔记暂时无法浏览\n请打开小红书App扫码查看' }).reason, /访问限制/);
});
test('主页实际可见卡片的 user/profile/user/note 路径规范化为笔记身份', () => {
  assert.equal(canonicalNoteUrl('https://www.xiaohongshu.com/user/profile/user123/note123abc?xsec_token=private'), 'https://www.xiaohongshu.com/explore/note123abc');
  assert.equal(canonicalNoteUrl('https://www.xiaohongshu.com/user/profile/user123'), null);
});
test('视频播放器时长不能写入笔记发布时间', () => {
  const noteUrl='https://www.xiaohongshu.com/explore/note123abc';
  assert.equal(readVisibleNote({url:noteUrl,title:'测试',publishedAt:'00:0005:38'}).publishedAt,undefined);
  assert.equal(readVisibleNote({url:noteUrl,title:'测试',publishedAt:'2天前 安徽'}).publishedAt,'2天前 安徽');
});

test('空详情不计入成功，头像原图优先于元素截图', async () => {
 const empty=workerFor({noteCount:1,blankNote:true});
 await empty.worker.prepare(account);
 const result=await empty.worker.verify(account,benchmark);
 assert.equal(result.captured,0);assert.equal(result.captureState,'partial');assert.match(result.reason,/详情/);await empty.worker.closeAll();
 const downloaded=workerFor({visibleEmpty:true,avatarSrc:'https://sns-avatar-qc.xhscdn.com/actual.png',download:async()=>({buffer:PNG_1PX,ext:'.png'})});
 await downloaded.worker.prepare(account);
 let profile;await downloaded.worker.verify(account,benchmark,{onVerified:async data=>{profile=data;}});
 assert.ok(profile.avatarDownloaded);assert.equal(profile.avatarPng,null);await downloaded.worker.closeAll();
});
test('本机确认已退出进程的锁交由Chrome恢复，活动/未知锁仍阻止且不删除',async()=>{const os=await import('node:os');const {spawn}=await import('node:child_process');const child=spawn(process.execPath,['-e','']);await new Promise(r=>child.once('exit',r));const dir=path.join(WS,'stale-profile');fs.mkdirSync(dir);const lock=path.join(dir,'SingletonLock');fs.symlinkSync(`${os.hostname()}-${child.pid}`,lock);assert.equal(profileHasLock(dir),false);assert.ok(fs.lstatSync(lock).isSymbolicLink());fs.unlinkSync(lock);fs.symlinkSync(`${os.hostname()}-${process.pid}`,lock);assert.equal(profileHasLock(dir),true);});

 test('verify requires a live matching preparation proof without opening any page', async () => {
 const {worker,events}=workerFor();
 assert.equal((await worker.verify(account,benchmark)).state,'needsReview');
 assert.equal(events.length,0);
 await worker.prepare(account);
 const before=events.filter(e=>e[0]==='goto').length;
 assert.equal((await worker.verify({...account,xhsId:'different'},benchmark)).state,'needsReview');
 assert.equal(events.filter(e=>e[0]==='goto').length,before);
 await worker.closeAll();
 assert.equal((await worker.verify(account,benchmark)).state,'needsReview');
 });
 test('five notes reuse preparation and return through history without profile reloads', async () => {
 const {worker,events}=workerFor({noteCount:5}); await worker.prepare(account);
 assert.equal((await worker.verify(account,benchmark)).captured,5);
 assert.equal(events.filter(e=>e[0]==='goto'&&e[1].startsWith('https://creator.')).length,1);
 assert.equal(events.filter(e=>e[0]==='goto'&&e[1]===url).length,1);
 assert.equal(events.filter(e=>e[0]==='back').length,5);
 await worker.closeAll();
 });

test('preparation expires and failed return preserves the completed note then stops', async () => {
 let now=1000; const expired=workerFor({workerOptions:{now:()=>now,proofTtlMs:100}});
 await expired.worker.prepare(account);now+=100;
 const before=expired.events.length;
 assert.equal((await expired.worker.verify(account,benchmark)).state,'needsReview');
 assert.equal(expired.events.length,before);await expired.worker.closeAll();
 const blocked=workerFor({noteCount:5,returnFails:true});await blocked.worker.prepare(account);
 const kept=[];const result=await blocked.worker.verify(account,benchmark,{onNote:async d=>kept.push(d.note)});
 assert.equal(result.captured,1);assert.equal(kept.length,1);assert.equal(result.captureState,'partial');
 assert.equal(blocked.events.filter(e=>e[0]==='click').length,1);await blocked.worker.closeAll();
});
test('restriction invalidates preparation and locks access; randomized pacing is interruptible', async () => {
 const locks=[];const restricted=workerFor({noteCount:3,challengeAt:2,workerOptions:{lockAccess:(...args)=>locks.push(args)}});
 await restricted.worker.prepare(account);assert.equal((await restricted.worker.verify(account,benchmark)).captured,1);
 assert.equal(locks[0][1],'restriction');
 assert.equal((await restricted.worker.verify(account,benchmark)).state,'needsReview');await restricted.worker.closeAll();
 const controller=new AbortController();const paced=workerFor({noteCount:3});await paced.worker.prepare(account);
 let total=0;paced.worker.delay=async ms=>{total+=ms;controller.abort();};
 await assert.rejects(paced.worker.verify(account,benchmark,{signal:controller.signal}),/已取消/);
 assert.ok(total<=100);assert.equal(paced.events.filter(e=>e[0]==='click').length,0);await paced.worker.closeAll();
});

test('production access policy persists restrictions and blocks prepare without navigation', async () => {
 const policy=await server('access-policy.mjs');
 const {worker,events}=workerFor({noteCount:2,challengeAt:1,workerOptions:{assertAccess:policy.assertBrowserAccess,lockAccess:policy.lockBrowserAccess}});
 await worker.prepare(account);await worker.verify(account,benchmark);
 assert.equal(policy.browserAccessStatus(account.id).kind,'restriction');const before=events.length;
 await assert.rejects(worker.prepare(account),/锁定/);assert.equal(events.length,before);
 await worker.closeAll();policy.resolveBrowserRestriction(account.id,true);
});

test('long capture errors cannot truncate a later restriction before persistent locking', async () => {
 const policy=await server('access-policy.mjs');
 const {worker}=workerFor({noteCount:3,challengeAt:3,workerOptions:{assertAccess:policy.assertBrowserAccess,lockAccess:policy.lockBrowserAccess,recognize:async()=>{throw new Error('x'.repeat(300));}}});
 await worker.prepare(account);
 const page=worker.instances.get(account.id).page;const locator=page.locator.bind(page);
 page.locator=selector=>{const loc=locator(selector);if(selector.includes('avatar'))loc.count=async()=>0;if(selector.includes('note-detail'))loc.screenshot=async()=>{throw new Error('y'.repeat(200));};return loc;};
 await worker.verify(account,benchmark);
 assert.equal(policy.browserAccessStatus(account.id).kind,'restriction');
 assert.equal(worker.instances.get(account.id).proof,undefined);
 await worker.closeAll();policy.resolveBrowserRestriction(account.id,true);
});

test('return error restriction is classified before its displayed error is shortened', async () => {
 const policy=await server('access-policy.mjs');
 const {worker}=workerFor({noteCount:1,workerOptions:{assertAccess:policy.assertBrowserAccess,lockAccess:policy.lockBrowserAccess}});
 await worker.prepare(account);worker.instances.get(account.id).page.goBack=async()=>{throw new Error('x'.repeat(200)+'安全验证');};
 const result=await worker.verify(account,benchmark);assert.equal(result.captured,1);
 assert.equal(policy.browserAccessStatus(account.id).kind,'restriction');assert.equal(worker.instances.get(account.id).proof,undefined);
 await worker.closeAll();policy.resolveBrowserRestriction(account.id,true);
});
