// 图片任务自动进度：只读取记录或查询已有任务编号，绝不提交新的生图（不会重复计费）。
// - 刚提交、还没有任务编号：只重新读取记录（服务端稍后会写入编号）。刷新接口会把这种任务标成“结果不确定”，所以不能对它调用。
// - 已有任务编号：调用只读的刷新接口，完成后服务端会下载图片。
// - 用户正在文本框里输入时只更新数据、不重绘，避免打断输入；停止输入后的下一轮再重绘；最多推迟 20 秒，之后无论如何重绘（输入内容保存在表单状态里，不会丢）。
// - 没有进行中的任务时只在本地检查，不发网络请求；页面离开后自动停止。
const ACTIVE = ['submitting', 'submitted', 'processing'];
const GIVE_UP_AFTER = 30 * 60 * 1000; // 超过 30 分钟的任务不再自动查询，仍可手动点“查询进度”

export function startImagePolling({ current, jobs, paused = () => false, focused = () => false, refresh, load, draw, now = Date.now, setTimer = typeof setTimeout === 'function' ? setTimeout : null, clearTimer = typeof clearTimeout === 'function' ? clearTimeout : () => {} }) {
  if (!setTimer) return () => {}; // 没有定时器的环境（例如测试沙箱）不轮询
  let stopped = false;
  let timer;
  let dirty = false;
  let deferredSince = 0;
  const schedule = (ms) => { if (!stopped && current()) timer = setTimer(tick, ms); };
  const age = (j) => now() - new Date(j.createdAt || now()).getTime();
  // 前 2 分钟每 4 秒查一次，之后每 10 秒；出错退避到 30 秒
  const delay = (failed, pending) => (failed ? 30000 : pending.some((j) => age(j) < 120000) ? 4000 : 10000);

  async function tick() {
    if (stopped || !current()) return;
    let failed = false;
    let pending = [];
    try {
      pending = jobs().filter((j) => j.provider === 'apimart' && ACTIVE.includes(j.status) && age(j) < GIVE_UP_AFTER);
      if (pending.length && !paused()) {
        for (const j of pending) {
          if (stopped || !current()) break;
          if (j.taskId) {
            const r = await refresh(j.id);
            if (r && r.error && ACTIVE.includes(r.status)) failed = true;
          }
        }
        if (!stopped && current()) {
          await load();
          dirty = true;
        }
      }
      if (dirty && !stopped && current() && !paused()) {
        if (!focused()) deferredSince = 0;
        else if (!deferredSince) deferredSince = now();
        if (!deferredSince || now() - deferredSince > 20000) {
          dirty = false;
          deferredSince = 0;
          draw();
        }
      }
    } catch {
      failed = true;
    } finally {
      schedule(pending.length || dirty ? delay(failed, pending) : 4000);
    }
  }
  schedule(1500);
  return () => { stopped = true; clearTimer(timer); };
}
