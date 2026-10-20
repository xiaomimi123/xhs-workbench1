// Persistent account-wide circuit breaker. Never touches cookies or browser profiles.
import fs from 'node:fs';
import path from 'node:path';
import {accountDir} from './paths.mjs';
import {readJson,writeJson,httpError} from './store.mjs';
function file(id){if(!/^[\w-]+$/.test(id||''))throw httpError(400,'账号 id 不合法');return path.join(accountDir(id),'browser-access.json');}
export function browserAccessStatus(id){
 const p=file(id),v=readJson(p,null);
 if(!fs.existsSync(p))return {kind:'open',reason:''};
 if(v&&['open','paused','login','restriction'].includes(v.kind)&&typeof v.reason==='string')return v;
 return {kind:'restriction',reason:'访问锁文件损坏，需人工确认修复'};
}
export function assertBrowserAccess(id){const s=browserAccessStatus(id);if(s.kind!=='open')throw httpError(409,`自动访问已锁定：${s.reason}`);}
function disarmCollection(id, reason) {
 const p=path.join(accountDir(id),'benchmarks','collection.json');const q=readJson(p,null);
 if(q?.schema===1&&Array.isArray(q.items)){q.paused=true;q.reason=reason;for(const item of q.items)if(item && typeof item==='object')item.authorized=false;writeJson(p,q);}
}
export function lockBrowserAccess(id,kind,reason){
 if(!['paused','login','restriction'].includes(kind))throw httpError(400,'锁定原因不合法');
 const prior=browserAccessStatus(id);
 disarmCollection(id,prior.kind==='restriction'?prior.reason:String(reason));
 // Ordinary pause/login must never downgrade a platform restriction.
 if(prior.kind==='restriction')return prior;
 const next={kind,reason:String(reason).slice(0,500),updatedAt:new Date().toISOString()};writeJson(file(id),next);return next;
}
export function resumeBrowserAccess(id){
 if(browserAccessStatus(id).kind==='restriction')throw httpError(409,'平台限制尚未解除，请通过独立的人工确认恢复操作处理');
 disarmCollection(id,'访问锁已恢复；请明确启动待办');
 const next={kind:'open',reason:'',updatedAt:new Date().toISOString()};writeJson(file(id),next);return next;
}
export function resolveBrowserRestriction(id,confirmed){
 if(confirmed!==true)throw httpError(400,'需要人工确认平台限制已解除');
 // Clear the lock only; never dispatch any queued task.
 disarmCollection(id,'平台限制已人工确认解除；请重新核对账号并明确启动待办');
 const next={kind:'open',reason:'',manuallyResolvedAt:new Date().toISOString()};writeJson(file(id),next);return next;
}
export function warningKind(reason=''){
 if(/验证码|安全验证|访问限制|访问受限|操作频繁|风险提示|AI不规范|商业权益|流量曝光|异常访问/.test(reason))return 'restriction';
 if(/登录|扫码/.test(reason))return 'login';
 return null;
}
