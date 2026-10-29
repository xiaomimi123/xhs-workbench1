// Persistent account-wide circuit breaker. Never touches cookies or browser profiles.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {accountDir} from './paths.mjs';
import {readJson,writeJson,httpError} from './store.mjs';
// 锁放在哪：企业中枢接入器启动时传入 HUB_APP_STATE_DIR（在应用根目录之外，被允许读写数据目录的 agent 碰不到——Codex 曾直接改过数据目录里的锁）；
// agent 直接运行命令时没有这个变量，按默认位置找同一处。单独使用（没接中枢）或测试时仍放在账号数据目录里
export function stateRoot(env = process.env, home = os.homedir(), exists = fs.existsSync) {
  if (env.HUB_APP_STATE_DIR) return env.HUB_APP_STATE_DIR;
  if (env.XHS_WORKSPACE) return '';
  const d = path.join(env.HUB_AGENT_HOME || path.join(home, '.hub-agent'), 'state', 'xhs-workbench');
  return exists(d) ? d : '';
}
function file(id){
 if(!/^[\w-]+$/.test(id||''))throw httpError(400,'账号 id 不合法');
 const legacy=path.join(accountDir(id),'browser-access.json'), root=stateRoot();
 if(!root)return legacy;
 const p=path.join(root,'accounts',id,'browser-access.json');
 if(!fs.existsSync(p)&&fs.existsSync(legacy)){ // 第一次换位置：原样搬过去（包括限制状态），旧文件改名，避免有人以为改它还有用
  try{fs.mkdirSync(path.dirname(p),{recursive:true});fs.copyFileSync(legacy,p);fs.renameSync(legacy,legacy+'.migrated');}catch{}
 }
 return p;
}
export function browserAccessStatus(id){
 const p=file(id),v=readJson(p,null);
 if(!fs.existsSync(p))return {kind:'open',reason:''};
 if(v&&['open','paused','login','restriction'].includes(v.kind)&&typeof v.reason==='string')return v;
 return {kind:'restriction',reason:'访问锁文件损坏，需人工确认修复'};
}
export function assertBrowserAccess(id){
 const s=browserAccessStatus(id);
 if(s.kind==='open')return;
 // 没有 source 标记：旧版本写的，或某个 agent 直接改了文件（Codex 就发生过），要让用户知道并核对
 const external=s.source!=='workbench'&&!s.manuallyResolvedAt;
 // 先说「怎么解开」：只有这一条能让对话继续；关浏览器控制只对 CLI 模式有用（收件箱模式下不管浏览器开没开都会查这把锁）
 const fix=s.kind==='paused'?'解开办法：到「竞品对标 → 采集状态」点「恢复自动访问」。'
  :s.kind==='login'?'解开办法：到「竞品对标」点「先核对登录账号」，确认登录后会自动解开。'
  :'这是平台限制，要人工确认解除：到「竞品对标 → 采集状态 → 遇到验证码或访问受限时」处理。';
 const err=httpError(409,`自动访问已锁定：${s.reason}。${fix}`
  +(external?'（这个锁没有工作台的来源标记：可能是旧版本写的，也可能是某个 agent 直接改了文件。请先核对账号是否真的被限制；确认没有，可在网页里人工解除）':'')
  +'只想聊天、不用浏览器的话，也可以到「连接与设置」把浏览器方式设为「无」（收件箱模式下这样做没用，请按上面的办法解开）。');
 err.lockKind=s.kind;
 throw err;
}
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
 const next={kind,reason:String(reason).slice(0,500),source:'workbench',updatedAt:new Date().toISOString()};writeJson(file(id),next);return next;
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
