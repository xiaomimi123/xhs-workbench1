#!/usr/bin/env node
// 重启升级的辅助进程（由工作台在员工点「重启升级」后拉起，见 server/self-update.mjs）：
// 等旧工作台进程退出，再调本机接入器 open-app 下载并启动中枢上的最新版本。输出追加到工作台 server.log。
//   node scripts/restart-self.mjs <旧进程 pid> '<{"command":"...","args":[...]}>'
import { spawn } from 'node:child_process';

const [pidArg, specArg] = process.argv.slice(2);
const pid = Number(pidArg);
const spec = JSON.parse(specArg || '{}');
const log = (s) => console.log(`[${new Date().toISOString()}] [重启升级] ${s}`);
const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };

const deadline = Date.now() + 30_000;
while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
if (alive(pid)) { log(`旧工作台（pid ${pid}）30 秒内没有退出，放弃重启`); process.exit(1); }
await new Promise((r) => setTimeout(r, 500));  // 端口释放

log(`旧工作台已退出，调用接入器启动新版本：${spec.command} ${(spec.args || []).slice(-2).join(' ')}`);
const child = spawn(spec.command, spec.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
child.stdout.on('data', (d) => process.stdout.write(d));
child.stderr.on('data', (d) => process.stdout.write(d));
child.on('error', (e) => { log(`接入器启动失败：${e.message}`); process.exit(1); });
child.on('close', (code) => { log(`接入器退出码 ${code}`); process.exit(code || 0); });
