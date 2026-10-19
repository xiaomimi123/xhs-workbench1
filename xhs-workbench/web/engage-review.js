import {api,S,toast,opt} from './core.js';
import {esc} from './md.js';
const states=new Map();
export function reviewState(a){if(!states.has(a))states.set(a,{selected:new Set(),buffers:new Map(),type:'all',status:'all',note:'all',jobId:null,busy:false});return states.get(a);}
export const reviewBusy=()=>reviewState(S.accountId).busy;
export function editBuffer(a,key,record,value){const v=reviewState(a),old=v.buffers.get(key);v.buffers.set(key,{text:value,version:old?.version||record.version,revision:(old?.revision||0)+1});}
export function savedBuffer(a,key,revision,version){const v=reviewState(a),b=v.buffers.get(key);if(!b)return;if(b.revision===revision)v.buffers.delete(key);else b.version=version;}
export function rebaseBuffer(a,key,previous,next){const b=reviewState(a).buffers.get(key);if(b?.version===previous)b.version=next;}
const statuses={new:'新消息',drafted:'历史草稿',approved:'历史已确认',sent:'已回复',ignored:'已忽略',failed:'历史失败'};
export function renderEngageReview(root,data,refresh){
 const account=S.accountId,v=reviewState(account),query=`account=${encodeURIComponent(account)}`;
 const current=()=>root.isConnected&&S.accountId===account&&S.view==='engage';
 const draw=()=>{
  if(!current())return;
  const visible=data.items.filter(x=>(v.type==='all'||x.type===v.type)&&(v.status==='all'||x.status===v.status)&&(v.note==='all'||(x.noteUrl||'none')===v.note));
  const job=data.jobs.find(j=>j.id===v.jobId)||data.jobs[0],notes=[...new Map(data.items.filter(x=>x.noteUrl).map(x=>[x.noteUrl,x.noteTitle||x.noteUrl])).entries()];
  root.innerHTML=`<h3>历史消息整理与本地审核</h3><p class="muted">只保存独立草稿和审核记录，不修改历史状态，不进入发送队列。私信仅使用现有预览，不打开会话。</p>
  <div class="row"><label>消息类型 <select name="localType">${opt('all','全部类型',v.type)}${opt('comment','评论',v.type)}${opt('dm','私信预览',v.type)}</select></label><label>历史状态 <select name="localStatus">${opt('all','全部状态',v.status)}${Object.entries(statuses).map(([k,n])=>opt(k,n,v.status)).join('')}</select></label><label>来源笔记 <select name="localNote">${opt('all','全部笔记',v.note)}${opt('none','无来源笔记',v.note)}${notes.map(([k,n])=>opt(k,n,v.note)).join('')}</select></label></div>
  ${visible.map(x=>`<div class="card" style="margin:8px 0"><label><input type="checkbox" data-local-select="${esc(x.id)}" ${v.selected.has(x.id)?'checked':''}> ${esc(x.user||'匿名')} · ${x.type==='dm'?'私信预览':'评论'} · ${esc(statuses[x.status]||x.status)}</label><p>${esc(x.content)}</p><small class="muted">${esc(x.noteTitle||'无关联笔记')} · ${esc(x.time||'时间未知')}${x.duplicateCount>1?` · ${x.duplicateCount} 条相同候选，仅提示不删除`:''}</small>${x.incomplete?'<p class="muted">内容不完整：仅历史私信预览，需本人核对完整会话。</p>':''}</div>`).join('')||'<p class="muted">没有符合筛选的历史消息。</p>'}
  <div class="row"><button class="btn" data-local-act="select-visible">选中当前筛选</button><button class="btn" data-local-act="clear">清空选择</button><button class="btn primary" data-local-act="generate" ${!v.selected.size||v.busy?'disabled':''}>整理并生成回复草稿（${v.selected.size} 条）</button></div>
  ${data.jobs.length?`<hr><label>本地审核任务 <select name="localJob">${data.jobs.map(j=>opt(j.id,`${j.createdAt} · ${j.itemIds.length} 条 · ${{queued:'排队中',running:'处理中',done:'已完成',error:'失败'}[j.status]}`,job.id)).join('')}</select></label>`:''}
  ${job?`<p>${esc(job.error||job.progress||'排队等待')} ${job.status==='error'?'<button class="btn" data-local-act="retry">重试任务</button>':''}</p>`:''}
  ${(job?.reviews||[]).map(r=>{
   const key=`${job.id}:${r.itemId}`,buffer=v.buffers.get(key),value=buffer?.text??r.draft,confirmed=r.status==='confirmed_local'&&!r.sourceStale&&!buffer;
   return `<div class="card" data-local-record="${esc(r.itemId)}" style="margin:12px 0"><strong>${esc(r.source.user||'匿名')} · ${esc(r.category)}</strong><p>${esc(r.source.content)}</p><p class="muted">原状态：${esc(statuses[r.source.status]||r.source.status)} · ${r.incomplete?'私信预览不完整':'历史评论'} · 建议：${{reply:'可起草回复',human:'需要本人处理',ignore:'可不回复'}[r.action]}</p><p>${esc(r.reason)}</p>${r.context?`<p class="muted">关联笔记：${esc(r.context.title)}（按 URL 匹配；仅标题与历史指标，非全文）</p>`:''}${r.unverified.map(s=>`<p class="muted">待核实：${esc(s)}</p>`).join('')}
   <textarea data-local-draft="${esc(r.itemId)}" rows="3" maxlength="500" aria-label="本地回复草稿 ${esc(r.source.user||r.itemId)}">${esc(value)}</textarea>
   <p data-local-label="${esc(r.itemId)}">${buffer?'有未保存修改，保存后撤销旧确认':r.sourceStale?'原消息已变化，旧确认失效，请重新整理':confirmed?'本地已确认 · 不发送':'草稿待审核 · 不发送'}</p>${r.lint.map(i=>`<p class="error-line">表达提示：${esc(i.word)} · ${esc(i.tip)}</p>`).join('')}
   <div class="row"><button class="btn" data-local-act="save" data-local-id="${esc(r.itemId)}" ${!buffer||v.busy?'disabled':''}>保存草稿</button><button class="btn primary" data-local-act="confirm" data-local-id="${esc(r.itemId)}" ${buffer||!r.draft||r.sourceStale||confirmed||v.busy?'disabled':''}>本地确认（不发送）</button><button class="btn" data-local-act="revoke" data-local-id="${esc(r.itemId)}" ${r.status!=='confirmed_local'||v.busy?'disabled':''}>撤回确认</button></div><small class="muted">版本 ${r.revision} · 已保留 ${r.history.length} 条编辑/审核记录</small></div>`;
  }).join('')}`;
  root.oninput=e=>{const id=e.target.dataset.localDraft;if(!id)return;e.stopPropagation();const r=job.reviews.find(r=>r.itemId===id);editBuffer(account,`${job.id}:${id}`,r,e.target.value);const card=e.target.closest('[data-local-record]');card.querySelector('[data-local-act="save"]').disabled=false;card.querySelector('[data-local-act="confirm"]').disabled=true;card.querySelector('[data-local-label]').textContent='有未保存修改，保存后撤销旧确认';};
  root.onchange=e=>{e.stopPropagation();const id=e.target.dataset.localSelect;if(id){if(e.target.checked)v.selected.add(id);else v.selected.delete(id);draw();return;}const field={localType:'type',localStatus:'status',localNote:'note',localJob:'jobId'}[e.target.name];if(field){v[field]=e.target.value;draw();}};
  root.onclick=async e=>{
   const b=e.target.closest('[data-local-act]');if(!b)return;e.stopPropagation();if(v.busy)return;const action=b.dataset.localAct;
   if(action==='select-visible'){visible.forEach(x=>v.selected.add(x.id));return draw();}if(action==='clear'){v.selected.clear();return draw();}
   const r=job?.reviews?.find(r=>r.itemId===b.dataset.localId),key=r?`${job.id}:${r.itemId}`:null,buffer=v.buffers.get(key),revision=buffer?.revision;
   v.busy=true;root.querySelectorAll('button[data-local-act]').forEach(b=>b.disabled=true);
   try{
    if(action==='generate'||action==='retry'){
     const result=await api('POST',`/api/engage/review${action==='retry'?'/retry':''}?${query}`,action==='retry'?{id:job.id}:{itemIds:[...v.selected]});if(current())v.jobId=result.id;
    }else if(r){
     if(action==='save'&&!buffer)return;
     const payload={jobId:job.id,itemId:r.itemId,version:buffer?.version||r.version,...(action==='save'?{draft:buffer.text}:{})};
     const result=await api('POST',`/api/engage/review/${action==='save'?'edit':action}?${query}`,payload);
     if(action==='save')savedBuffer(account,key,revision,result.version);
     else rebaseBuffer(account,key,payload.version,result.version);
     if(current())toast(action==='save'?'本地草稿已保存，旧确认已撤销':action==='confirm'?'仅本地确认，未发送':'本地确认已撤回，草稿保留');
    }
   }catch(err){if(current())toast(err.message);}finally{v.busy=false;v.refresh?.();}
  };
 };
 v.refresh=()=>{if(current())refresh();};draw();
}
