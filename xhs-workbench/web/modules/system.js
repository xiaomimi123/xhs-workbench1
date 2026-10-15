// 「连接与设置」页下半部分：自动运行（开机自启 / 防休眠）、备份与恢复、回收站
import { esc } from '../md.js';
import { S, api, toast, fmtTime, opt, withBusy } from '../core.js';

const KEEP_AWAKE = [
  ['off', '不阻止休眠'],
  ['auto', '有定时任务时保持唤醒（推荐）'],
  ['always', '工作台运行期间一直保持唤醒'],
];

function size(n) {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

export async function renderSystem(box) {
  if (!box) return;
  let sys, backups, trash;
  try {
    [sys, backups, trash] = await Promise.all([api('GET', '/api/system'), api('GET', '/api/backups'), api('GET', '/api/trash')]);
  } catch (err) {
    box.innerHTML = `<div class="card muted">${esc(err.message)}</div>`;
    return;
  }
  const platformName = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[sys.autostart.platform] || sys.autostart.platform;
  box.innerHTML = `
    <div class="card" style="max-width:760px;margin-top:16px">
      <h3 style="margin-top:0">自动运行</h3>
      <p class="muted" style="margin-top:0;font-size:13px">定时发布、定时检查评论、每日抓数据都要求工作台在运行、电脑没有休眠。</p>
      <dl class="kv">
        <dt>开机自启</dt>
        <dd><label class="row" style="gap:6px"><input type="checkbox" data-sys="autostart"${sys.autostart.enabled ? ' checked' : ''}> 登录电脑后自动在后台运行工作台（${esc(platformName)}）</label></dd>
        <dt>防休眠</dt>
        <dd><select data-sys="keepAwake">${KEEP_AWAKE.map(([v, n]) => opt(v, n, sys.keepAwake.mode)).join('')}</select>
          <span class="muted" style="font-size:12px">${sys.keepAwake.active ? '当前：保持唤醒中' : '当前：未阻止休眠'}</span></dd>
      </dl>
      <p class="muted" style="font-size:12px;margin-bottom:0">笔记本合上盖子仍会休眠（接电源并外接显示器除外）；防休眠只阻止「闲置自动休眠」。</p>
    </div>

    <div class="card" style="max-width:760px;margin-top:16px">
      <div class="row"><h3 style="margin:0">备份与恢复</h3><div class="spacer"></div>
        <select data-sys="autoBackup">${opt('daily', '每天自动备份（保留 7 份）', backups.autoBackup)}${opt('off', '不自动备份', backups.autoBackup)}</select>
        <button class="btn small primary" data-sys-act="backup">立即备份</button>
      </div>
      <p class="muted" style="font-size:13px">备份包含账号、笔记（含配图）、选题、对标、数据、知识库和对话；不包含浏览器登录资料。文件保存在数据目录的 backups/ 里，也可以下载后放到网盘。</p>
      ${backups.items.length ? `<div class="trash-list">${backups.items.map((b) => `<div class="row">
          <span>${esc(b.name)}</span><span class="muted" style="font-size:12px">${fmtTime(b.createdAt)} · ${size(b.size)}</span><div class="spacer"></div>
          <a class="btn small" href="/api/backup/download?name=${encodeURIComponent(b.name)}&t=${encodeURIComponent(S.token)}">下载</a>
          <button class="btn small ghost" data-sys-act="restore" data-name="${esc(b.name)}">恢复到这个备份</button>
        </div>`).join('')}</div>` : '<div class="muted">还没有备份。</div>'}
    </div>

    <div class="card" style="max-width:760px;margin-top:16px">
      <h3 style="margin-top:0">回收站</h3>
      <p class="muted" style="margin-top:0;font-size:13px">工作台里删除的内容都在这里，可以恢复到原来的位置（原位置已有同名内容时会加「-恢复」后缀）。</p>
      ${trash.items.length ? `<div class="trash-list">${trash.items.slice(0, 100).map((t) => `<div class="row">
          <span>${esc(t.label)}</span>
          <span class="muted" style="font-size:12px">${fmtTime(t.deletedAt)}${t.account && S.accounts.accounts.length > 1 ? ` · ${esc((S.accounts.accounts.find((a) => a.id === t.account) || {}).name || t.account)}` : ''}</span>
          <div class="spacer"></div>
          ${t.restorable ? `<button class="btn small" data-sys-act="untrash" data-id="${esc(t.id)}">恢复</button>` : '<span class="muted" style="font-size:12px">文件已不在</span>'}
        </div>`).join('')}</div>${trash.items.length > 100 ? `<div class="muted" style="font-size:12px">只显示最近 100 项。</div>` : ''}` : '<div class="muted">回收站是空的。</div>'}
    </div>`;

  box.onchange = async (e) => {
    const key = e.target.dataset.sys;
    if (!key) return;
    try {
      if (key === 'autostart') await api('POST', '/api/system', { autostart: e.target.checked });
      if (key === 'keepAwake') await api('POST', '/api/system', { keepAwake: e.target.value });
      if (key === 'autoBackup') await api('POST', '/api/backups/settings', { autoBackup: e.target.value });
      toast('已保存');
    } catch (err) {
      toast(err.message);
    }
    renderSystem(box);
  };

  box.onclick = async (e) => {
    const t = e.target.closest('[data-sys-act]');
    if (!t) return;
    switch (t.dataset.sysAct) {
      case 'backup':
        return withBusy(t, '备份中…', async () => {
          const b = await api('POST', '/api/backups');
          toast(`备份完成：${b.files} 个文件，${size(b.size)}`);
          renderSystem(box);
        });
      case 'restore':
        if (!confirm(`恢复到「${t.dataset.name}」？\n\n当前的账号、笔记、知识库和对话会先整体移到回收站（可以撤销），然后换成备份里的内容。本机的 agent 连接设置会保留。`)) return;
        return withBusy(t, '恢复中…', async () => {
          const r = await api('POST', '/api/backups/restore', { name: t.dataset.name });
          toast(`已恢复 ${r.restored} 个文件`);
          setTimeout(() => location.reload(), 800);
        });
      case 'untrash':
        return withBusy(t, '恢复中…', async () => {
          const r = await api('POST', '/api/trash/restore', { id: t.dataset.id });
          toast(`已恢复到 ${r.restoredTo}`);
          renderSystem(box);
        });
    }
  };
}

