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
