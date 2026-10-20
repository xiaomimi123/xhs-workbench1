import {mountPhoneTransfer} from './live-transfer.js';
import {S,api,go,fileUrl,toast} from './core.js';
import {esc} from './md.js';
let serial=0;
export async function renderLivePhotos(main){
 const run=++serial,account=S.accountId,q=`account=${encodeURIComponent(account)}`;let busy=false,timer;
 const current=()=>run===serial&&S.accountId===account&&S.view==='cover'&&main.querySelector('[data-live-root]');
 main.innerHTML='<div data-live-root><h1>实况照片</h1><p>加载中…</p></div>';
 async function load(){const {items}=await api('GET',`/api/live/jobs?${q}`);if(!current())return;
 main.innerHTML=`<div data-live-root><div class="page-head row"><h1>实况照片</h1><button class="btn" data-live-back>返回图片创作</button></div><p class="muted">原图保留。三秒无声轻微推近回位，照片与视频成对保存。</p><details class="card"><summary>备用：通过 Mac 相册导入</summary><ol><li>下载配对包并解压，把 LIVE.JPG 和 LIVE.MOV 一起导入 Mac「照片」。确认显示 LIVE 且能播放。</li><li>从 Mac「照片」通过 AirDrop 或已启用的 iCloud 照片传到 iPhone；在 iPhone「照片」确认 LIVE 并长按播放。</li><li>在小红书新建笔记，选择这张实况照片，检查实况标识和动态预览。停在编辑页，不点发布。</li></ol><p class="muted">ZIP 是备份传输包；单独保存 JPG 或 MP4 不会成为实况。工作台里的视频只是动态预览，不能代替手机识别验收。</p></details>
 ${items.map(j=>`<article class="card live-card"><h2>${esc(j.title)}</h2><p>${{running:'正在制作并校验…',done:'本地实况文件已完成',error:'制作未完成'}[j.status]}</p>${j.error?`<p>${esc(j.error)}</p><button class="btn" data-live-retry="${j.id}">重新制作</button>`:''}${j.status==='done'?`<div data-live-transfer="${j.id}"></div><div class="live-preview"><img src="${fileUrl(`live-jobs/${j.id}/photo.jpg`)}" alt="实况静态帧"><video controls muted loop playsinline preload="metadata" src="${fileUrl(`live-jobs/${j.id}/preview.mp4`)}" poster="${fileUrl(`live-jobs/${j.id}/photo.jpg`)}"></video></div><p>配对标识与关键帧校验：通过 · Apple 实况加载：通过 · ${j.report.width}×${j.report.height} · ${j.report.duration.toFixed(1)} 秒</p><button class="btn" data-live-retry="${j.id}">重新制作一个版本</button> <a class="btn" href="/api/live/bundle?${q}&id=${encodeURIComponent(j.id)}&t=${encodeURIComponent(S.token)}" download="Live-Photo.zip">下载配对包（JPG＋MOV）</a><div class="row" style="margin-top:12px"><button class="btn" data-live-confirm="${j.id}" data-stage="iphone" data-value="${!j.phone.iphone}">${j.phone.iphone?'撤回 iPhone 确认':'我已在 iPhone 确认 LIVE 并播放'}</button><button class="btn" data-live-confirm="${j.id}" data-stage="xhs" data-value="${!j.phone.xhs}" ${!j.phone.iphone?'disabled':''}>${j.phone.xhs?'撤回小红书确认':'我已在小红书编辑页确认实况'}</button></div><p class="muted">iPhone：${j.phone.iphone?'人工确认通过':'待手机实测'} · 小红书：${j.phone.xhs?'人工确认通过，未发布':'待发布前预览实测'}。以上按钮只记录人工反馈，不会发布。</p>`:''}</article>`).join('')||'<div class="card">还没有实况任务。在已完成的图片候选上点击「制作实况照片」。</div>'}</div>`;
 main.querySelectorAll('[data-live-transfer]').forEach(root=>mountPhoneTransfer(root,root.dataset.liveTransfer));
 main.querySelector('[data-live-back]').onclick=()=>go('cover');
 main.querySelectorAll('[data-live-retry]').forEach(b=>b.onclick=async()=>{if(busy)return;busy=true;b.disabled=true;const j=items.find(x=>x.id===b.dataset.liveRetry);try{await api('POST',`/api/live/start?${q}`,{imageJobId:j.imageJobId,index:j.index,newRound:j.status==='done'});await load();}catch(e){toast(e.message);}finally{busy=false;if(b.isConnected)b.disabled=false;}});
 main.querySelectorAll('[data-live-confirm]').forEach(b=>b.onclick=async()=>{if(busy)return;busy=true;b.disabled=true;try{await api('POST',`/api/live/confirm?${q}`,{id:b.dataset.liveConfirm,stage:b.dataset.stage,confirmed:b.dataset.value==='true'});await load();}catch(e){toast(e.message);}finally{busy=false;if(b.isConnected)b.disabled=false;}});
 clearTimeout(timer);if(items.some(j=>j.status==='running'))timer=setTimeout(()=>{if(current())load().catch(e=>toast(e.message));},2000);
 }
 try{await load();}catch(e){if(current())main.querySelector('[data-live-root]').textContent=e.message;}
}
