import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempWorkspace, server, PNG_1PX } from './helpers.mjs';
const ws = useTempWorkspace();
const store = await server('store.mjs');
const observation = await server('benchmark-observation.mjs');
store.ensureWorkspace();
test('下载头像保留独立来源，截图 OCR 证据落在本账号目标目录', () => {
  assert.equal(typeof observation.stageDownloadedAvatar, 'function');
  const name = observation.stageDownloadedAvatar('default', 'b_hybrid', PNG_1PX, '.png');
  assert.match(name, /^avatar-download-/);
  const evidence = observation.stageVisualEvidence('default', 'b_hybrid', { png: PNG_1PX, ocr: { engine: 'fixture', text: '资料', lines: [] } });
  assert.equal(JSON.parse(fs.readFileSync(path.join(ws, 'accounts/default', evidence.ocr))).text, '资料');
  assert.ok(fs.existsSync(path.join(ws, 'accounts/default', evidence.screenshot)));
  assert.throws(() => observation.stageDownloadedAvatar('default', '../other', PNG_1PX, '.png'));
});
const visual = await server('visual-capture.mjs');
test('下载仅使用页面给出的图片域名，拒绝跨域重定向、过大和非图片响应', async () => {
  const result = await visual.downloadAvatar('https://sns-avatar-qc.xhscdn.com/avatar/actual.png?signature=private', { fetcher: async () => new Response(PNG_1PX) });
  assert.equal(result.ext, '.png');
  assert.equal(result.sourceUrl, 'https://sns-avatar-qc.xhscdn.com/avatar/actual.png');
  await assert.rejects(visual.downloadAvatar('https://evil.example/avatar.png'), /图片域名/);
  await assert.rejects(visual.downloadAvatar('https://sns-avatar-qc.xhscdn.com/a', { fetcher: async () => new Response('', {status: 302, headers: {location: 'http://127.0.0.1/private'}}) }), /图片域名/);
  await assert.rejects(visual.downloadAvatar('https://sns-avatar-qc.xhscdn.com/a', { fetcher: async () => new Response(Buffer.alloc(2097153)) }), /2MB/);
  await assert.rejects(visual.downloadAvatar('https://sns-avatar-qc.xhscdn.com/a', { fetcher: async () => new Response('html error') }), /不是图片/);
});
test('OCR 与页面字段不一致时不刷新数字或简介', () => {
  assert.deepEqual(visual.corroborateProfile({bio:'未识别简介', followers:'1464',following:'6'}, {text:'6 关注 1464 粉丝'}), {followers:'1464',following:'6'});
  assert.deepEqual(visual.corroborateProfile({followers:'999'}, {text:'1464 粉丝'}), {});
});
test('刷新主页五篇名单变动时，不让旧笔记挤掉本轮已采集笔记', () => {
  const item = { id: 'b_refresh', verifiedAt:'2026-10-17T01:00:00Z', url:'https://www.xiaohongshu.com/user/profile/refresh', xhsId:'refresh' };
  const urls = ['aaaaaa','bbbbbb','cccccc','dddddd','eeeeee','ffffff'].map(id => 'https://www.xiaohongshu.com/explore/' + id);
  const entry = {stage:'observation', id:item.id,url:item.url,xhsId:item.xhsId,profileName:'刷新',source:'worker-visible',state:'profile',observedAt:'2026-10-17T01:00:00Z'};
  observation.mergeObservation('default',item,{...entry,notes:urls.slice(0,5).map((url,position)=>({url,position,title:'旧'}))});
  observation.mergeObservation('default',item,{...entry,observedAt:'2026-10-17T02:00:00Z',visibleNoteUrls:urls.slice(1),discoveredCount:5});
  for(let i=1;i<6;i++) observation.mergeObservation('default',item,{...entry,observedAt:'2026-10-17T02:01:00Z',notes:[{url:urls[i],position:i-1,title:'新'}]});
  assert.deepEqual(observation.readObservation('default',item).snapshot.notes.map(n=>n.url),urls.slice(1));
});
test('OCR 数值必须与标签关联且完整匹配，不能接受调换计数或子串', () => {
  const ocr = {text:'6 关注 1464 粉丝'};
  assert.deepEqual(visual.corroborateProfile({followers:'6',following:'1464'},ocr),{});
  assert.deepEqual(visual.corroborateProfile({followers:'464'},ocr),{});
});

test('中文截图低置信度标点行可通过完整页面值核对，简介逐段核对', () => {
 const ocr={text:'',lines:[{text:'6 关注 1464粉丝 1.8万 获赞与收藏',confidence:0.3},{text:'©9 追踪全球 AI的每一刻动态',confidence:0.3},{text:'IXiaoHu.AI学院 首席唯一编撰官兼客服',confidence:0.3}]};
 assert.deepEqual(visual.corroborateProfile({followers:'1464',following:'6',likesAndCollects:'1.8万',bio:'🧐追踪全球 AI的每一刻动态\n🌈XiaoHu.AI学院 首席唯一编撰官兼客服'},ocr),{followers:'1464',following:'6',likesAndCollects:'1.8万',bio:'🧐追踪全球 AI的每一刻动态\n🌈XiaoHu.AI学院 首席唯一编撰官兼客服'});
});
