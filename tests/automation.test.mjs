// 运营自动化：排期校验、调度器、提醒、防休眠判断、备份恢复、按账号隔离的浏览器配置
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempWorkspace, server } from './helpers.mjs';

const WS = useTempWorkspace();
const store = await server('store.mjs');
const content = await server('content.mjs');
const ops = await server('automation.mjs');
const backup = await server('backup.mjs');
const browser = await server('browser.mjs');
const system = await server('system.mjs');
store.ensureWorkspace();
const ACC = 'default';
const inMin = (m) => new Date(Date.now() + m * 60_000).toISOString();
const note = (title) => content.saveNote(ACC, { create: true, title });

test('排期校验：过去时间、间隔、每日上限、重复排期', () => {
  const a = note('A');
  const b = note('B');
  assert.throws(() => ops.scheduleNote(ACC, { noteId: a.id, publishAt: inMin(-30) }), /不能早于现在/);
  ops.scheduleNote(ACC, { noteId: a.id, publishAt: inMin(120), mode: 'remind' });
  assert.throws(() => ops.scheduleNote(ACC, { noteId: a.id, publishAt: inMin(500) }), /已经在排期中/);
  assert.throws(() => ops.scheduleNote(ACC, { noteId: b.id, publishAt: inMin(150) }), /间隔不足 60 分钟/);
  ops.saveAutomation(ACC, { publish: { minIntervalMin: 0, dailyLimit: 1 } });
  assert.throws(() => ops.scheduleNote(ACC, { noteId: b.id, publishAt: inMin(121) }), /每日上限/);
  ops.saveAutomation(ACC, { publish: { minIntervalMin: 0, dailyLimit: 10 } });
  assert.equal(content.noteDetail(ACC, a.id).status, 'ready'); // 排期后草稿变为待发布
});

test('调度器：到点提醒、自动发布交给 agent、错过不补发、agent 未回写时待确认', () => {
  ops.saveAutomation(ACC, { curator: { everyHours: 0 } }); // 只测发布
  for (const s of ops.listSchedule(ACC)) ops.deleteSchedule(ACC, s.id);
  const r = note('提醒'), au = note('自动'), miss = note('错过');
  const sr = ops.scheduleNote(ACC, { noteId: r.id, publishAt: inMin(60), mode: 'remind' });
  const sa = ops.scheduleNote(ACC, { noteId: au.id, publishAt: inMin(60), mode: 'auto' });
  const sm = ops.scheduleNote(ACC, { noteId: miss.id, publishAt: inMin(60), mode: 'auto' });
  // 改成已经到点 / 早已过点
  const file = path.join(WS, 'accounts', ACC, 'schedule.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const s of data.items) s.publishAt = s.id === sm.id ? inMin(-180) : inMin(-1);
  fs.writeFileSync(file, JSON.stringify(data));

  const tasks = [];
  const events = [];
  const sch = new ops.Scheduler({ runTask: (acc, text) => (tasks.push(text), `task-${tasks.length}`), notify: (e) => events.push(e), log: () => {} });
  sch.tick();
  const st = Object.fromEntries(ops.listSchedule(ACC).map((s) => [s.id, s]));
  assert.equal(st[sr.id].status, 'due');
  assert.equal(st[sa.id].status, 'running');
  assert.equal(st[sm.id].status, 'missed');
  assert.equal(tasks.length, 1);
  assert.match(tasks[0], /自动任务 · 定时发布/);
  assert.ok(events.some((e) => e.urgent));

  sch.onTaskFinished(st[sa.id].taskId, true);
  assert.equal(ops.listSchedule(ACC).find((s) => s.id === sa.id).status, 'check');

  const kinds = ops.alerts().map((a) => a.status);
  assert.ok(kinds.includes('due') && kinds.includes('missed') && kinds.includes('check'));
});

test('调度器：会话忙时下次再试', () => {
  for (const s of ops.listSchedule(ACC)) ops.deleteSchedule(ACC, s.id);
  const n = note('忙');
  const s = ops.scheduleNote(ACC, { noteId: n.id, publishAt: inMin(1), mode: 'auto' });
  ops.updateSchedule(ACC, { id: s.id, publishAt: inMin(-1) });
  const sch = new ops.Scheduler({ runTask: () => null, notify: () => {}, log: () => {} });
  sch.tick();
  assert.equal(ops.listSchedule(ACC).find((x) => x.id === s.id).status, 'scheduled');
});

test('防休眠「自动」模式的判断', () => {
  ops.saveAutomation(ACC, { curator: { everyHours: 0 } }); // 管家单独测
  for (const s of ops.listSchedule(ACC)) ops.deleteSchedule(ACC, s.id);
  assert.equal(ops.needsAwake(), false);
  ops.scheduleNote(ACC, { noteId: note('近期').id, publishAt: inMin(90) });
  assert.equal(ops.needsAwake(), true);
});

test('知识库管家：到点派任务、间隔内不重复、防休眠覆盖', () => {
  ops.saveAutomation(ACC, { radar: { everyHours: 0 } });
  for (const s of ops.listSchedule(ACC)) ops.deleteSchedule(ACC, s.id);
  const tasks = [];
  const sch = new ops.Scheduler({ runTask: (acc, text) => (tasks.push(text), `task-${tasks.length}`), notify: () => {}, log: () => {} });
  ops.saveAutomation(ACC, { curator: { everyHours: 24 } });
  sch.tick();
  assert.equal(tasks.length, 1);
  assert.match(tasks[0], /知识库管家/);
  assert.ok(ops.getAutomation(ACC).lastRuns.curator);
  sch.tick();
  assert.equal(tasks.length, 1); // 间隔内不重复
  ops.saveAutomation(ACC, { curator: { everyHours: 0 }, lastRuns: { curator: new Date(Date.now() - 48 * 3600_000).toISOString() } });
  sch.tick();
  assert.equal(tasks.length, 1);
  ops.saveAutomation(ACC, { curator: { everyHours: 24 }, lastRuns: { curator: new Date(Date.now() - 48 * 3600_000).toISOString() } });
  assert.equal(ops.needsAwake(), true); // 管家开启时防休眠也保持唤醒
});

test('自动化设置的取值校验', () => {
  assert.throws(() => ops.saveAutomation(ACC, { analytics: { dailyAt: '9点' } }), /HH:MM/);
  const c = ops.saveAutomation(ACC, { publish: { dailyLimit: 999, defaultMode: 'x' } });
  assert.equal(c.publish.dailyLimit, 20);
  assert.equal(c.publish.defaultMode, 'remind');
  const r = ops.saveAutomation(ACC, { radar: { everyHours: 9999, likesThreshold: 0 } });
  assert.equal(r.radar.everyHours, 168);
  assert.equal(r.radar.likesThreshold, 1000);
  const cu = ops.saveAutomation(ACC, { curator: { everyHours: 9999 } });
  assert.equal(cu.curator.everyHours, 168);
});

test('Windows 自启动：VBS 的 cmd 引号与转义', () => {
  const vbs = system.autostartContent('win32');
  // cmd /c 的整条命令最外层必须是成对引号（cmd 会剥掉首尾一对），
  // 否则引号超过两个时 cmd 把首尾引号剥掉，带空格的路径（Program Files）会断开
  assert.ok(vbs.includes('sh.Run "cmd /c ""'), 'cmd /c 外层应使用成对引号');
  assert.ok(vbs.includes('2>&1""", 0, False'), '重定向后以 VBS 的双引号转义收尾');
  assert.match(vbs, /XHS_WORKSPACE/);
  assert.match(vbs, /Set sh = CreateObject\("WScript\.Shell"\)/);
  // darwin / linux 分支不受影响
  assert.match(system.autostartContent('darwin'), /<plist/);
  assert.match(system.autostartContent('linux'), /WantedBy=default\.target/);
});

test('爆款雷达：到点派任务、提醒、关闭后不再派', () => {
  ops.saveAutomation(ACC, { curator: { everyHours: 0 } }); // 只测雷达
  for (const s of ops.listSchedule(ACC)) ops.deleteSchedule(ACC, s.id);
  const b = content.saveBenchmark(ACC, { name: '雷达号', tracking: true });
  ops.saveAutomation(ACC, { radar: { everyHours: 24 } });

  const tasks = [];
  const sch = new ops.Scheduler({ runTask: (acc, text) => (tasks.push(text), `task-${tasks.length}`), notify: () => {}, log: () => {} });
  sch.tick();
  assert.equal(tasks.length, 1);
  assert.match(tasks[0], /对标追踪/);
  assert.ok(ops.getAutomation(ACC).lastRuns.radar);
  sch.tick(); // 间隔内不重复派
  assert.equal(tasks.length, 1);

  // 没有新笔记时没有雷达提醒；agent 回写后提醒出现
  assert.ok(!ops.alerts().some((a) => a.kind === 'radar'));
  content.saveBenchmark(ACC, { id: b.id, newCount: 3, radarNote: '《爆了》点赞 1.2万' });
  const radar = ops.alerts().find((a) => a.kind === 'radar');
  assert.ok(radar && radar.title === '雷达号' && radar.text.includes('爆了'));

  // 没有追踪中的对标时不派任务
  content.saveBenchmark(ACC, { id: b.id, tracking: false, newCount: 0 });
  ops.saveAutomation(ACC, { lastRuns: { radar: new Date(Date.now() - 48 * 3600_000).toISOString() } });
  tasks.length = 0;
  sch.tick();
  assert.equal(tasks.length, 0);

  // 关闭追踪后不派任务；有追踪时防休眠「自动」模式覆盖雷达
  ops.saveAutomation(ACC, { radar: { everyHours: 0 } });
  content.saveBenchmark(ACC, { id: b.id, tracking: true });
  tasks.length = 0;
  sch.tick();
  assert.equal(tasks.length, 0);
  assert.equal(ops.needsAwake(), false);
  ops.saveAutomation(ACC, { radar: { everyHours: 24 } });
  assert.equal(ops.needsAwake(), true);
});

test('备份与恢复：恢复前数据进回收站，本机连接配置保留', () => {
  store.saveBridgeConfig({ mode: 'cli', adapter: { id: 'this-machine' } });
  store.writeKnowledge('备份测试.md', '原始内容');
  const b = backup.createBackup();
  assert.ok(b.files > 5);

  store.writeKnowledge('备份测试.md', '改坏了');
  store.writeKnowledge('备份后新增.md', 'x');
  store.saveBridgeConfig({ mode: 'cli', adapter: { id: 'still-this-machine' } });

  const r = backup.restoreBackup(b.name);
  assert.ok(r.restored > 5);
  assert.equal(store.readKnowledge('备份测试.md').content, '原始内容');
  assert.throws(() => store.readKnowledge('备份后新增.md'), /不存在/);
  assert.equal(store.getBridgeConfig().adapter.id, 'still-this-machine');
  assert.ok(store.listTrash().some((e) => e.group === 'restore'));
  assert.throws(() => backup.backupFile('../x.zip'), /不合法/);
});

test('自动备份：一天一次', () => {
  assert.ok(backup.autoBackupIfDue());
  assert.equal(backup.autoBackupIfDue(), null);
});

test('浏览器：每个账号一份资料，旧版单一资料迁移到默认账号', () => {
  fs.mkdirSync(path.join(WS, 'browser-profile'));
  fs.writeFileSync(path.join(WS, 'browser-profile', 'Cookies'), 'x');
  const f1 = browser.mcpConfigFor('default', '@playwright/mcp@0.0.1');
  const f2 = browser.mcpConfigFor('acc_2', '@playwright/mcp@0.0.1');
  assert.notEqual(f1, f2);
  const args = JSON.parse(fs.readFileSync(f2, 'utf8')).mcpServers.playwright.args;
  assert.ok(args.includes(path.join(WS, 'browser-profiles', 'acc_2')));
  assert.ok(fs.existsSync(path.join(WS, 'browser-profiles', 'default', 'Cookies')));
  assert.ok(!fs.existsSync(path.join(WS, 'browser-profile')));
  assert.throws(() => browser.mcpConfigFor('default', ''), /不完整/);
});

test('浏览器：无头模式写入 MCP 配置', () => {
  const fh = browser.mcpConfigFor('default', '@playwright/mcp@0.0.1', true);
  const args = JSON.parse(fs.readFileSync(fh, 'utf8')).mcpServers.playwright.args;
  assert.ok(args.includes('--headless'));
  const f2 = browser.mcpConfigFor('default', '@playwright/mcp@0.0.1', false);
  const args2 = JSON.parse(fs.readFileSync(f2, 'utf8')).mcpServers.playwright.args;
  assert.ok(!args2.includes('--headless')); // 关掉后配置同步移除
});

test('浏览器：开启 / 切换 / 关闭浏览器控制参数', () => {
  const base = { id: 'claude-code', args: ['-p', '--allowedTools', 'WebSearch,WebFetch', '--add-dir', '{skillDir}'] };
  const pw = browser.applyBrowser(base, 'playwright', '@playwright/mcp@1.0.0');
  assert.deepEqual(pw.args.slice(-2), ['--mcp-config', '{mcpConfig}']);
  assert.equal(pw.args[pw.args.indexOf('--allowedTools') + 1], 'WebSearch,WebFetch,mcp__playwright');
  assert.equal(pw.playwrightMcp, '@playwright/mcp@1.0.0');
  const ch = browser.applyBrowser(pw, 'chrome');
  assert.ok(ch.args.includes('--chrome') && !ch.args.includes('--mcp-config'));
  assert.equal(ch.playwrightMcp, undefined);
  const off = browser.applyBrowser(ch, null);
  assert.equal(off.args[off.args.indexOf('--allowedTools') + 1], 'WebSearch,WebFetch');
  assert.deepEqual(base.args, ['-p', '--allowedTools', 'WebSearch,WebFetch', '--add-dir', '{skillDir}']); // 不修改原对象
});
