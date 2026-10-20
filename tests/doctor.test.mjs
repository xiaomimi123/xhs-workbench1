// 环境自检：缺依赖时给出确定的安装命令；常见目录兜底查找；不修改用户环境
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { server } from './helpers.mjs';

const { runDoctor, formatDoctor, detectPackageManagers } = await server('doctor.mjs');
const { findBinary, commonBinDirs } = await server('binaries.mjs');

const base = { workspace: '/ws', writable: () => true, detectCli: () => [], detectDesktop: () => [], bridgeConfig: null };
const find = (present) => (name) => (present.includes(name) ? `/bin/${name}` : null);

test('一切就绪时 RESULT: ok', () => {
  const r = runDoctor({ ...base, platform: 'darwin', find: find(['ffmpeg', 'ffprobe', 'brew']), bridgeConfig: { mode: 'cli', adapter: { id: 'claude-code', name: 'Claude Code' } } });
  assert.equal(r.ready, true);
  assert.deepEqual(r.recommendedMissing, []);
  assert.match(formatDoctor(r), /RESULT: ok$/);
});

test('Node 过旧属于 required，给出 winget 命令且 blocked', () => {
  const r = runDoctor({ ...base, platform: 'win32', nodeVersion: '16.20.0', find: find(['winget']) });
  assert.equal(r.ready, false);
  assert.deepEqual(r.requiredMissing, ['node']);
  assert.equal(r.checks.find((c) => c.id === 'node').fix.command, 'winget install OpenJS.NodeJS.LTS');
  assert.match(formatDoctor(r), /RESULT: blocked node/);
});

test('缺 ffmpeg：按平台和包管理器给不同命令，没有包管理器时给手动步骤并要求先告知来源大小', () => {
  const fix = (platform, present) => runDoctor({ ...base, platform, find: find(present) }).checks.find((c) => c.id === 'ffmpeg').fix;
  assert.equal(fix('darwin', ['brew']).command, 'brew install ffmpeg');
  assert.match(fix('darwin', []).manual, /brew\.sh/);
  assert.equal(fix('win32', ['winget']).command, 'winget install Gyan.FFmpeg');
  assert.equal(fix('win32', ['choco']).command, 'choco install ffmpeg -y');
  assert.match(fix('win32', []).manual, /gyan\.dev[\s\S]*告诉用户/);
  const r = runDoctor({ ...base, platform: 'win32', find: find([]) });
  assert.deepEqual(r.recommendedMissing.filter((x) => x.startsWith('ff')), ['ffmpeg', 'ffprobe']);
  assert.equal(r.ready, true); // 视频依赖不阻塞启动
});

test('数据目录不可写属于 required', () => {
  const r = runDoctor({ ...base, platform: 'darwin', find: find(['ffmpeg', 'ffprobe']), writable: () => false });
  assert.deepEqual(r.requiredMissing, ['workspace']);
  assert.match(r.checks.find((c) => c.id === 'workspace').fix.manual, /XHS_WORKSPACE/);
});

test('未配置 agent：列出本机检测到的，多个时提醒必须问用户', () => {
  const r = runDoctor({ ...base, platform: 'win32', find: find(['ffmpeg', 'ffprobe']), detectCli: () => [{ id: 'claude-code', name: 'Claude Code' }], detectDesktop: () => [{ id: 'workbuddy', name: 'WorkBuddy' }] });
  const agent = r.checks.find((c) => c.id === 'agent');
  assert.equal(agent.ok, false);
  assert.match(agent.detail, /Claude Code、WorkBuddy/);
  assert.match(agent.fix.note, /必须先问用户|先问用户/);
  assert.match(formatDoctor(r), /RESULT: action-needed agent/);
});

test('非 macOS 提示平台限制，macOS 不显示', () => {
  const has = (platform) => runDoctor({ ...base, platform, find: find(['ffmpeg', 'ffprobe']) }).checks.some((c) => c.id === 'platform-features');
  assert.equal(has('win32'), true);
  assert.equal(has('darwin'), false);
});

test('findBinary：PATH 找不到时去常见目录兜底（Windows 的 winget / 用户目录 ffmpeg 解压位）', () => {
  const home = path.join(path.sep, 'home', 'u');
  const bin = path.join(home, 'ffmpeg', 'ffmpeg-9-essentials_build', 'bin', 'ffmpeg.exe');
  const opts = { platform: 'win32', home, env: { LOCALAPPDATA: path.join(home, 'AppData', 'Local') }, run: () => ({ status: 1, stdout: '' }),
    exists: (p) => p === bin || p === path.join(home, 'ffmpeg'), list: () => ['ffmpeg-9-essentials_build'] };
  assert.equal(findBinary('ffmpeg', opts), bin);
  assert.equal(findBinary('ffprobe', opts), null);
  assert.ok(commonBinDirs(opts).some((d) => d.endsWith(path.join('WinGet', 'Links'))));
  // PATH 命中优先
  assert.equal(findBinary('node', { ...opts, run: () => ({ status: 0, stdout: '/found/node.exe\r\n/other/node.exe\r\n' }) }), '/found/node.exe');
});

test('detectPackageManagers 按平台只看对应的管理器', () => {
  assert.deepEqual(detectPackageManagers(find(['winget', 'brew']), 'win32'), ['winget']);
  assert.deepEqual(detectPackageManagers(find(['winget', 'brew']), 'darwin'), ['brew']);
});

test('Windows 路径文本里的反斜杠没有被当成转义（不能出现换页符/退格符）', () => {
  const bs = String.fromCharCode(92);
  const r = runDoctor({ ...base, platform: 'win32', find: find([]) });
  const manual = r.checks.find((c) => c.id === 'ffmpeg').fix.manual;
  assert.ok(manual.includes(`%USERPROFILE%${bs}ffmpeg`), manual);
  assert.doesNotMatch(manual, /[\x08\x0c\x0b]/);
  const dirs = commonBinDirs({ platform: 'win32', env: {}, home: 'H', exists: () => false });
  assert.ok(dirs.includes(`C:${bs}ffmpeg${bs}bin`), dirs.join('|'));
  for (const d of dirs) assert.doesNotMatch(d, /[\x08\x0c\x0b]/);
});
