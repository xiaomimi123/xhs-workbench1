// HTTP 测试隔离外部 OCR 进程；生产没有测试模式。浏览器同样由 fixture 提供。
export async function load(url, context, nextLoad) {
  if (url.endsWith('/server/visual-capture.mjs')) return { format: 'module', shortCircuit: true,
    source: `export { downloadAvatar, corroborateProfile } from ${JSON.stringify(url + '?real')};
export async function recognizeScreenshot() { return { engine: 'fixture-ocr', text: '分享真实经验 42 关注 3500 粉丝', lines: [] }; }` };
  return nextLoad(url, context);
}
