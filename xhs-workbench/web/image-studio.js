import {initializeImageService,imageServiceFields,imageJobStatus,imageJobProgress,imageSendNotice,elapsedLabel,hubRefsAllowed,hubRefsText} from './image-service-settings.js';
import {esc} from './md.js';
import {startImagePolling} from './image-polling.js';
import {S,api,fileUrl,toast} from './core.js';
const forms=new Map();let stopPolling=null;
export function imageForm(account,noteId){const key=JSON.stringify([account,noteId]);if(!forms.has(key))forms.set(key,{prompt:'',count:1,references:[],busy:false});return forms.get(key);}
export function imageBusy(account,noteId){return imageForm(account,noteId).busy;}
export async function mountImageStudio(root,note,onApply){
 const account=S.accountId,query=`account=${encodeURIComponent(account)}`,v=imageForm(account,note.id);
 const current=()=>root.isConnected&&S.accountId===account&&S.view==='cover';
 root.innerHTML='<div class="muted">加载生图任务…</div>';
 let jobs=[];try{const results=await Promise.all([api('GET',`/api/images/jobs?${query}&noteId=${encodeURIComponent(note.id)}`),api('GET','/api/images/service')]);jobs=results[0].items;initializeImageService(v,results[1]);}catch(e){if(current())root.textContent=e.message;return;}if(!current())return;
 function draw(){
 root.innerHTML=`<h3>AI 生图与参考图生成</h3><p class="muted">${v.provider==='hub'?'用公司中枢配置的出图通道生成底图，完成后可套用封面。':v.provider==='apimart'?'使用 APIMart 生成底图，完成后可套用封面。':'交给当前 Agent 使用真实生图工具。此入口保存交接任务，不会直接调用本聊天工具；生成后检查图片，选中再套用封面。'}</p>
 ${imageServiceFields(v,'data-image-field')}
 <label class="field-label">画面要求</label><textarea data-image-prompt rows="3" placeholder="描述主体、场景、风格；底图留出标题空间">${esc(v.prompt)}</textarea>
 <div class="row"><label>候选数量 <select data-image-count>${[1,2,3].map(n=>`<option ${v.provider==='apimart'&&n>1?'disabled':''} ${n===v.count?'selected':''}>${n}</option>`).join('')}</select></label><label class="btn small">上传参考图<input type="file" accept="image/png,image/jpeg,image/webp" data-image-upload hidden></label></div>
 <p class="muted">参考图最多3张；不选则文字生图。${v.provider==='hub'?hubRefsText(v):`选中的图片会交给${v.provider==='apimart'?'第三方 APIMart':' Agent 生图工具'}处理。`}</p>
 <div class="option-grid">${note.images.map(f=>`<label class="option"><img style="width:100%;height:90px;object-fit:cover" src="${fileUrl(`notes/${note.id}/images/${f}`)}"><input type="checkbox" data-image-ref="${esc(f)}" ${v.references.includes(f)?'checked':''}>${esc(f)}</label>`).join('')}</div>
 ${imageSendNotice(v.provider,v.references.length,true)}
 <div class="row"><button class="btn primary" data-image-action="start" ${v.busy?'disabled':''}>创建生图任务</button><button class="btn" data-image-action="round" ${v.busy?'disabled':''}>按当前要求新生成一轮</button></div>
 ${jobs.slice(0,8).map(j=>`<div class="card" style="margin-top:12px"><strong>${j.kind==='reference'?'参考图生成':'文字生图'} · ${esc(imageJobStatus(j))}${j.stale?' · 文案已修改':''}</strong><p>${esc(j.prompt)}</p><p class="muted">${esc(j.error||'底图与可编辑封面文字分开保存')}</p>
 ${imageJobProgress(j,'data-image-action',v.busy)}${j.provider==='current-agent'&&j.status!=='done'?`<details><summary>当前 Agent 交接指令</summary><textarea readonly rows="5">${esc(j.handoff)}</textarea></details><button class="btn small" data-image-action="copy" data-job="${j.id}">复制交接指令</button><button class="btn small" data-image-action="complete" data-job="${j.id}" ${v.busy?'disabled':''}>检查生成结果</button>`:''}
 <div class="option-grid">${j.assets.map(x=>`<div class="option"><img src="${fileUrl(x.path,x.hash)}" style="width:100%" alt="生图候选${x.index+1}"><p>${x.width} × ${x.height}</p><button class="btn small" data-image-action="apply" data-job="${j.id}" data-index="${x.index}" ${j.stale||v.busy?'disabled':''}>套用底图并编辑标题</button></div>`).join('')}</div></div>`).join('')}`;
 }
 draw();
 stopPolling?.();stopPolling=startImagePolling({root,formatElapsed:elapsedLabel,current,jobs:()=>jobs,paused:()=>v.busy,focused:()=>typeof document!=='undefined'&&!!document.activeElement&&root.contains?.(document.activeElement)&&(document.activeElement.tagName==='TEXTAREA'||(document.activeElement.tagName==='INPUT'&&/^(text|search|)$/.test(document.activeElement.type||''))),refresh:id=>api('POST',`/api/images/refresh?${query}`,{id}),load:async()=>{jobs=(await api('GET',`/api/images/jobs?${query}&noteId=${encodeURIComponent(note.id)}`)).items;},draw});
 root.oninput=e=>{if(e.target.matches('[data-image-prompt]'))v.prompt=e.target.value;};
 root.onchange=async e=>{
  if(e.target.dataset.imageField){v[e.target.dataset.imageField]=e.target.value;if(v.provider==='apimart')v.count=1;draw();}
  if(e.target.matches('[data-image-count]'))v.count=Number(e.target.value);
  if(e.target.dataset.imageRef){const f=e.target.dataset.imageRef;v.references=e.target.checked?[...new Set([...v.references,f])]:v.references.filter(x=>x!==f);if(v.references.length>3){v.references=v.references.filter(x=>x!==f);e.target.checked=false;toast('参考图最多3张');}}
  if(e.target.matches('[data-image-upload]')){const file=e.target.files[0];if(!file)return;if(file.size>20*1024*1024){toast('参考图不能超过20MB');return;}v.busy=true;try{const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file);});const r=await api('POST',`/api/notes/upload?${query}`,{id:note.id,filename:file.name,data});if(current()){note.images.push(r.name);if(v.references.length<3)v.references.push(r.name);draw();}}catch(e){toast(e.message);}finally{v.busy=false;if(current())draw();}}
 };
 root.onclick=async e=>{const b=e.target.closest('[data-image-action]');if(!b)return;e.stopPropagation();const action=b.dataset.imageAction;if(action==='copy'){try{await navigator.clipboard.writeText(jobs.find(j=>j.id===b.dataset.job).handoff);toast('交接指令已复制，发给当前 Agent 即可');}catch{toast('请展开交接指令，手动复制');}return;}if(v.busy)return;v.busy=true;draw();
 try{if(action==='start'||action==='round'){await api('POST',`/api/images/start?${query}`,{noteId:note.id,prompt:v.prompt,count:v.provider==='apimart'?1:v.count,provider:v.provider,model:v.model,size:v.size,resolution:v.resolution,references:v.provider==='hub'&&!hubRefsAllowed(v)?[]:v.references,newRound:action==='round'});toast(v.provider!=='current-agent'?'任务已提交，可查询进度':'任务已保存，请将交接指令交给当前 Agent');}
 else if(action==='query')await api('POST',`/api/images/refresh?${query}`,{id:b.dataset.job});
 else if(action==='complete')await api('POST',`/api/images/complete?${query}`,{id:b.dataset.job});
 else if(action==='apply'){const result=await api('POST',`/api/images/apply?${query}`,{id:b.dataset.job,index:Number(b.dataset.index)});if(current())onApply(result);return;}
 if(current())jobs=(await api('GET',`/api/images/jobs?${query}&noteId=${encodeURIComponent(note.id)}`)).items;
 }catch(err){toast(err.message);}finally{v.busy=false;if(current())draw();}
 };
}
