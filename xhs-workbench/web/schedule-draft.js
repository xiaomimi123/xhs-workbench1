import {api,S,go,toast,opt} from './core.js';
import {esc} from './md.js';
export function localTime(iso){return new Date(new Date(iso).getTime()+8*3600000).toISOString().slice(0,16);}
export function draftTime(value){
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))throw Error('计划时间格式无效');
 const d=new Date(value+':00+08:00');if(!Number.isFinite(d.getTime())||localTime(d)!==value)throw Error('计划时间无效');return d.toISOString();
}
const states=new Map();
export const draftBusy=()=>!!states.get(S.accountId)?.busy;
export function renderDraft(root,notes,items,selected){
 const account=S.accountId;let v=states.get(account);if(!v){v={noteId:'',time:localTime(Date.now()+3600000),report:null,revision:0};states.set(account,v);}
 if(selected&&selected!==v.noteId){v.noteId=selected;v.report=null;v.revision++;}
 if(!notes.some(n=>n.id===v.noteId)){v.noteId='';v.report=null;v.revision++;}
 v.noteId ||= notes.find(n=>n.status!=='published')?.id||'';
 const current=()=>S.accountId===account&&S.view==='schedule'&&root.isConnected;
 const query=`account=${encodeURIComponent(account)}`;
 const draw=()=>{
 if(!current())return;
 const item=items.find(s=>s.mode==='draft'&&s.noteId===v.noteId&&s.status==='planned');
 const r=v.report;
 root.innerHTML=`<h3>发布前检查与排期草案</h3><p class="muted">草案只记录时间，到点不发布、不提醒发布，也不会更改笔记状态。时间均为北京时间 Asia/Shanghai。</p>
 <form id="draft-form" class="form"><label>现有笔记<select name="draftNote">${notes.map(n=>opt(n.id,n.title||'无标题',v.noteId)).join('')}</select></label>
 <label>草案计划时间<input type="datetime-local" name="draftTime" value="${esc(v.time)}"></label>
 <div class="row"><button type="button" class="btn" data-draft="check" ${v.busy?'disabled':''}>检查当前笔记</button><button class="btn primary" type="submit" ${!r?.ok||v.busy?'disabled':''}>${item?'保存改期草案':'保存排期草案'}</button><button type="button" class="btn" data-draft="preview">完整图文预览</button>${item?'<button type="button" class="btn" data-draft="cancel">取消演示草案</button>':''}</div></form>
 ${item?`<p>已有草案 · ${esc(localTime(item.publishAt).replace('T',' '))} · 不执行发布</p>`:''}
 ${r?`<section><h4>${r.ok?'检查通过（本地检查）':'检查未通过'} · ${r.images.length} 张图片</h4><p>${esc(r.title)}</p><p>${esc(r.excerpt||'')}</p>${r.images.map(i=>`<p>${esc(i.label)}：${i.width||'?'} × ${i.height||'?'}</p>`).join('')}${r.errors.map(x=>`<p class="error-line">阻断：${esc(x)}</p>`).join('')}${r.warnings.map(x=>`<p>建议：${esc(x)}</p>`).join('')}${r.contentCheck?`<p>最近内容检查：${r.contentCheck.stale?'已过期':'对应当前文案'}</p>${(r.contentCheck.result?.issues||[]).map(x=>`<p>建议：${esc(x.suggestion)}</p>`).join('')}`:''}${r.unverified.map(x=>`<p class="muted">${esc(x)}</p>`).join('')}</section>`:''}`;
 root.oninput=e=>{if(e.target.name==='draftTime'){v.time=e.target.value;v.revision++;}if(e.target.name==='draftNote'){v.noteId=e.target.value;v.report=null;v.revision++;draw();}};
 root.onclick=async e=>{const b=e.target.closest('[data-draft]');if(!b)return;e.stopPropagation();
 if(b.dataset.draft==='preview')return go('copywriting',{id:v.noteId,preview:true});
 if(b.dataset.draft==='check')return run(async()=>{const r=await api('POST',`/api/schedule/check?${query}`,{noteId:v.noteId});return ()=>{v.report=r;};});
 if(b.dataset.draft==='cancel'&&item)return run(async()=>{const result=await api('POST',`/api/schedule/draft/cancel?${query}`,{id:item.id});return ()=>{Object.assign(item,result);toast('演示草案已取消，文案和素材保留');};});
 };
 root.onsubmit=e=>{e.preventDefault();e.stopPropagation();const payload={...(item?{id:item.id}:{noteId:v.noteId}),publishAt:null,fingerprint:v.report?.fingerprint};try{payload.publishAt=draftTime(v.time);}catch(err){return toast(err.message);}return run(async()=>{const result=await api('POST',`/api/schedule/draft?${query}`,payload);return ()=>{const old=items.find(x=>x.id===result.id);if(old)Object.assign(old,result);else items.push(result);toast('草案已保存，不会执行发布');};});};
 };
 v.refresh=()=>{if(current()){draw();root.dispatchEvent(new CustomEvent('draft-updated',{bubbles:true}));}};
 const run=async fn=>{if(v.busy)return;const rev=v.revision;v.busy=true;draw();try{const apply=await fn();if(current()&&rev===v.revision)apply();}catch(e){if(current()&&rev===v.revision){v.report=null;toast(e.message);}}finally{v.busy=false;v.refresh?.();}};
 draw();
}
