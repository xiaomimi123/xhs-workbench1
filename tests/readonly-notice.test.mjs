// 只读档说明（XHS-11）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src = fs.readFileSync(new URL('../xhs-workbench/web/readonly-notice.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/export /g, '');
test('只读档时说明发送 / 发布要本人完成；测试档或没接浏览器时不显示', () => {
  const ctx = vm.createContext({ S: { bridge: { browserMode: 'readonly' } } });
  vm.runInContext(src, ctx);
  assert.match(vm.runInContext("readonlyNotice('发布笔记')", ctx), /只读档.*发布笔记要你本人/);
  ctx.S.bridge.browserMode = 'test'; assert.equal(vm.runInContext("readonlyNotice('x')", ctx), '');
  ctx.S.bridge.browserMode = null; assert.equal(vm.runInContext("readonlyNotice('x')", ctx), '');
});
