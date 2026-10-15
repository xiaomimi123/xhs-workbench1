// 纯函数：Markdown 渲染、违禁词检查、封面规格、数字换算、检索、ZIP
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTempWorkspace, server, web } from './helpers.mjs';

useTempWorkspace();
const { md, esc } = await web('md.js');
const { lint, countChars } = await web('lint.js');
const { normalizeSpec } = await web('covers.js');
const { num } = await web('modules/analytics.js');
const { tokenize, queryTokens, search } = await server('search.mjs');
const { createZip, readZip, crc32 } = await server('zip.mjs');

test('Markdown：转义 HTML、嵌套列表、有序列表起始编号、表格、代码块', () => {
  assert.equal(esc('<b>&"'), '&lt;b&gt;&amp;&quot;');
  assert.match(md('<script>x</script>'), /&lt;script&gt;/);
  assert.equal(md('1. a\n   - x\n\n2. b'), '<ol><li>a<ul><li>x</li></ul></li><li>b</li></ol>');
  assert.match(md('3. c'), /<ol start="3">/);
  assert.match(md('| a | b |\n|---|---|\n| 1 | 2 |'), /<table><thead><tr><th>a<\/th>/);
  assert.match(md('```\n<b>\n```'), /<pre><code>&lt;b&gt;<\/code><\/pre>/);
  assert.match(md('[链接](https://x.com) [坏](javascript:alert(1))'), /href="https:\/\/x.com"/);
  assert.doesNotMatch(md('[坏](javascript:alert(1))'), /href="javascript/);
});

test('违禁词与字数检查', () => {
  assert.equal(countChars('标题😀'), 3);
  const r = lint({ title: '全网最好用的方法'.repeat(3), body: '加微信领取', tags: [] });
  assert.ok(r.issues.some((i) => i.category === '字数' && i.where === '标题'));
  assert.ok(r.issues.some((i) => i.word === '全网最'));
  assert.ok(r.issues.some((i) => i.word === '微信' && i.level === 'warn'));
  assert.equal(lint({ title: '一周减脂便当', body: '正常内容', tags: ['减脂'] }).issues.length, 0);
});

test('封面规格容错', () => {
  const s = normalizeSpec({ template: '不存在', palette: 'x', items: 'a\nb', emphasis: '甲，乙' });
  assert.equal(s.template, 'bigtext');
  assert.equal(s.palette, 'red');
  assert.deepEqual(s.items, ['a', 'b']);
  assert.deepEqual(s.emphasis, ['甲', '乙']);
});

test('数据换算：万 / k / 千分位', () => {
  assert.equal(num('1.2万'), 12000);
  assert.equal(num('3,450'), 3450);
  assert.equal(num('2k'), 2000);
  assert.equal(num(''), 0);
  assert.equal(num(88), 88);
});

test('检索：中文二字切分、去掉疑问词、相关文档排在前面', () => {
  assert.deepEqual(tokenize('写标题abc'), ['写标', '标题', 'abc']);
  assert.deepEqual(queryTokens('怎么写标题'), ['写标', '标题']);
  const docs = [
    { id: 'a', title: '评论区回复口径', tags: ['评论'], body: '用户问价格时……' },
    { id: 'b', title: '标题公式合集', tags: ['标题'], body: '## 标题\n数字 + 结果的标题点击率更高' },
    { id: 'c', title: '封面配色', tags: [], body: '封面用奶油色' },
  ];
  const r = search(docs, '怎么写标题');
  assert.equal(r[0].id, 'b');
  assert.ok(!r.some((x) => x.id === 'c'));
  assert.match(r[0].snippet, /\u0001标题\u0002/);
  assert.deepEqual(search(docs, '   '), []);
});

test('ZIP：中文文件名往返、校验和', () => {
  const entries = [
    { name: '知识库/说明.md', data: Buffer.from('你好'.repeat(200)) },
    { name: 'a.png', data: Buffer.from([1, 2, 3]) },
  ];
  const back = readZip(createZip(entries));
  assert.deepEqual(back.map((e) => e.name), ['知识库/说明.md', 'a.png']);
  assert.equal(back[0].data.toString(), '你好'.repeat(200));
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.throws(() => readZip(Buffer.from('not a zip at all, definitely not')), /不是有效的 ZIP/);
});
