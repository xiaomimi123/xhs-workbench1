// 向企业中枢上报工作成果：把关键产出追加写到本机 outbox 文件（环境变量 HUB_WORK_OUTBOX 指定），
// 由员工机上的中枢接入器转发到中枢的「工作看板」。没有该变量时什么都不做；任何错误都吞掉，绝不影响工作台本身。
// 只写标题、类型、状态、进度、可公开的链接和一句话说明——不写正文、提示词、账号资料或本机路径。
import fs from 'node:fs';

export const WORK_ENV = 'HUB_WORK_OUTBOX';
const STATUSES = new Set(['进行中', '待审核', '已完成', '受阻']);
const cut = (v, n) => String(v ?? '').trim().slice(0, n);

/** 追加一条成果（同一个 key 再次上报就是更新）。返回是否写入。 */
export function reportWork(item, env = process.env) {
  const file = env[WORK_ENV];
  if (!file) return false;
  try {
    const key = cut(item.key, 80);
    const title = cut(item.title, 120);
    if (!key || !title) return false;
    const status = STATUSES.has(item.status) ? item.status : '已完成';
    const progress = Math.max(0, Math.min(100, Math.round(Number(item.progress ?? (status === '已完成' ? 100 : 0))) || 0));
    const link = /^https?:\/\//i.test(item.link || '') ? cut(item.link, 300) : '';
    const line = { key, title, kind: cut(item.kind || '其他', 20), status, progress, ...(link ? { link } : {}), ...(item.note ? { note: cut(item.note, 300) } : {}) };
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
    return true;
  } catch {
    return false;
  }
}
