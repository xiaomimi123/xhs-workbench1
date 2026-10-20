import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
process.env.XHS_WORKSPACE=fs.mkdtempSync(path.join(os.tmpdir(),'apimart-flow-'));
const store=await import('../xhs-workbench/server/store.mjs');store.ensureWorkspace();const {ImageWorkflow}=await import('../xhs-workbench/server/image-workflow.mjs');const {ImageService}=await import('../xhs-workbench/server/image-service.mjs');
const png=fs.readFileSync(new URL('./fixtures/card.png',import.meta.url));
const setup=fetchImpl=>{const a=store.saveAccount({name:'APIMart test'}).id;const service=new ImageService({file:path.join(process.env.XHS_WORKSPACE,a+'-secret.json'),fetchImpl});service.save({apiKey:'private-key'});return {a,service,w:new ImageWorkflow({imageService:service})};};
const tick=()=>new Promise(r=>setImmediate(r));
test('remote task persists ID, sends frozen reference data and downloads PNG into existing reusable asset flow',async()=>{
 const calls=[];const {a,w,service}=setup(async(url,options)=>{calls.push([url,options]);if(url.endsWith('/generations'))return Response.json({code:200,data:[{task_id:'task_123',status:'submitted'}]});if(url.includes('/tasks/'))return Response.json({code:200,data:{id:'task_123',status:'completed',result:{images:[{url:['https://upload.apimart.ai/f/image/a.png']}]}}});return new Response(png);});
 const ref=w.uploadReference(a,{filename:'ref.png',data:png.toString('base64')});const j=w.start(a,{provider:'apimart',prompt:'温暖产品海报',outputMode:'poster',headline:'标题',references:[{file:ref.file,role:'product',source:'studio'}]});assert.equal(j.status,'submitting');await tick();assert.equal(w.find(a,j.id).taskId,'task_123');service.save({model:'gpt-image-2-ext',size:'1:1'});
 const done=await w.refresh(a,j.id);assert.equal(done.status,'done');assert.equal(done.assets[0].generator,'apimart');assert.equal(done.assets[0].model,'gpt-image-2');const body=JSON.parse(calls[0][1].body);assert.equal(body.image_urls[0],'data:image/png;base64,'+png.toString('base64'));assert.equal(body.size,'16:9');assert.match(body.prompt,/产品|product/);assert.match(body.prompt,/标题/);assert.equal(calls[2][1].headers,undefined);assert.equal(w.saveToLibrary(a,{id:j.id,index:0}).type,'image');
});
test('uncertain submission is never retried by refresh or identical start',async()=>{let calls=0;const {a,w}=setup(async()=>{calls++;throw Error('private-key');});const j=w.start(a,{provider:'apimart',prompt:'uncertain'});await tick();assert.equal(w.find(a,j.id).status,'needs_review');assert.equal(w.start(a,{provider:'apimart',prompt:'uncertain'}).id,j.id);await w.refresh(a,j.id);assert.equal(calls,1);assert.equal(JSON.stringify(w.find(a,j.id)).includes('private-key'),false);});
test('poll failures retain task ID and concurrent refresh is serialized',async()=>{let polls=0;const {a,w}=setup(async url=>{if(url.endsWith('generations'))return Response.json({data:[{task_id:'task_keep'}]});polls++;throw Error('private-key');});const j=w.start(a,{provider:'apimart',prompt:'poll'});await tick();await Promise.all([w.refresh(a,j.id),w.refresh(a,j.id)]);assert.equal(polls,1);assert.equal(w.find(a,j.id).taskId,'task_keep');assert.equal(w.find(a,j.id).status,'submitted');});
test('APIMart rejects multiple candidates before submitting',()=>{const {a,w}=setup(()=>{throw Error('must not call');});assert.throws(()=>w.start(a,{provider:'apimart',prompt:'batch',count:2}),/1/);});
test('restart recovers only a known task; an interrupted submission requires review without network',async()=>{
 let calls=0;const {a,w,service}=setup(async url=>{calls++;return url.endsWith('generations')?Response.json({data:[{task_id:'task_restart'}]}):Response.json({data:{status:'processing'}});});const j=w.start(a,{provider:'apimart',prompt:'restart'});await tick();const resumed=new ImageWorkflow({imageService:service});assert.equal((await resumed.refresh(a,j.id)).status,'processing');assert.equal(calls,2);
 const interrupted={...w.find(a,j.id),id:'imagejob_interrupted',status:'submitting'};delete interrupted.taskId;w.save(interrupted);assert.equal((await resumed.refresh(a,interrupted.id)).status,'needs_review');assert.equal(calls,2);
});
test.after(()=>fs.rmSync(process.env.XHS_WORKSPACE,{recursive:true,force:true}));

// ── 提交诊断修复的回归：明确拒绝与不确定断连分开记录，首次原因不被覆盖 ──
test('gateway 4xx is a definite rejection saved with upstream reason; refresh cannot rewrite it',async()=>{
 const {a,w}=setup(async()=>new Response(JSON.stringify({error:{code:402,message:'Insufficient balance',type:'payment_required'}}),{status:402,headers:{'x-request-id':'req_402'}}));
 const j=w.start(a,{provider:'apimart',prompt:'拒单测试'});await tick();
 const saved=w.find(a,j.id);
 assert.equal(saved.status,'error');assert.equal(saved.notSubmitted,true);assert.equal(saved.taskId,undefined);
 assert.equal(saved.diag.stage,'http');assert.equal(saved.diag.httpStatus,402);assert.equal(saved.diag.requestId,'req_402');
 assert.match(saved.error,/明确拒绝/);assert.match(saved.error,/Insufficient balance/);
 assert.equal(JSON.stringify(saved).includes('private-key'),false);
 assert.equal(w.start(a,{provider:'apimart',prompt:'拒单测试'}).id,j.id);
 await w.refresh(a,j.id);
 assert.equal(w.find(a,j.id).status,'error');
});
test('network disconnect stays needs_review with diagnostics preserved across refresh',async()=>{
 const {a,w}=setup(async()=>{const e=new Error('getaddrinfo failed');e.cause={code:'EAI_AGAIN'};throw e;});
 const j=w.start(a,{provider:'apimart',prompt:'断网测试'});await tick();
 const saved=w.find(a,j.id);
 assert.equal(saved.status,'needs_review');assert.equal(saved.notSubmitted,false);
 assert.equal(saved.diag.stage,'connect');assert.equal(saved.diag.networkCode,'EAI_AGAIN');
 assert.match(saved.error,/不确定/);assert.match(saved.error,/EAI_AGAIN/);
 await w.refresh(a,j.id);
 const after=w.find(a,j.id);
 assert.equal(after.status,'needs_review');
 assert.match(after.error,/提交诊断：connect/);
 assert.deepEqual(after.diag,saved.diag);
});
test('a 2xx response without task id is uncertain; poll 404 is reported explicitly with diagnostics',async()=>{
 const {a,w}=setup(async()=>Response.json({data:[{}]}));
 const j=w.start(a,{provider:'apimart',prompt:'缺编号'});await tick();
 const saved=w.find(a,j.id);
 assert.equal(saved.status,'needs_review');assert.equal(saved.diag.stage,'respond');assert.match(saved.error,/不确定/);
 const fresh=setup(async url=>url.endsWith('generations')?Response.json({data:[{task_id:'task_404'}]}):new Response(JSON.stringify({error:{code:404,message:'Invalid task ID'}}),{status:404}));
 const j2=fresh.w.start(fresh.a,{provider:'apimart',prompt:'查询404'});await tick();
 const after=await fresh.w.refresh(fresh.a,j2.id);
 assert.equal(after.status,'submitted');
 assert.match(after.error,/HTTP 404/);assert.equal(after.diag.httpStatus,404);
});
