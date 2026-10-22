import {test} from 'node:test';
import assert from 'node:assert/strict';
import {useTempWorkspace,server,fakeAdapter} from './helpers.mjs';
useTempWorkspace();
const store=await server('store.mjs');store.ensureWorkspace();
const policy=await server('access-policy.mjs');
const {Bridge}=await server('bridge.mjs');
test('account locks persist and ordinary resume cannot clear restrictions',()=>{
 policy.lockBrowserAccess('default','restriction','账号处罚');
 assert.throws(()=>policy.assertBrowserAccess('default'),/账号处罚/);
 assert.throws(()=>policy.resumeBrowserAccess('default'),/人工确认/);
 assert.equal(policy.browserAccessStatus('default').kind,'restriction');
 policy.resolveBrowserRestriction('default',true);
 policy.assertBrowserAccess('default');
 policy.lockBrowserAccess('default','login','需要登录');
 policy.resumeBrowserAccess('default');policy.assertBrowserAccess('default');
});
test('manual worker and agent submissions are rejected before execution while locked',()=>{
 store.saveBridgeConfig({mode:'cli',browser:'playwright',adapter:fakeAdapter()});
 const bridge=new Bridge({browserWorker:{},onBenchmarkVerified(){}});
 policy.lockBrowserAccess('default','paused','用户暂停');
 for(const kind of ['benchmark.verify','browser.prepare',undefined]) assert.throws(()=>bridge.submit({id:'denied',accountId:'default',kind,prompt:'read'}),/用户暂停/);
 assert.equal(bridge.running.size,0); assert.equal(bridge.cliQueue.length,0);
 policy.resumeBrowserAccess('default');
});

test('stop cancels current and queued account work and restart retains lock',async()=>{
 store.saveBridgeConfig({mode:'cli',browser:'playwright',adapter:fakeAdapter()});
 let releases;const done=new Promise(r=>releases=r);let started=0;
 const worker={verify:async (_a,_b,{signal})=>{started++;await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return {state:'needsReview'};},close:async()=>{}};
 const bridge=new Bridge({browserWorker:worker,onBenchmarkVerified(){}});bridge.on('error',()=>{});
 for(const id of ['running','queued'])bridge.submit({id,accountId:'default',account:{id:'default'},benchmark:{},kind:'benchmark.verify'});
 assert.equal(started,1);assert.equal(bridge.cliQueue.length,1);
 policy.lockBrowserAccess('default','paused','停止测试');bridge.cancelAccount('default');
 await new Promise(r=>setTimeout(r,30));
 assert.equal(started,1);assert.equal(bridge.cliQueue.length,0);assert.equal(bridge.running.size,0);
 const fresh=new Bridge({browserWorker:worker,onBenchmarkVerified(){}});
 assert.throws(()=>fresh.submit({id:'again',accountId:'default',kind:'benchmark.verify'}),/停止测试/);
 policy.resumeBrowserAccess('default');releases();await done;
});

test('restriction recovery disarms old batch and inbox browser mode is rejected',async()=>{
 const {BenchmarkQueue,enqueueCollection}=await server('benchmark-queue.mjs');
 const sent=[];const q=new BenchmarkQueue({accounts:()=>[{id:'default'}],busy:()=>false,detail:()=>({observation:null}),dispatch:(_,id)=>sent.push(id),changed(){}});
 enqueueCollection('default',['b_old']);q.control('default','fill',['b_old']);
 policy.lockBrowserAccess('default','restriction','账号处罚');policy.resolveBrowserRestriction('default',true);q.tick();assert.deepEqual(sent,[]);
 store.saveBridgeConfig({mode:'inbox',browser:'builtin'});const bridge=new Bridge();
 assert.throws(()=>bridge.submit({id:'inbox',accountId:'default',prompt:'browse'}),/收件箱不支持/);
 assert.equal(bridge.tasks.size,0);
});

test('damaged queue cannot prevent persistent restriction lock',async()=>{
 const path=await import('node:path');const {accountDir}=await server('paths.mjs');
 store.writeJson(path.join(accountDir('damaged'),'benchmarks','collection.json'),{schema:1,items:[null]});
 policy.lockBrowserAccess('damaged','restriction','损坏时也停止');
 assert.throws(()=>policy.assertBrowserAccess('damaged'),/损坏时也停止/);
});

test('锁由工作台写入时带 source 标记；外部直接写的锁，提示里说明并给出关闭浏览器控制的办法', async () => {
  const fs = await import('node:fs'); const path = await import('node:path');
  const {accountDir} = await server('paths.mjs');
  const mine = policy.lockBrowserAccess('default','paused','用户暂停自动访问');
  assert.equal(mine.source,'workbench');
  assert.throws(()=>policy.assertBrowserAccess('default'),(e)=>/自动访问已锁定：用户暂停自动访问/.test(e.message)&&!/来源标记/.test(e.message)&&/关掉/.test(e.message));
  fs.writeFileSync(path.join(accountDir('default'),'browser-access.json'),JSON.stringify({kind:'restriction',reason:'用户提供平台处罚截图'}));
  assert.throws(()=>policy.assertBrowserAccess('default'),(e)=>/来源标记/.test(e.message)&&/关掉/.test(e.message));
  fs.rmSync(path.join(accountDir('default'),'browser-access.json'),{force:true});
});
