// 只读档说明：浏览器权限是只读档时，agent 只能看页面、写草稿，不能在小红书里点击或输入（XHS-11）
import { S } from './core.js';

export function readonlyNotice(what) {
  if (S.bridge?.browserMode !== 'readonly') return '';
  return `<p class="muted" style="margin:0 0 12px">当前浏览器权限是<strong>只读档</strong>：agent 只能打开页面、读内容、写草稿，不能在小红书里点击或输入，所以${what}要你本人在小红书里完成。权限档在「连接与设置 → 执行 Agent 与浏览器」里查看。</p>`;
}
