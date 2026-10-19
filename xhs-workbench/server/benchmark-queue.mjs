// 持久化采集意图。只登记检查点关联目标或用户批量选中的缺项，不扫描触发全部旧账号。
import fs from 'node:fs';
import path from 'node:path';
import { accountDir } from './paths.mjs';
import { readJson, writeJson } from './store.mjs';
const file = (account) => path.join(accountDir(account), 'benchmarks', 'collection.json');
export function collectionStatus(account) {
  const f = file(account);
  const data = readJson(f, null);
  if (data?.schema === 1 && typeof data.paused === 'boolean' && typeof data.reason === 'string' && Array.isArray(data.items)
    && data.items.every(x => x && /^b_[\w-]+$/.test(x.id) && ['pending', 'running', 'complete', 'partial', 'blocked', 'removed'].includes(x.state) && Number.isInteger(x.attempts))) return data;
  return { schema: 1, paused: fs.existsSync(f), reason: fs.existsSync(f) ? '采集队列损坏，请检查 collection.json' : '', items: [] };
}
export function enqueueCollection(account, ids) {
  const q = collectionStatus(account);
  if (q.reason.includes('队列损坏')) return;
  let changed = false;
  for (const id of ids) {
    if (!/^b_[\w-]+$/.test(id) || q.items.some(x => x.id === id)) continue;
    q.items.push({ id, state: 'pending', attempts: 0, queuedAt: new Date().toISOString() });
    changed = true;
  }
  if (changed) writeJson(file(account), q);
}
export function recordCollectionObservation(account, id) {
  enqueueCollection(account, [id]);
  const q = collectionStatus(account);
  const item = q.items.find(x => x.id === id);
  if (item) { if (item.state === 'complete') item.state = 'pending'; item.observationReceived = true; writeJson(file(account), q); }
}
export function observationComplete(s) {
  return !!(s && s.state === 'complete' && s.avatar && Object.keys(s.profile || {}).length
    && Number.isInteger(s.discoveredCount) && s.attemptedCount >= Math.min(s.discoveredCount, 5)
    && s.notes.length >= Math.min(s.discoveredCount, 5));
}
export class BenchmarkQueue {
  constructor({ accounts, detail, busy, dispatch, changed }) {
    Object.assign(this, { accounts, detail, busy, dispatch, changed });
  }
  save(account, q) { writeJson(file(account), q); this.changed(account); }
  recover() {
    for (const { id } of this.accounts()) {
      const q = collectionStatus(id);
      if (!q.items.some(x => ['pending', 'running'].includes(x.state))) continue;
      for (const item of q.items.filter(x => x.state === 'running')) {
        item.state = 'pending'; delete item.taskId;
      }
      q.paused = true; q.reason = '服务中断，已保存结果保留；准备好登录后整体继续';
      this.save(id, q);
    }
  }
  control(account, action, ids = []) {
    enqueueCollection(account, ids);
    const q = collectionStatus(account);
    if (q.reason.includes('队列损坏')) throw new Error(q.reason);
    if (action === 'pause') { q.paused = true; q.reason = '用户暂停；当前目标结束后停止'; }
    else {
      q.paused = false; q.reason = '';
      for (const item of q.items) {
        if (['blocked', 'partial'].includes(item.state) || action === 'fill' && ids.includes(item.id) && item.state !== 'running') item.state = 'pending';
        if (item.state === 'pending') delete item.observationReceived;
      }
    }
    this.save(account, q);
    return q;
  }
  block(account, reason) {
    const q = collectionStatus(account);
    if (!q.items.some(x => ['pending', 'running'].includes(x.state))) return;
    q.paused = true; q.reason = reason;
    this.save(account, q);
  }
  finish(taskId, error = '') {
    for (const { id: account } of this.accounts()) {
      const q = collectionStatus(account);
      const item = q.items.find(x => x.taskId === taskId && x.state === 'running');
      if (!item) continue;
      let snapshot;
      try { snapshot = this.detail(account, item.id).observation; } catch {}
      item.state = observationComplete(snapshot) ? 'complete' : snapshot ? 'partial' : 'blocked';
      item.reason = item.state === 'complete' ? '' : error || snapshot?.reason || '任务结束但没有完整观察检查点；请检查登录、浏览器能力或检查点冲突后继续';
      item.finishedAt = new Date().toISOString();
      delete item.taskId;
      if (item.state !== 'complete') { q.paused = true; q.reason = item.reason; }
      this.save(account, q);
    }
  }
  tick() {
    for (const { id: account } of this.accounts()) {
      if (this.busy(account)) continue;
      const q = collectionStatus(account);
      if (q.paused || q.items.some(x => x.state === 'running')) continue;
      let dirty = false;
      for (const item of q.items.filter(x => x.state === 'pending')) {
        let snapshot;
        try { snapshot = this.detail(account, item.id).observation; }
        catch { item.state = 'removed'; dirty = true; continue; }
        if (observationComplete(snapshot)) { item.state = 'complete'; item.reason = ''; dirty = true; continue; }
        // agent 在当前轮已做过有证据的尝试，不再另开 worker 重复采集。
        if (snapshot && item.observationReceived) {
          item.state = 'partial'; item.reason = snapshot.reason || '本次观察不完整';
          q.paused = true; q.reason = item.reason; dirty = true; break;
        }
        item.state = 'running'; item.attempts++; item.startedAt = new Date().toISOString();
        item.taskId = `collect_${account}_${item.id}_${Date.now()}`;
        this.save(account, q); // 派发前写意图，崩溃不会无记录重放。
        try { this.dispatch(account, item.id, item.taskId); }
        catch (err) { this.finish(item.taskId, err.message); }
        dirty = false; break; // 每账号每轮至多一个目标
      }
      if (dirty) this.save(account, q);
    }
  }
}
