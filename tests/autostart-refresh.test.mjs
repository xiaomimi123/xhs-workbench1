import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 自启文件的位置读 APPDATA / HOME，必须在载入 system.mjs 之前指到临时目录，别碰员工真实的启动项
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-as-'));
process.env.APPDATA = path.join(tmp, 'AppData');
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;
const sys = await import('../xhs-workbench/server/system.mjs');

test('没开自启：不创建任何文件', () => {
  assert.equal(sys.autostartStatus().enabled, false);
  assert.equal(sys.refreshAutostart(), false);
  assert.equal(sys.autostartStatus().enabled, false);
});

test('自启指向旧版本目录（内容过期）时改写成当前版本，再调一次不再改', () => {
  const { file } = sys.autostartStatus();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stale = sys.autostartContent().replaceAll(path.join('apps', 'xhs-workbench'), path.join('apps', 'xhs-workbench-OLD')) + '\n\' stale';
  if (file.endsWith('.vbs')) fs.writeFileSync(file, '\uFEFF' + stale, 'utf16le'); else fs.writeFileSync(file, stale);
  assert.equal(sys.autostartDrift(), true);
  assert.equal(sys.refreshAutostart(), true);
  assert.equal(sys.autostartDrift(), false);
  assert.equal(sys.refreshAutostart(), false);
  const now = file.endsWith('.vbs') ? fs.readFileSync(file).toString('utf16le').replace(/^\uFEFF/, '') : fs.readFileSync(file, 'utf8');
  assert.equal(now, sys.autostartContent());
});
