// 测试辅助：每个测试文件在独立进程里运行，先设置临时数据目录，再动态导入服务端模块
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SKILL = path.join(ROOT, 'xhs-workbench');
export const FAKE_AGENT = path.join(ROOT, 'tests', 'fixtures', 'fake-agent.mjs');

/** 创建临时数据目录并设为 XHS_WORKSPACE；必须在导入服务端模块之前调用 */
export function useTempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-test-'));
  process.env.XHS_WORKSPACE = dir;
  return dir;
}

export function server(mod) {
  return import(pathToFileURL(path.join(SKILL, 'server', mod)).href);
}

export function web(mod) {
  return import(pathToFileURL(path.join(SKILL, 'web', mod)).href);
}

/** 假 agent 的适配器配置 */
export function fakeAdapter(parser = 'text', extra = {}) {
  return { id: 'fake', name: 'Fake', bins: ['node'], command: process.execPath, args: [FAKE_AGENT], promptVia: 'stdin', parser, ...extra };
}

export const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
