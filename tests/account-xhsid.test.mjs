// 一键填入小红书号走的是 POST /api/accounts 的「只带 id 和 xhsId」更新：只改这一个字段，不动名称、定位等
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTempWorkspace, server } from './helpers.mjs';

useTempWorkspace();
const store = await server('store.mjs');

test('只带 id 和 xhsId 的更新只改小红书号，其余字段保持', () => {
  const acc = store.saveAccount({ name: '我的账号', positioning: '职场干货', audience: '应届生', style: '克制' });
  const saved = store.saveAccount({ id: acc.id, xhsId: ' become5858 ' });
  assert.equal(saved.xhsId, 'become5858');
  assert.equal(saved.name, '我的账号');
  assert.equal(saved.positioning, '职场干货');
  assert.equal(saved.audience, '应届生');
  assert.equal(saved.style, '克制');
});

test('账号不存在时返回 404，不会新建账号', () => {
  assert.throws(() => store.saveAccount({ id: 'acc_none', xhsId: 'x' }), /账号不存在/);
});
