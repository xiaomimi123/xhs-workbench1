import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';import {useTempWorkspace,server} from './helpers.mjs';
const root=useTempWorkspace();const store=await server('store.mjs');store.ensureWorkspace();const {VideoReferences}=await server('video-references.mjs');const {VideoWorkflow}=await server('video-workflow.mjs');
const ffmpeg=fs.existsSync('/opt/homebrew/bin/ffmpeg')?'/opt/homebrew/bin/ffmpeg':'ffmpeg';const file=path.join(root,'fixture.mp4');execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=size=128x96:rate=12','-t','1','-c:v','libx264','-pix_fmt','yuv420p',file]);const bytes=fs.readFileSync(file);const a=store.saveAccount({name:'reference'}).id;
test('real video upload, media inspection, dedupe, frames, account isolation and tamper rejection',async()=>{const refs=new VideoReferences();const r=await refs.upload(a,{filename:'样片.mp4',data:bytes.toString('base64')});assert.equal(r.media.width,128);assert.equal((await refs.upload(a,{filename:'same.mp4',data:bytes.toString('base64')})).id,r.id);assert.throws(()=>refs.get('default',r.id));assert.throws(()=>refs.get(a,'../../escape'));const frames=await refs.frames(a,r.id,path.join(root,'frames'));assert.equal(frames.length,12);assert.ok(frames.every(f=>fs.existsSync(f.path)&&Number.isFinite(f.time)));assert.deepEqual(refs.read(a,r.id).bytes,bytes);fs.appendFileSync(path.join(root,'accounts',a,r.path),'tampered');assert.throws(()=>refs.read(a,r.id),/改变/);});
test('rejects malformed base64 and disguised nonvideo without saving it',async()=>{const refs=new VideoReferences();const before=refs.list(a).length;await assert.rejects(refs.upload(a,{filename:'fake.mp4',data:Buffer.from('text').toString('base64')}));await assert.rejects(refs.upload(a,{filename:'a.mp4',data:'not base64!'}));assert.equal(refs.list(a).length,before);});
test('v2v and rv2v freeze source bytes, retain preview, dedupe and recover result without resubmit',async()=>{const refs=new VideoReferences();const b=store.saveAccount({name:'workflow'}).id;const src=await refs.upload(b,{filename:'clip.mp4',data:bytes.toString('base64')});let calls=[];const service={config:()=>({baseUrl:'https://example.test/api/v1'}),submit:async p=>{calls.push(p);return {job_id:'remote-'+calls.length};},poll:async()=>({status:'done'}),download:async()=>bytes};const w=new VideoWorkflow({service,videoReferences:refs});const img=w.images.uploadReference(b,{filename:'a.png',data:fs.readFileSync(new URL('./fixtures/card.png',import.meta.url)).toString('base64'),role:'product'});for(const mode of ['v2v','rv2v']){const v={mode,prompt:'test',sourceVideoId:src.id,references:mode==='rv2v'?['ref:'+img.file]:[]};const j=w.start(b,v);await w.active.get(j.id);assert.equal(w.start(b,v).id,j.id);assert.deepEqual(Buffer.from(calls.at(-1).source_video.data_base64,'base64'),bytes);assert.ok(fs.existsSync(path.join(root,'accounts',b,j.sourcePath)));assert.equal((await w.refresh(b,j.id)).status,'done');}assert.equal(calls.length,2);assert.equal(calls[1].reference_images.length,1);});

// ── 拼图：12 帧 → 2 张 3×2 拼图，agent 只读 2 张图 ──
test('抽帧拼图：12 帧合成 2 张拼图，每张 6 个时间点（按时间顺序），尺寸是单帧的 3×2，拼图失败时返回空数组', async () => {
  const refs = new VideoReferences();
  const c = store.saveAccount({ name: 'sheets' }).id;
  const src = await refs.upload(c, { filename: 'clip.mp4', data: bytes.toString('base64') });
  const dir = path.join(root, 'frames-sheets');
  const frames = await refs.frames(c, src.id, dir);
  const sheets = await refs.contactSheets(frames, path.join(root, 'sheets'));
  assert.equal(sheets.length, 2);
  assert.deepEqual(sheets.map((s) => s.times.length), [6, 6]);
  assert.deepEqual(sheets.flatMap((s) => s.times), frames.map((f) => f.time));
  for (const s of sheets) assert.ok(fs.statSync(s.path).size > 1000);
  // 每张拼图宽度 = 3 个单帧宽度（128×96 的样片）
  const size = (f) => execFileSync(process.platform === 'win32' ? 'ffprobe' : 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim().split(',').map(Number);
  const [fw, fh] = size(frames[0].path);
  assert.deepEqual(size(sheets[0].path), [fw * 3, fh * 2]);
  // 少于 6 帧、没有帧、帧文件缺失：不抛错
  assert.deepEqual(await refs.contactSheets([], path.join(root, 'sheets-empty')), []);
  assert.deepEqual(await refs.contactSheets([{ time: 0, path: path.join(root, 'nope', 'frame-00.jpg') }], path.join(root, 'sheets-missing')), []);
});
