import {renderLivePhotos} from '../live-photos.js';
import * as coverEditor from './cover.js';
import {mountCreation} from '../image-workspace.js';
import {S,api,go} from '../core.js';
import {esc} from '../md.js';
export const autoRender=coverEditor.autoRender;
let editor=false,serial=0;
export function canLeave(){return !editor||coverEditor.canLeave();}
export async function onContent(ev){if(editor)return coverEditor.onContent(ev);}
export async function render(main,params={}){
 const account=S.accountId,run=++serial;editor=!!params.editor;
 if(params.live){await renderLivePhotos(main);return;}
 if(editor){await coverEditor.render(main,{...params,editorOnly:true});return;}
 const entry=['free','reference','note'].includes(params.entry)?params.entry:params.id?'note':'free';
 main.innerHTML='<div class="empty">加载图片创作…</div>';
 const current=()=>run===serial&&S.accountId===account&&S.view==='cover';
 try{
  const {items:notes}=await api('GET',`/api/notes?account=${encodeURIComponent(account)}`);
  if(!current())return;
  const usable=notes.filter(n=>n.status!=='published'&&!n.video);
  const id=usable.some(n=>n.id===params.id)?params.id:entry==='note'?usable[0]?.id:null;
  const note=entry==='note'&&id?await api('GET',`/api/notes/detail?account=${encodeURIComponent(account)}&id=${encodeURIComponent(id)}`):null;
  if(!current())return;
  main.innerHTML=`<div class="page-head"><h1 class="page-title">图片创作</h1><p class="muted">从想法、参考图或文案出发，制作完整海报和可编辑封面。</p></div><button class="btn" data-live-list>实况照片制作记录</button><div class="row creation-tabs">${[['free','自由生图'],['reference','参考图复刻'],['note','根据文案配图']].map(([key,label])=>`<button class="btn ${entry===key?'primary':''}" data-entry="${key}">${label}</button>`).join('')}</div>${entry==='note'?`<div class="card row"><label>文案草稿 <select data-source-note>${usable.map(n=>`<option value="${esc(n.id)}" ${id===n.id?'selected':''}>${esc(n.title||'未命名')}</option>`).join('')}</select></label>${note?'<button class="btn" data-editor>打开封面文字排版</button>':'<span>还没有可用草稿，请先在文案模块保存一篇。</span>'}</div>`:''}<div id="creation-root"></div>`;
  main.querySelector('[data-live-list]').onclick=()=>go('cover',{live:true});
  main.querySelectorAll('[data-entry]').forEach(b=>b.onclick=()=>go('cover',{entry:b.dataset.entry,...(params.id?{id:params.id}:{})}));
  const select=main.querySelector('[data-source-note]');if(select)select.onchange=()=>go('cover',{entry:'note',id:select.value});
  const edit=main.querySelector('[data-editor]');if(edit)edit.onclick=()=>go('cover',{id,editor:true});
  if(entry!=='note'||note)await mountCreation(main.querySelector('#creation-root'),{entry,note,notes:usable});
 }catch(e){if(current())main.textContent=e.message;}
}
