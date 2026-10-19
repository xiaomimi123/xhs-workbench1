// 数据层：初始化、知识库、回收站与恢复、笔记配图、选题、对标
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempWorkspace, server, PNG_1PX } from './helpers.mjs';

const WS = useTempWorkspace();
const store = await server('store.mjs');
const content = await server('content.mjs');
store.ensureWorkspace();
const ACC = 'default';
const mats = await server('materials.mjs');

test('初始化：知识库模板按 manifest 复制成中文路径', () => {
  const { docs, folders } = store.listKnowledge();
  assert.ok(docs.some((d) => d.path === '账号定位/账号定位模板.md'));
  assert.ok(folders.includes('爆款方法论'));
  assert.ok(fs.existsSync(path.join(WS, 'accounts', ACC, 'notes')));
  assert.ok(fs.existsSync(path.join(WS, 'accounts', ACC, 'benchmarks', 'checkpoints', 'pending')));
});

test('知识库读写、路径越界防护', () => {
  store.writeKnowledge('测试/新文档.md', '---\ntitle: 新文档\ntags: [a, b]\n---\n\n# 新文档\n正文');
  const d = store.readKnowledge('测试/新文档.md');
  assert.equal(d.title, '新文档');
  assert.deepEqual(d.tags, ['a', 'b']);
  assert.throws(() => store.readKnowledge('../config/accounts.json'), /只支持 \.md|路径不合法/);
  assert.throws(() => store.readKnowledge('../../etc/passwd.md'), /路径不合法/);
});

test('回收站：删除文档后可恢复到原位置，同名时加后缀', () => {
  store.trashKnowledge('测试/新文档.md');
  assert.throws(() => store.readKnowledge('测试/新文档.md'), /不存在/);
  const entry = store.listTrash().find((e) => e.label.includes('新文档'));
  assert.ok(entry && entry.restorable);
  store.writeKnowledge('测试/新文档.md', '占位'); // 原位置被占用
  const r = store.restoreTrash(entry.id);
  assert.equal(r.restoredTo, '测试/新文档-恢复.md'.replace(/^/, 'knowledge/'));
  assert.ok(!store.listTrash().some((e) => e.id === entry.id));
});

test('回收站：列表条目（选题）删除后可恢复', () => {
  const t = content.saveTopic(ACC, { title: '要删除的选题' });
  content.deleteTopic(ACC, t.id);
  assert.ok(!content.listTopics(ACC).some((x) => x.id === t.id));
  const entry = store.listTrash().find((e) => e.label === '选题：要删除的选题');
  store.restoreTrash(entry.id);
  assert.ok(content.listTopics(ACC).some((x) => x.title === '要删除的选题'));
});

test('从选题创建笔记会回写选题状态', () => {
  const t = content.saveTopic(ACC, { title: '选题 A' });
  const n = content.saveNote(ACC, { create: true, title: '笔记 A', topicId: t.id });
  const t2 = content.listTopics(ACC).find((x) => x.id === t.id);
  assert.equal(t2.status, 'writing');
  assert.equal(t2.noteId, n.id);
  assert.throws(() => content.saveNote(ACC, { id: 'n_不存在' }), /id 不合法|不存在/);
});

test('配图：大写扩展名、实况图自动配对、排序、裁剪、删除、打包', () => {
  const n = content.saveNote(ACC, { create: true, title: '配图笔记' });
  const up = (name, buf) => content.uploadNoteImage(ACC, n.id, name, buf.toString('base64'));
  assert.equal(up('a.png', PNG_1PX), 'a.png');
  assert.equal(up('IMG_1.HEIC', Buffer.from('h')), 'IMG_1.heic');
  up('IMG_1.MOV', Buffer.from('m'));
  up('b.png', PNG_1PX);
  assert.throws(() => up('x.exe', Buffer.from('x')), /只支持/);

  let d = content.noteDetail(ACC, n.id);
  assert.deepEqual(d.media[0], { file: 'IMG_1.heic', video: 'IMG_1.mov' });
  assert.deepEqual(d.looseVideos, []);

  d = content.saveMedia(ACC, n.id, [{ file: 'b.png' }, { file: 'a.png' }, { file: 'IMG_1.heic', video: 'IMG_1.mov' }]);
  assert.deepEqual(d.media.map((m) => m.file), ['b.png', 'a.png', 'IMG_1.heic']);

  assert.throws(() => content.cropMedia(ACC, n.id, 'IMG_1.heic', PNG_1PX.toString('base64')), /不支持裁剪/);
  d = content.cropMedia(ACC, n.id, 'b.png', PNG_1PX.toString('base64'));
  assert.equal(d.media[0].file, 'b-crop.jpg');
  assert.ok(store.listTrash().some((e) => e.label.includes('裁剪前的原图')));

  d = content.deleteMedia(ACC, n.id, 'IMG_1.heic');
  assert.deepEqual(d.media.map((m) => m.file), ['b-crop.jpg', 'a.png']);
  assert.ok(!fs.existsSync(path.join(WS, 'accounts', ACC, 'notes', n.id, 'images', 'IMG_1.mov')));

  const { entries } = content.noteBundle(ACC, n.id);
  assert.deepEqual(entries.map((e) => e.name), ['01.jpg', '02.png', '文案.txt']);
});

test('对标账号：保存、详情、删除连同资料进回收站', () => {
  const b = content.saveBenchmark(ACC, { name: '对标号' });
  assert.equal(content.benchmarkDetail(ACC, b.id).item.status, 'pending');
  content.deleteBenchmark(ACC, b.id);
  assert.equal(content.listBenchmarks(ACC).length, 0);
  assert.throws(() => content.saveBenchmark(ACC, { id: b.id, tracking: true }), /不存在/);
  assert.ok(store.listTrash().some((e) => e.label.includes('对标拆解资料')));
});

test('素材库：上传、登记、编辑、批注进提示词摘要、删除进回收站', () => {
  const materials = mats;
  const name = materials.uploadMaterial('hook-cut.mp4', Buffer.from('fake-video').toString('base64'));
  assert.equal(name, 'hook-cut.mp4');
  const m = materials.saveMaterial({ title: '开头 3 秒钩子范本', file: name, tags: '开头钩子, 实拍', note: '直接给结果不给过程', source: '@某账号' });
  assert.equal(m.type, 'video');
  assert.deepEqual(m.tags, ['开头钩子', '实拍']);
  assert.ok(materials.listMaterials().some((x) => x.id === m.id));
  // 编辑：type 不传时保持原值
  const edited = materials.saveMaterial({ id: m.id, title: '改标题', note: '新批注' });
  assert.equal(edited.title, '改标题');
  assert.equal(edited.type, 'video');
  assert.ok(materials.materialsSummary().includes('新批注'));
  // 文件没了自动清条目
  fs.rmSync(path.join(WS, 'accounts', ACC, 'materials', 'files', name));
  assert.equal(materials.listMaterials().length, 0);
  assert.throws(() => materials.deleteMaterial(m.id), /不存在/); // 条目已被自动清掉
  // 非法扩展名拒绝
  assert.throws(() => materials.uploadMaterial('x.exe', Buffer.from('x').toString('base64')), /只支持/);
});

test('对标追踪：tracking 字段、agent 回写、seen 清零', () => {
  const b = content.saveBenchmark(ACC, { name: '追踪号', tracking: true });
  assert.equal(content.listBenchmarks(ACC).find((x) => x.id === b.id).tracking, true);
  // agent 追踪检查后回写 newCount / radarNote / lastCheckedAt
  content.saveBenchmark(ACC, { id: b.id, newCount: 2, radarNote: '《标题》点赞 1.5万', lastCheckedAt: '2026-10-15T10:00:00.000Z' });
  const seen = content.markBenchmarkSeen(ACC, b.id);
  assert.equal(seen.newCount, 0);
  assert.equal(seen.radarNote, undefined);
  assert.equal(seen.lastCheckedAt, '2026-10-15T10:00:00.000Z'); // 检查时间保留
  assert.equal(seen.tracking, true);
  assert.throws(() => content.markBenchmarkSeen(ACC, 'b_nope'), /不存在/);
});

test('视频笔记：设置视频与封面、配图停用、打包、删除进回收站', () => {
  const n = content.saveNote(ACC, { create: true, title: '视频笔记' });
  content.uploadNoteImage(ACC, n.id, 'demo.mp4', Buffer.from('vv').toString('base64'));
  content.uploadNoteImage(ACC, n.id, '封面.jpg', PNG_1PX.toString('base64'));
  assert.deepEqual(content.noteDetail(ACC, n.id).looseVideos, ['demo.mp4']); // 未设置时是未配对视频

  assert.throws(() => content.setNoteVideo(ACC, n.id, { file: 'nope.mp4' }), /视频文件不存在/);
  assert.throws(() => content.setNoteVideo(ACC, n.id, { file: 'demo.mp4', cover: 'nope.png' }), /封面文件不存在/);
  let d = content.setNoteVideo(ACC, n.id, { file: 'demo.mp4' });
  assert.equal(d.video.file, 'demo.mp4');
  assert.deepEqual(d.media, []); // 视频笔记配图停用
  assert.deepEqual(d.looseVideos, []); // 也不再显示为未配对
  d = content.setNoteVideo(ACC, n.id, { cover: '封面.jpg' });
  assert.equal(d.video.cover, '封面.jpg');

  const { entries } = content.noteBundle(ACC, n.id);
  assert.deepEqual(entries.map((e) => e.name), ['01-封面.jpg', '02-视频.mp4', '文案.txt']);

  d = content.deleteNoteVideoFile(ACC, n.id, '封面.jpg');
  assert.equal(d.video.cover, undefined);
  assert.ok(store.listTrash().some((e) => e.label.includes('视频笔记素材')));
  assert.throws(() => content.deleteNoteVideoFile(ACC, n.id, '封面.jpg'), /不属于/);

  d = content.deleteNoteVideoFile(ACC, n.id, 'demo.mp4');
  assert.equal(d.video, null); // 视频删掉后转回图文
});

test('视频脚本：保存、读取、打包带上', () => {
  const n = content.saveNote(ACC, { create: true, title: '脚本笔记' });
  content.saveVideoScript(ACC, n.id, '# 分镜表\n| 1 | 开场 | 「你好」 | 3s |');
  assert.ok(content.noteDetail(ACC, n.id).videoScript.includes('分镜表'));
  const { entries } = content.noteBundle(ACC, n.id);
  const script = entries.find((e) => e.name === '视频脚本.md');
  assert.ok(script && script.data.toString('utf8').includes('分镜表'));
  assert.throws(() => content.saveVideoScript(ACC, 'n_不存在', 'x'), /id 不合法|不存在/);
});

test('视频笔记：图文转视频再转回，配图顺序保留', () => {
  const n = content.saveNote(ACC, { create: true, title: '图文转视频' });
  content.uploadNoteImage(ACC, n.id, 'p1.png', PNG_1PX.toString('base64'));
  content.uploadNoteImage(ACC, n.id, 'v2.mp4', Buffer.from('x').toString('base64'));
  content.saveMedia(ACC, n.id, [{ file: 'p1.png' }]);
  let d = content.setNoteVideo(ACC, n.id, { file: 'v2.mp4' });
  assert.deepEqual(d.media, []);
  d = content.setNoteVideo(ACC, n.id, { file: '' }); // 切回图文
  assert.deepEqual(d.media.map((m) => m.file), ['p1.png']);
  assert.deepEqual(d.looseVideos, ['v2.mp4']); // 视频变成未配对，可做实况图
});

test('账号不存在时拒绝访问', () => {
  assert.throws(() => content.listNotes('nope'), /账号不存在/);
});

test('对标检查点：候选逐条落盘、已核实字段合并，重复回放不重复建号', () => {
  const dir = path.join(WS, 'accounts', ACC, 'benchmarks', 'checkpoints', 'pending');
  fs.mkdirSync(dir, { recursive: true });
  const write = (id, stage, fields) => fs.writeFileSync(path.join(dir, `${id}.${stage}.json`), JSON.stringify({ id, stage, ...fields }));
  const indexPath = path.join(WS, 'accounts', ACC, 'benchmarks', 'index.json');
  const previous = store.readJson(indexPath, { items: [] });
  store.writeJson(indexPath, { ...previous, customMarker: '保留顶层元数据' });
  write('b_checkpoint_a', 'candidate', { name: '待核实号', remark: '只知道候选方向' });
  let list = content.listBenchmarks(ACC);
  let item = list.find((b) => b.id === 'b_checkpoint_a');
  assert.equal(item.name, '待核实号');
  assert.equal(item.status, 'pending');
  assert.equal(item.verifiedAt, undefined);
  assert.equal(item.url, undefined);

  content.saveBenchmark(ACC, { id: item.id, remark: '用户改过备注', followers: '777', status: 'analyzed' });
  content.saveBenchmark(ACC, { id: item.id, tracking: true });
  write('b_checkpoint_a', 'verified', {
    url: 'https://www.xiaohongshu.com/user/profile/123abc', profileName: '主页昵称',
    followers: '1.2万', xhsId: 'demo123', observedAt: '2026-10-17T05:00:00.000Z',
  });
  item = content.listBenchmarks(ACC).find((b) => b.id === 'b_checkpoint_a');
  assert.equal(item.status, 'analyzed');
  assert.equal(item.remark, '用户改过备注');
  assert.equal(item.tracking, true);
  assert.equal(item.url, 'https://www.xiaohongshu.com/user/profile/123abc');
  assert.equal(item.profileName, '主页昵称');
  assert.equal(item.followers, '777'); // 手填粉丝数不能被核实检查点悄悄覆盖
  assert.equal(item.observedFollowers, '1.2万'); // 仍要保存页面实际看到的数值
  assert.equal(item.verifiedAt, '2026-10-17T05:00:00.000Z');
  assert.equal(store.readJson(indexPath, {}).customMarker, '保留顶层元数据');
  assert.equal(fs.readdirSync(dir).length, 0);

  write('b_checkpoint_a', 'candidate', { name: '待核实号' });
  list = content.listBenchmarks(ACC);
  assert.equal(list.filter((b) => b.id === 'b_checkpoint_a').length, 1);
});

test('对标检查点：未写完、身份冲突和删除后残留文件不污染列表', () => {
  const root = path.join(WS, 'accounts', ACC, 'benchmarks', 'checkpoints');
  const dir = path.join(root, 'pending');
  const bad = path.join(dir, 'b_incomplete.candidate.json');
  fs.writeFileSync(bad, '{"stage": "candidate",');
  assert.ok(!content.listBenchmarks(ACC).some((b) => b.id === 'b_incomplete'));
  assert.equal(content.benchmarkCheckpointIssues(ACC).incomplete, 1);
  fs.rmSync(bad);

  const conflict = { id: 'b_checkpoint_a', stage: 'verified', url: 'https://www.xiaohongshu.com/user/profile/other',
    profileName: '别的账号', observedAt: '2026-10-17T05:10:00.000Z' };
  fs.writeFileSync(path.join(dir, 'b_checkpoint_a.verified.json'), JSON.stringify(conflict));
  assert.equal(content.listBenchmarks(ACC).find((b) => b.id === conflict.id).url,
    'https://www.xiaohongshu.com/user/profile/123abc');
  assert.ok(content.benchmarkCheckpointIssues(ACC).rejected >= 1);
  assert.ok(fs.readdirSync(path.join(root, 'rejected')).some((f) => f.endsWith('.reason.txt')));
  fs.writeFileSync(path.join(dir, 'b_checkpoint_a.verified.json'), JSON.stringify({
    ...conflict, url: 'https://example.com/user/profile/other',
  }));
  content.listBenchmarks(ACC);
  assert.ok(content.benchmarkCheckpointIssues(ACC).rejected >= 2); // 不接受伪装成主页的其他域名

  content.deleteBenchmark(ACC, 'b_checkpoint_a');
  fs.writeFileSync(path.join(dir, 'b_checkpoint_a.candidate.json'), JSON.stringify({
    stage: 'candidate', id: 'b_checkpoint_a', name: '待核实号',
  }));
  assert.ok(!content.listBenchmarks(ACC).some((b) => b.id === 'b_checkpoint_a'));
  assert.ok(content.benchmarkCheckpointIssues(ACC).rejected >= 3);

  const trashed = store.listTrash().find((x) => x.kind === 'item' && x.label === '对标账号：待核实号');
  store.restoreTrash(trashed.id);
  fs.writeFileSync(path.join(dir, 'b_checkpoint_a.verified.json'), JSON.stringify({
    id: 'b_checkpoint_a', stage: 'verified', url: 'https://www.xiaohongshu.com/user/profile/123abc',
    profileName: '主页昵称', observedAt: '2026-10-17T05:00:00.000Z',
  }));
  assert.ok(content.listBenchmarks(ACC).find((b) => b.id === 'b_checkpoint_a').verifiedAt);
  assert.ok(!fs.existsSync(path.join(dir, 'b_checkpoint_a.verified.json')));
});

test('对标检查点：不同账号隔离，损坏的旧列表不能被空数据覆盖', () => {
  const other = store.saveAccount({ name: '测试账号 B' });
  const dir = path.join(WS, 'accounts', other.id, 'benchmarks', 'checkpoints', 'pending');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'b_isolated.candidate.json'), JSON.stringify({
    stage: 'candidate', id: 'b_isolated', name: '只属于 B',
  }));
  assert.ok(!content.listBenchmarks(ACC).some((b) => b.id === 'b_isolated'));
  assert.ok(content.listBenchmarks(other.id).some((b) => b.id === 'b_isolated'));
  const index = path.join(WS, 'accounts', other.id, 'benchmarks', 'index.json');
  const saved = fs.readFileSync(index, 'utf8');
  fs.writeFileSync(index, '{ incomplete');
  fs.writeFileSync(path.join(dir, 'b_should_wait.candidate.json'), JSON.stringify({
    stage: 'candidate', id: 'b_should_wait', name: '不应覆盖',
  }));
  assert.equal(content.reconcileBenchmarkCheckpoints(other.id).candidates, 0);
  assert.equal(fs.readFileSync(index, 'utf8'), '{ incomplete');
  assert.throws(() => content.listBenchmarks(other.id), /无法读取/);
  fs.writeFileSync(index, saved);
  assert.ok(content.listBenchmarks(other.id).some((b) => b.id === 'b_should_wait'));
});
