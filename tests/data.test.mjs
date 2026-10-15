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

test('初始化：知识库模板按 manifest 复制成中文路径', () => {
  const { docs, folders } = store.listKnowledge();
  assert.ok(docs.some((d) => d.path === '账号定位/账号定位模板.md'));
  assert.ok(folders.includes('爆款方法论'));
  assert.ok(fs.existsSync(path.join(WS, 'accounts', ACC, 'notes')));
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
  assert.ok(store.listTrash().some((e) => e.label.includes('对标拆解资料')));
});

test('账号不存在时拒绝访问', () => {
  assert.throws(() => content.listNotes('nope'), /账号不存在/);
});
