// Real Chromium, fresh temp profile, every page request fulfilled locally.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { useTempWorkspace, server, PNG_1PX } from './helpers.mjs';
useTempWorkspace();
const { BrowserWorker } = await server('browser-worker.mjs');

const profileUrl = 'https://www.xiaohongshu.com/user/profile/target123';
const account = { id: 'isolated-fixture', xhsId: 'fixture-owner' };
const profileHtml = `<meta charset="utf-8"><div class="avatar-wrapper"><img class="user-image" width="20" height="20" src="data:image/png;base64,${PNG_1PX.toString('base64')}"></div><div class="user-info"><h1>测试作者</h1>小红书号：target123<div class="bio">分享真实经验</div><div>粉丝・3500</div><div>关注・42</div></div><div class="note-list">${Array.from({length:5},(_,i)=>`<a class="cover" href="/explore/note${i+1}abcd">笔记 ${i+1}</a>`).join(' ')}</div><script>
 document.querySelectorAll('a').forEach(a=>a.onclick=e=>{e.preventDefault();history.pushState({},'',a.href);setTimeout(()=>{let d=document.createElement('div');d.className='note-detail';d.innerHTML='<h1>'+a.textContent+'</h1><div class="interact-container"><span class="like-wrapper"><span class="count">12</span></span><span class="collect-wrapper"><span class="count">3</span></span><span class="chat-wrapper"><span class="count">1</span></span></div><button aria-label="关闭">关闭</button>';document.body.append(d);d.querySelector('button').onclick=()=>{d.remove();history.back()};},150)});
</script>`;

test('isolated real Chromium reads five notes with local routes and no repeated profile navigation', {skip: !process.env.XHS_ISOLATED_BROWSER_TEST}, async () => {
 const runtime=process.env.XHS_TEST_PLAYWRIGHT_MODULE || path.join(os.homedir(),'XHS-Workbench/browser-runtime/node_modules/playwright-core/index.mjs');
 const {chromium}=await import(pathToFileURL(path.resolve(runtime)).href);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xhs-isolated-'));
 const requests=[];let challenged=false;
 const artifact=path.resolve('output/playwright/browser-worker-isolated');fs.mkdirSync(artifact,{recursive:true});
 const sentinel=path.join(dir,'original.json');fs.writeFileSync(sentinel,'{"preserve":true}');
 const load=async()=>({chromium:{launchPersistentContext:async (profile,options)=>{
  const context=await chromium.launchPersistentContext(profile,{...options,channel:'chrome',headless:true,serviceWorkers:'block'});
  // Context route fails closed, page route exclusively supplies fixture HTML.
  await context.route('**/*',route=>route.abort());
  const page=context.pages()[0];
  await page.route('**/*',route=>{
   const url=route.request().url();requests.push(url);
   return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:url.startsWith('https://creator.')?'<meta charset="utf-8"><header>小红书号：fixture-owner</header>':url===profileUrl?(challenged?profileHtml.replace("d.className='note-detail';","d.className='note-detail';if(a.textContent.includes('3')){d.textContent='安全验证';document.body.append(d);return;}"):profileHtml):'<h1>Unexpected fixture URL</h1>'});
  });
  // Worker domain route must never replace fail-closed context routing.
  context.route=async()=>{};
  return context;
 }}});
 const worker=new BrowserWorker({assertAccess:()=>{},lockAccess:()=>{},load,profileRoot:dir,detect:()=> 'chrome',delay:async()=>{},recognize:async()=>({engine:'fixture',text:'测试作者 小红书号：target123 分享真实经验 3500 粉丝 42 关注',lines:[]}),download:async()=>({buffer:PNG_1PX,ext:'.png'})});
 try {
  assert.equal((await worker.verify(account,{name:'测试作者',url:profileUrl})).state,'needsReview');
  assert.equal(requests.length,0);
  assert.equal((await worker.prepare(account)).state,'ready');
  const notes=[];let profileFields;
  const result=await worker.verify(account,{name:'测试作者',url:profileUrl},{onVerified:async data=>{profileFields=data.profile;fs.writeFileSync(path.join(artifact,'profile-fields.json'),JSON.stringify(profileFields));fs.writeFileSync(path.join(artifact,'profile.png'),data.profileEvidence.png);fs.writeFileSync(path.join(artifact,'profile-ocr.json'),JSON.stringify(data.profileEvidence.ocr));fs.writeFileSync(path.join(artifact,'avatar.png'),data.avatarDownloaded.buffer);},onNote:async data=>{notes.push(data.note);fs.writeFileSync(path.join(artifact,`note-${notes.length}.json`),JSON.stringify(data.note));fs.writeFileSync(path.join(artifact,`note-${notes.length}.png`),data.noteEvidence.png);}});
  assert.equal(result.captured,5,JSON.stringify(result));
  assert.equal(notes.length,5);
  assert.equal(profileFields.bio,'分享真实经验');assert.equal(profileFields.followers,'3500');assert.equal(profileFields.following,'42');
  for(const note of notes){assert.equal(note.likes,'12');assert.equal(note.collects,'3');assert.equal(note.comments,'1');}
  assert.equal(requests.filter(url=>url===profileUrl).length,1);
  assert.equal(requests.filter(url=>url.startsWith('https://creator.')).length,1);
  assert.equal(requests.length,2);
  challenged=true;const kept=[];
  const partial=await worker.verify(account,{name:'测试作者',url:profileUrl},{onNote:async data=>{kept.push(data.note);fs.writeFileSync(path.join(artifact,`challenge-kept-${kept.length}.json`),JSON.stringify(data.note));}});
  assert.equal(partial.captured,2);assert.equal(kept.length,2);assert.equal(partial.captureState,'partial');
  assert.equal((await worker.verify(account,{name:'测试作者',url:profileUrl})).state,'needsReview');
  assert.equal(fs.readFileSync(sentinel,'utf8'),'{"preserve":true}');
  fs.writeFileSync(path.join(artifact,'summary.json'),JSON.stringify({complete:result,profileFields,fixtureDependencies:'OCR recognizer and avatar downloader are deterministic local stubs; no real OCR or CDN tested',challenge:partial,requests,originalPreserved:true,network:'All page requests fulfilled locally; all other context requests aborted'},null,2));
 } finally {await worker.closeAll();fs.rmSync(dir,{recursive:true,force:true});}
});
