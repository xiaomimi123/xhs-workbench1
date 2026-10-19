import {api,S,go,toast,opt} from './core.js';
import {esc} from './md.js';
const states=new Map();
const labels={views:'阅读',likes:'点赞',collects:'收藏',comments:'评论',shares:'分享',follows:'涨粉'};
export function renderReview(root,data,refresh){
 const account=S.accountId;let v=states.get(account);if(!v){v={sourceId:'account',jobId:null};states.set(account,v);}
 const current=()=>root.isConnected&&S.accountId===account&&S.view==='analytics';
 const query=`account=${encodeURIComponent(account)}`;
 const draw=()=>{
 if(!current())return;
 const d=data.datasets.find(d=>d.sourceId===v.sourceId)||data.datasets[0];if(!d)return;
 const jobs=data.jobs.filter(j=>j.sourceId===d.sourceId),job=jobs.find(j=>j.id===v.jobId)||jobs[0],r=job?.result;
 const references=ids=>(ids||[]).map(id=>{const n=[...job.dataset.rows,...(job.dataset.accountDays||[])].find(n=>n.id===id);return n?`<small class="muted">证据：${esc(n.title)} · ${esc(n.observedAt||'观察时间未知')}</small>`:'';}).join('<br>');
 root.innerHTML=`<h3>有依据的复盘 → 下一轮选题</h3><div class="row"><label>复盘来源 <select name="reviewSource">${data.datasets.map(x=>opt(x.sourceId,`${x.kind==='account'?'账号历史':'对标观察'} · ${x.name}`,d.sourceId)).join('')}</select></label><button class="btn primary" data-review="generate" ${v.busy||(!d.rows.length&&!d.accountDays?.length)?'disabled':''}>生成复盘报告</button><button class="btn" data-review="topics">打开选题池</button></div>
 <p>${d.kind==='account'?'本账号历史表现':'对标观察，不属于本账号业绩'} · ${d.rows.length} 篇${d.accountDays?.length?` · ${d.accountDays.length} 天账号记录`:''} · 资料更新：${esc(d.updatedAt||'未知')}</p>
 <div class="row">${Object.entries(d.coverage).map(([key,c])=>`<span class="badge">${labels[key]} ${c.value??'未知'} · 覆盖 ${c.known}/${c.total}</span>`).join('')}</div>
 ${d.limitations.map(s=>`<p class="muted">${esc(s)}</p>`).join('')}
 ${job?`<hr><label>复盘记录 <select name="reviewJob">${jobs.map(j=>opt(j.id,`${j.createdAt} · ${{queued:'排队中',running:'处理中',done:'已完成',error:'失败'}[j.status]}`,job.id)).join('')}</select></label><p>${esc(job.progress||job.status)} ${esc(job.error||'')}${job.status==='error'?'<button class="btn small" data-review="retry">重试复盘</button>':''}</p>`:''}
 ${r&&job.status==='done'?`<h4>${job.kind==='account'?'账号历史复盘':'对标观察复盘'}</h4><p>${esc(r.summary)}</p><h4>观察（按报告生成时的快照）</h4>${r.observations.map(o=>`<p>${esc(o.text)}<br>${references(o.sourceIds)}</p>`).join('')}<h4>待验证假设</h4>${r.hypotheses.map(s=>`<p>${esc(s)}</p>`).join('')}<h4>下一步实验</h4>${r.experiments.map(s=>`<p>${esc(s)}</p>`).join('')}<h4>选题建议</h4>${r.suggestions.map((s,i)=>`<div class="card" style="margin:8px 0"><strong>${esc(s.title)}</strong><p>${esc(s.angle)}</p><p class="muted">${esc(s.reason)}</p>${references(s.sourceIds)}<div class="row"><button class="btn" data-review="add" data-index="${i}" ${v.busy?'disabled':''}>加入选题池</button><button class="btn" data-review="write" data-index="${i}" ${v.busy?'disabled':''}>写成新草稿</button></div></div>`).join('')}`:''}`;
 root.onchange=e=>{e.stopPropagation();if(e.target.name==='reviewSource'){v.sourceId=e.target.value;v.jobId=null;draw();}if(e.target.name==='reviewJob'){v.jobId=e.target.value;draw();}};
 root.onclick=async e=>{const button=e.target.closest('[data-review]');if(!button)return;e.stopPropagation();if(v.busy)return;const action=button.dataset.review;if(action==='topics')return go('topics');const selected=d.sourceId;
 v.busy=true;draw();try{
  if(action==='generate'||action==='retry'){
   const result=await api('POST',`/api/analytics/${action==='retry'?'review/retry':'review'}?${query}`,action==='retry'?{id:job.id}:{sourceId:selected});
   if(current()&&v.sourceId===selected)v.jobId=result.id;
  }else{
   const topic=await api('POST',`/api/analytics/review/topic?${query}`,{id:job.id,index:Number(button.dataset.index)});
   if(action==='write'){
    const task=await api('POST',`/api/topics/write?${query}`,{topicId:topic.id});
    if(current()){toast(task.status==='done'?'现有验证草稿已保留':'写稿任务已提交，可在选题池查看');go('topics');}
   }else if(current())toast('已加入选题池，重复点击不会重复创建');
  }
 }catch(err){if(current())toast(err.message);}finally{v.busy=false;v.refresh?.();}
 };
 };
 v.refresh=()=>{if(current())refresh();};draw();
}
