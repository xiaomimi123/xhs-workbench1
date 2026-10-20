import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const mod=await import('../xhs-workbench/server/image-service.mjs').catch(()=>({}));
test('settings preserve empty keys, mask secrets and restrict file permissions',()=>{
 assert.equal(typeof mod.ImageService,'function');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'apimart-'));try{
 const s=new mod.ImageService({file:path.join(dir,'secret.json')});
 const pub=s.save({apiKey:'secret-test-key',defaultProvider:'apimart'});
 assert.equal(pub.hasKey,true);assert.equal(JSON.stringify(pub).includes('secret-test-key'),false);
 assert.equal(s.save({apiKey:''}).hasKey,true);assert.equal(fs.statSync(s.file).mode&0o777,0o600);
 assert.equal(s.save({deleteKey:true}).hasKey,false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('connection uses models endpoint and never returns upstream error text',async()=>{
 assert.equal(typeof mod.ImageService,'function');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'apimart-'));try{
 const calls=[];const s=new mod.ImageService({file:path.join(dir,'key.json'),fetchImpl:async(u,o)=>{calls.push([u,o]);return new Response('secret-test-key',{status:401});}});s.save({apiKey:'secret-test-key'});
 const result=await s.testConnection();assert.equal(result.authenticated,false);assert.equal(result.connected,true);assert.equal(JSON.stringify(result).includes('secret-test-key'),false);assert.equal(calls[0][0],'https://api.apimart.ai/v1/models');assert.equal(calls.length,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('download rejects foreign or credentialed URLs and unsafe redirects without auth',async()=>{
 assert.equal(typeof mod.ImageService,'function');const calls=[];const s=new mod.ImageService({fetchImpl:async(u,o)=>{calls.push(o);return new Response(null,{status:302,headers:{location:'https://127.0.0.1/a.png'}});}});
 for(const u of ['http://upload.apimart.ai/a','https://evil.test/a','https://user:pass@upload.apimart.ai/a','https://upload.apimart.ai:444/a'])await assert.rejects(s.download(u));
 await assert.rejects(s.download('https://upload.apimart.ai/a'));assert.equal(calls.length,1);assert.equal(calls[0].headers?.Authorization,undefined);assert.equal(calls[0].redirect,'manual');
});
test('streamed images exceeding20MB are stopped even without content length',async()=>{
 const s=new mod.ImageService({fetchImpl:async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(20*1024*1024+1));controller.close();}}))});await assert.rejects(s.download('https://upload.apimart.ai/f/image/a.png'),/20MB/);
});
test('real task CDN getapib.org is accepted only by exact HTTPS host without credentials',async()=>{
 const calls=[];const s=new mod.ImageService({fetchImpl:async(u,o)=>{calls.push([u,o]);return new Response('image');}});
 assert.equal((await s.download('https://getapib.org/f/image/result.png')).toString(),'image');
 assert.equal(calls[0][1].headers?.Authorization,undefined);
 for(const u of ['https://getapib.org.evil.test/a','https://evil.getapib.org/a','http://getapib.org/a','https://user:pass@getapib.org/a','https://getapib.org:444/a'])await assert.rejects(s.download(u));
 assert.equal(calls.length,1);
});
test('failures record stage, status, request id and redacted upstream, never the key',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'apimart-'));try{
 const key='secret-test-key';const mk=(impl)=>{const s=new mod.ImageService({file:path.join(dir,'k.json'),fetchImpl:impl});s.save({apiKey:key});return s;};
 const http=mk(async()=>new Response(JSON.stringify({error:{message:`key ${key} rejected`}}),{status:401,headers:{'x-request-id':'req_1'}}));
 await assert.rejects(http.request('/v1/images/generations',{method:'POST',body:{}}),(err)=>{
  assert.equal(err.status,502);assert.equal(err.diag.stage,'http');assert.equal(err.diag.httpStatus,401);assert.equal(err.diag.requestId,'req_1');
  assert.match(err.diag.detail,/rejected/);assert.equal(err.diag.detail.includes(key),false);assert.match(err.diag.at,/^\d{4}-\d{2}-\d{2}T/);return true;});
 const net=mk(async()=>{const e=new Error('socket hang up');e.cause={code:'ECONNRESET'};throw e;});
 await assert.rejects(net.request('/v1/tasks/x'),(err)=>{assert.equal(err.diag.stage,'connect');assert.equal(err.diag.networkCode,'ECONNRESET');assert.equal(err.diag.httpStatus,null);return true;});
 const timeout=mk(async()=>{const e=new Error('The operation was aborted due to timeout');e.name='TimeoutError';throw e;});
 await assert.rejects(timeout.request('/v1/tasks/x'),(err)=>{assert.equal(err.diag.networkCode,'TimeoutError');return true;});
 const bad=mk(async()=>new Response('not-json'));
 await assert.rejects(bad.request('/v1/tasks/x'),(err)=>{assert.equal(err.diag.stage,'respond');return true;});
 const noId=mk(async()=>new Response(JSON.stringify({data:[{}]})));
 await assert.rejects(noId.submit({model:'gpt-image-2',prompt:'p',size:'1:1',resolution:'1k'},key),(err)=>{assert.equal(err.diag.stage,'respond');return true;});
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
