import {loadPlaywright} from './browser-runtime.mjs';
import {detectRealBrowser} from './browser.mjs';
import {httpError} from './store.mjs';
// Isolated compatibility connection. Callers select transport BEFORE generation;
// this module never retries requests or follows redirects.
export function browserVideoRead(url,options={}){return browserVideoRequest(url,{...options,method:'GET'});}
export function browserVideoSubmit(url,options={}){return browserVideoRequest(url,{...options,method:'POST',binary:false});}
async function browserVideoRequest(url,{key,binary=false,timeoutMs=75000,method='GET',body}={}){
 const u=new URL(url);const validPath=method==='POST'?/^\/api\/v1\/generate\/(t2v|i2v|r2v|v2v|rv2v)$/:/^\/api\/v1\/(health|capabilities|jobs\/[-\w]+(?:\/video)?)$/;
 if(u.protocol!=='https:'||u.username||u.password||!validPath.test(u.pathname))throw httpError(400,'视频兼容连接的接口路径无效');
 const {chromium}=await loadPlaywright();const channel=detectRealBrowser();if(!channel)throw httpError(502,'未找到视频取回备用浏览器');
 let browser;try{browser=await chromium.launch({channel,headless:true});const context=await browser.newContext({serviceWorkers:'block',ignoreHTTPSErrors:false});const page=await context.newPage();const landing=u.origin+'/__workbench_video_transport';await page.route(landing,route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Video transport</title>'}));await page.goto(landing);
 const result=await page.evaluate(async({url,key,binary,timeoutMs,method,body})=>{const response=await fetch(url,{method,body:body?JSON.stringify(body):undefined,headers:{'X-API-Key':key,...(body?{'Content-Type':'application/json'}:{})},redirect:'error',credentials:'omit',signal:AbortSignal.timeout(timeoutMs)});if(!response.ok)return {status:response.status};const limit=binary?200*1024*1024:2*1024*1024;const reader=response.body.getReader();const parts=[];let length=0;while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>limit){await reader.cancel();throw Error('size');}parts.push(value);}const bytes=new Uint8Array(length);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}if(!binary)return {status:response.status,json:JSON.parse(new TextDecoder().decode(bytes))};let raw='';for(let i=0;i<bytes.length;i+=32768)raw+=String.fromCharCode(...bytes.subarray(i,i+32768));return {status:response.status,data:btoa(raw)};},{url:u.href,key,binary,timeoutMs,method,body});
 if(result.status<200||result.status>=300){const e=httpError(502,`视频接口失败（HTTP ${result.status}）`);e.upstreamStatus=result.status;throw e;}return binary?Buffer.from(result.data,'base64'):result.json;
 }catch(e){if(e.status)throw e;throw httpError(502,'视频兼容连接中断；请核对原任务，勿重复提交');}finally{await browser?.close();}
}
