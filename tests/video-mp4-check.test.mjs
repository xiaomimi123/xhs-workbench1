// 没有 ffprobe 的电脑：生成的视频用纯 JS 的 MP4 结构校验入库；坏文件照样拒绝；参考视频上传说清楚怎么装 ffmpeg
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {useTempWorkspace,server} from './helpers.mjs';
const root=useTempWorkspace();const store=await server('store.mjs');store.ensureWorkspace();
const {VideoWorkflow,validate}=await server('video-workflow.mjs');const {checkMp4File}=await server('mp4-check.mjs');const {VideoReferences}=await server('video-references.mjs');const {findBinary}=await server('binaries.mjs');
const tiny=fs.readFileSync(new URL('./fixtures/tiny.mp4',import.meta.url)); // ffmpeg testsrc2 64×48、0.5 秒、moov 在文件末尾
const write=(name,bytes)=>{const f=path.join(root,name);fs.writeFileSync(f,bytes);return f;};
const box=(type,payload=Buffer.alloc(0))=>{const b=Buffer.alloc(8);b.writeUInt32BE(8+payload.length);b.write(type,4,'latin1');return Buffer.concat([b,payload]);};

test('没有 ffprobe：最小 MP4 通过基础校验，读出宽高和时长，标记 mp4-header',async()=>{
 const media=await validate(write('ok.mp4',tiny),{ffprobe:null});
 assert.deepEqual({...media,duration:Number(media.duration.toFixed(2))},{width:64,height:48,duration:0.5,checkedBy:'mp4-header'});
});

test('有 ffprobe 时行为不变（标记 ffprobe）',{skip:!findBinary('ffprobe')&&'本机没有 ffprobe'},async()=>{
 const media=await validate(write('probe.mp4',tiny));assert.equal(media.checkedBy,'ffprobe');assert.equal(media.width,64);assert.equal(media.height,48);
 await assert.rejects(validate(write('probe-bad.mp4',Buffer.concat([box('ftyp',Buffer.from('isom\0\0\0\0')),Buffer.from('garbage')]))),/ffprobe 无法读取|缺少有效视频轨道/);
});

test('没有 ffprobe：截断、缺 moov、缺画面、非 MP4 都被拒绝',async()=>{
 const ftyp=box('ftyp',Buffer.from('isom\0\0\0\0isom'));
 const moovAt=tiny.indexOf('moov')-4,moov=tiny.subarray(moovAt);
 const cases={
  '截断（下载不完整）':tiny.subarray(0,tiny.length-200),
  '只有文件头':ftyp,
  '没有 moov':Buffer.concat([ftyp,box('mdat',Buffer.alloc(64))]),
  '没有画面数据':Buffer.concat([ftyp,moov]),
  '文本冒充':Buffer.from('this is not a video at all'),
  '结尾多出残缺字节':Buffer.concat([tiny,Buffer.from([0,0,0])]),
 };
 for(const [name,bytes] of Object.entries(cases))await assert.rejects(validate(write('bad.mp4',bytes),{ffprobe:null}),e=>e.status===400&&/MP4/.test(e.message),name);
 // 没有视频轨：把 hdlr 的 vide 改成 soun
 const noVideo=Buffer.from(tiny);noVideo.write('soun',noVideo.indexOf('hdlr',moovAt)+12,'latin1');
 assert.throws(()=>checkMp4File(write('audio.mp4',noVideo)),/没有视频轨/);
});

test('工作流：没有 ffprobe 时中枢返回的 MP4 也能入库，坏文件不会变成已保存',async()=>{
 const a=store.saveAccount({name:'无ffprobe'}).id;let bytes=tiny;
 const service={config:()=>({baseUrl:'https://gateway.test/api/v1'}),submit:async()=>({job_id:'r'+Math.random().toString(36).slice(2)}),poll:async()=>({status:'done'}),download:async()=>bytes};
 const w=new VideoWorkflow({service,validate:f=>validate(f,{ffprobe:null})});
 const j=w.start(a,{mode:'t2v',prompt:'无 ffprobe',seconds:5,ratio:'3:4'});await w.active.get(j.id);
 const done=await w.refresh(a,j.id);assert.equal(done.status,'done');assert.equal(done.media.checkedBy,'mp4-header');assert.equal(done.media.width,64);
 bytes=tiny.subarray(0,tiny.length-200);const k=w.start(a,{mode:'t2v',prompt:'截断',seconds:5,ratio:'3:4'});await w.active.get(k.id);
 const broken=await w.refresh(a,k.id);assert.notEqual(broken.status,'done');assert.match(broken.error,/MP4/);
});

test('参考视频：没有 ffmpeg/ffprobe 时上传和抽帧都说清楚怎么装，且不留下半成品',async()=>{
 const a=store.saveAccount({name:'参考视频无ffmpeg'}).id;const refs=new VideoReferences({find:()=>null});
 await assert.rejects(refs.upload(a,{filename:'clip.mp4',data:tiny.toString('base64')}),e=>e.status===400&&/没有安装 ffprobe/.test(e.message)&&/ffmpeg/.test(e.message)&&/文生视频和图片动起来不需要/.test(e.message));
 assert.equal(refs.list(a).length,0);assert.deepEqual(fs.readdirSync(refs.dir(a)).filter(f=>f.startsWith('.upload-')),[]);
});

test('界面：只做了基础校验时提示用户播放确认',()=>{
 const src=fs.readFileSync(new URL('../xhs-workbench/web/modules/video-creation.js',import.meta.url),'utf8');
 assert.match(src,/checkedBy==='mp4-header'/);assert.match(src,/本机没有 ffprobe，只做了基础校验/);
});
