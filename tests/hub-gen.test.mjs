import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {useTempWorkspace,server} from './helpers.mjs';useTempWorkspace();const store=await server('store.mjs'),c=await server('content.mjs');store.ensureWorkspace();
const {locateConnector,HubGen,HubVideoService}=await server('hub-gen.mjs');
const {ImageWorkflow}=await server('image-workflow.mjs');
const {VideoWorkflow}=await server('video-workflow.mjs');
const png=fs.readFileSync(new URL('./fixtures/card.png',import.meta.url));
const HUB='http://hub.test:8088';

function serversFile(dir){const f=path.join(dir,'mcp-servers.json');fs.writeFileSync(f,JSON.stringify({mcpServers:{'enterprise-hub':{command:'uv',args:['run','--quiet','C:/Users/a/.hub-agent/hub_agent.py','mcp','--nested']}}}));return f;}
function fakeHub({tokens=['t1'],routes={}}={}){
 const calls=[];let issued=0;
 const fetchImpl=async(url,opts={})=>{const u=new URL(url);calls.push({url:u,opts});const h=routes[`${opts.method||'GET'} ${u.pathname}`];if(!h)return new Response('{}',{status:404});return h(u,opts);};
 const runToken=async()=>({hub:HUB,access_token:tokens[Math.min(issued++,tokens.length-1)],expires_at:Date.now()/1000+3600});
 return {calls,fetchImpl,runToken,issued:()=>issued};
}
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});

test('从接入器写给工作台的 MCP 配置里找到接入器；没有时不可用',()=>{
 const dir=fs.mkdtempSync(path.join(process.env.XHS_WORKSPACE||'.','hubgen-'));const f=serversFile(dir);
 assert.deepEqual(locateConnector({HUB_MCP_SERVERS_FILE:f}),{command:'uv',pre:['run','--quiet'],script:'C:/Users/a/.hub-agent/hub_agent.py'});
 assert.equal(locateConnector({}),null);
 assert.equal(new HubGen({env:{}}).available(),false);
 assert.equal(new HubGen({env:{HUB_MCP_SERVERS_FILE:f}}).available(),true);
});

test('令牌过期（401）换一次令牌重试；中枢 4xx 拒绝标记为未提交',async()=>{
 const dir=fs.mkdtempSync(path.join(process.env.XHS_WORKSPACE||'.','hubgen-'));
 const hub=fakeHub({tokens:['old','new'],routes:{
  'POST /api/v1/images':(u,o)=>o.headers.Authorization==='Bearer new'?json({task_id:'task-1'},202):json({detail:'令牌无效'},401),
  'POST /api/v1/videos':(u,o)=>JSON.parse(o.body).seconds>10?json({detail:[{loc:['body','seconds'],msg:'Input should be less than or equal to 10'}]},422):json({detail:'本月 GPU 额度已用完'},403),
 }});
 const g=new HubGen({env:{HUB_MCP_SERVERS_FILE:serversFile(dir)},fetchImpl:hub.fetchImpl,runToken:hub.runToken});
 assert.equal(await g.submitImage({prompt:'暖光',aspect:'3:4',count:2}),'task-1');
 assert.equal(hub.issued(),2);
 assert.deepEqual(JSON.parse(hub.calls.at(-1).opts.body),{prompt:'暖光',aspect:'3:4',count:2});
 await assert.rejects(g.submitVideo({prompt:'x',aspect:'9:16',seconds:5}),e=>e.notSubmitted===true&&/额度/.test(e.message));
 await assert.rejects(g.submitVideo({prompt:'x',aspect:'9:16',seconds:99}),e=>e.notSubmitted===true&&/参数不对（seconds Input should be less than or equal to 10）/.test(e.message));
 await assert.rejects(g.submitImage({prompt:'x',aspect:'21:9'}),/画幅/);
});

test('下载只接受这个中枢的 /api/files/ 链接，图片要求转 PNG',async()=>{
 const dir=fs.mkdtempSync(path.join(process.env.XHS_WORKSPACE||'.','hubgen-'));
 const hub=fakeHub({routes:{'GET /api/files/t1/a.webp':u=>new Response(u.searchParams.get('fmt')==='png'?png:'webp')}});
 const g=new HubGen({env:{HUB_MCP_SERVERS_FILE:serversFile(dir)},fetchImpl:hub.fetchImpl,runToken:hub.runToken});
 assert.deepEqual(await g.download(`${HUB}/api/files/t1/a.webp?exp=1&sig=s`,{png:true}),png);
 await assert.rejects(g.download('http://evil.test/api/files/t1/a.webp'),/不是这个中枢/);
 await assert.rejects(g.download(`${HUB}/api/v1/tasks/t1`),/不是这个中枢/);
});

function fakeGen({available=true,images=[],status='done',submitError}={}){
 const submitted=[];
 return {submitted,available:()=>available,
  submitImage:async a=>{if(submitError)throw submitError;submitted.push(a);return 'task-img';},
  capabilities:async()=>({image_via:'第三方 API',image_references:true}),
  poll:async()=>({status,images,videos:['http://hub.test/api/files/v/out.mp4'],error:status==='failed'?'显卡忙':'',ahead:status==='queued'?2:undefined}),
  download:async(url,o)=>{assert.equal(o.png,true);return png;}};
}
const account=()=>store.saveAccount({name:'中枢出图'}).id;

test('公司中枢出图：提交、排队、完成后下载成候选图',async()=>{
 const gen=fakeGen({status:'queued'}),w=new ImageWorkflow({hubGen:gen}),a=account();
 const j=w.start(a,{prompt:'姜黄拿铁',provider:'hub',size:'3:4',count:2,outputMode:'poster',headline:'秋天第一杯'});
 assert.equal(j.status,'submitting');assert.equal(j.handoff,'');await w.active.get(j.id);
 assert.equal(w.find(a,j.id).taskId,'task-img');assert.equal(gen.submitted[0].aspect,'3:4');assert.equal(gen.submitted[0].count,2);assert.match(gen.submitted[0].prompt,/秋天第一杯/);
 let r=await w.refresh(a,j.id);assert.equal(r.status,'submitted');assert.match(r.error,/2 个任务/);
 Object.assign(gen,fakeGen({images:['http://hub.test/api/files/task-img/1.png','http://hub.test/api/files/task-img/2.png']}));
 r=await w.refresh(a,j.id);assert.equal(r.status,'done');assert.equal(r.assets.length,2);assert.equal(r.assets[0].provider,'hub');
});

test('公司中枢出图：失败、数量不符、拒绝提交、参考图和未接中枢',async()=>{
 const a=account();
 let w=new ImageWorkflow({hubGen:fakeGen({status:'failed'})});let j=w.start(a,{prompt:'失败',provider:'hub',size:'1:1'});await w.active.get(j.id);
 assert.equal((await w.refresh(a,j.id)).status,'failed');assert.match(w.find(a,j.id).error,/显卡忙/);
 w=new ImageWorkflow({hubGen:fakeGen({images:['http://hub.test/api/files/x/1.png']})});j=w.start(a,{prompt:'数量',provider:'hub',size:'1:1',count:2});await w.active.get(j.id);
 const r=await w.refresh(a,j.id);assert.notEqual(r.status,'done');assert.match(r.error,/应为 2 张/);
 const denied=Object.assign(Error('企业中枢：本月 GPU 额度已用完'),{status:403,notSubmitted:true,upstreamStatus:403});
 w=new ImageWorkflow({hubGen:fakeGen({submitError:denied})});j=w.start(a,{prompt:'额度',provider:'hub',size:'1:1'});await w.active.get(j.id);
 assert.equal(w.find(a,j.id).status,'error');assert.match(w.find(a,j.id).error,/额度.*没有创建任务/);
 assert.throws(()=>w.start(a,{prompt:'比例',provider:'hub',size:'21:9'}),/比例/);
 assert.throws(()=>new ImageWorkflow({hubGen:fakeGen({available:false})}).start(a,{prompt:'未接',provider:'hub',size:'1:1'}),/没有接上企业中枢/);
});

test('公司中枢出视频：比例和时长换算、首帧图、其他模式拒绝',async()=>{
 const sent=[];const gen={available:()=>true,submitVideo:async a=>{sent.push(['t2v',a]);return 'v1';},submitVideoFromImage:async a=>{sent.push(['i2v',a]);return 'v2';}};
 const s=new HubVideoService(gen);
 assert.deepEqual(await s.submit({mode:'t2v',prompt:'p',width:480,height:864,total_frames:192}),{job_id:'v1'});
 assert.deepEqual(sent[0][1],{prompt:'p',aspect:'9:16',seconds:8});
 await s.submit({mode:'i2v',prompt:'动起来',width:576,height:768,total_frames:124,reference_images:[{filename:'a.png',data_base64:png.toString('base64')}]});
 assert.deepEqual(sent[1][1].image,png);assert.equal(sent[1][1].seconds,5);
 await assert.rejects(s.submit({mode:'r2v',prompt:'p',width:576,height:768,total_frames:124}),e=>e.notSubmitted===true);
 assert.throws(()=>new HubVideoService({available:()=>false}).config(),/没有接上企业中枢/);
});

test('视频创作选公司中枢：任务记录服务来源，查询下载走中枢；中枢只开放两种模式',async()=>{
 const gateway={config:()=>({baseUrl:'https://gateway.test/api/v1',apiKey:'k'}),submit:async()=>{throw Error('不该走网关');}};
 const hub={available:()=>true,config:()=>({baseUrl:'company-hub'}),submit:async()=>({job_id:'hubvid1'}),poll:async()=>({status:'done'}),download:async()=>Buffer.from('mp4'),id:()=>{}};
 const w=new VideoWorkflow({service:gateway,hub,validate:async()=>({width:576,height:768,duration:5.1})}),a=account();
 const j=w.start(a,{mode:'t2v',prompt:'暖光',seconds:5,ratio:'3:4'});assert.equal(j.provider,'hub');await w.active.get(j.id);
 const r=await w.refresh(a,j.id);assert.equal(r.status,'done');assert.equal(r.remoteId,'hubvid1');
 assert.throws(()=>w.start(a,{mode:'r2v',prompt:'x',references:['ref:a.png']}),/只支持/);
 const old=new VideoWorkflow({service:gateway,hub:{...hub,available:()=>false}});assert.equal(old.defaultProvider(),'gateway');
});

test('下载断流自动重试两次；链接过期（4xx）不重试（XHS-04）',async()=>{
 const dir=fs.mkdtempSync(path.join(process.env.XHS_WORKSPACE||'.','hubgen-'));let n=0;const waits=[];
 const hub=fakeHub({routes:{'GET /api/files/t1/a.png':()=>{n++;if(n<3)throw new TypeError('fetch failed');return new Response(png);},'GET /api/files/t1/old.png':()=>{n++;return new Response('',{status:403});},'GET /api/files/t1/bad.png':()=>{n++;return new Response('',{status:502});}}});
 const g=new HubGen({env:{HUB_MCP_SERVERS_FILE:serversFile(dir)},fetchImpl:hub.fetchImpl,runToken:hub.runToken,sleep:async ms=>{waits.push(ms);}});
 assert.deepEqual(await g.download(`${HUB}/api/files/t1/a.png`),png);assert.equal(n,3);assert.deepEqual(waits,[1500,3000]);
 n=0;await assert.rejects(g.download(`${HUB}/api/files/t1/old.png`),/HTTP 403/);assert.equal(n,1);
 n=0;await assert.rejects(g.download(`${HUB}/api/files/t1/bad.png`),/已自动重试 2 次/);assert.equal(n,3);
});

test('公司中枢出图带参考图：参考图快照和角色说明交给中枢；通道不支持时中枢拒绝、不建任务',async()=>{
 const a=account();let gen=fakeGen({status:'queued'}),w=new ImageWorkflow({hubGen:gen});
 const prod=w.uploadReference(a,{filename:'产品.png',data:png.toString('base64'),role:'product'});
 const j=w.start(a,{prompt:'换成秋天背景',provider:'hub',size:'3:4',references:[{file:prod.file,source:'studio',role:'product'}]});
 await w.active.get(j.id);
 assert.equal(gen.submitted[0].references.length,1);assert.deepEqual(gen.submitted[0].references[0].data,png);
 assert.match(gen.submitted[0].prompt,/参考图1：保持实际产品包装/);
 const denied=Object.assign(Error('企业中枢：当前出图通道（本机 GPU）不支持参考图，只有第三方 API 通道支持'),{status:400,notSubmitted:true,upstreamStatus:400});
 w=new ImageWorkflow({hubGen:fakeGen({submitError:denied})});
 const k=w.start(a,{prompt:'换成冬天背景',provider:'hub',size:'3:4',references:[{file:prod.file,source:'studio',role:'product'}]});await w.active.get(k.id);
 assert.equal(w.find(a,k.id).status,'error');assert.match(w.find(a,k.id).error,/不支持参考图.*没有创建任务/);
});

test('HubGen 带参考图走 /images/with-references，不带走 /images；能力查询有缓存',async()=>{
 const dir=fs.mkdtempSync(path.join(process.env.XHS_WORKSPACE||'.','hubgen-'));let capCalls=0;const forms=[];
 const hub=fakeHub({routes:{
  'POST /api/v1/images/with-references':(u,o)=>{forms.push(o.body);return json({task_id:'r1'},202);},
  'POST /api/v1/images':()=>json({task_id:'p1'},202),
  'GET /api/v1/capabilities':()=>{capCalls++;return json({image_via:'第三方 API',image_references:true});},
 }});
 const g=new HubGen({env:{HUB_MCP_SERVERS_FILE:serversFile(dir)},fetchImpl:hub.fetchImpl,runToken:hub.runToken});
 assert.equal(await g.submitImage({prompt:'p',aspect:'1:1',references:[{data:png,filename:'a.png'},{data:png,filename:'b.png'}]}),'r1');
 assert.equal(forms[0].getAll('images').length,2);assert.equal(forms[0].get('prompt'),'p');
 assert.equal(await g.submitImage({prompt:'p',aspect:'1:1'}),'p1');
 assert.equal((await g.capabilities()).image_references,true);await g.capabilities();assert.equal(capCalls,1);
});
