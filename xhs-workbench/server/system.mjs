// 系统集成：开机自启（登录后自动运行工作台）与防休眠
// macOS：LaunchAgent + caffeinate；Windows：启动文件夹 VBS + SetThreadExecutionState；Linux：systemd --user + systemd-inhibit
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { P, SKILL_DIR, WORKSPACE } from './paths.mjs';
import { ensureDir } from './store.mjs';

const PLATFORM = process.platform;
const LABEL = 'com.xhs-workbench.agent';
const SERVER = path.join(SKILL_DIR, 'server', 'server.mjs');
const LOG = path.join(P.logs, 'server.log');

function autostartFile() {
  if (PLATFORM === 'darwin') return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
  if (PLATFORM === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'xhs-workbench.vbs');
  return path.join(os.homedir(), '.config', 'systemd', 'user', 'xhs-workbench.service');
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 生成开机自启配置内容。platform 可注入以便跨平台测试 */
export function autostartContent(platform = PLATFORM) {
  const node = process.execPath;
  if (platform === 'darwin') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(SERVER)}</string></array>
  <key>WorkingDirectory</key><string>${xml(WORKSPACE)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>XHS_WORKSPACE</key><string>${xml(WORKSPACE)}</string>
    <key>PATH</key><string>${xml(process.env.PATH || '/usr/bin:/bin')}</string>
    <key>HOME</key><string>${xml(os.homedir())}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xml(LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG)}</string>
</dict>
</plist>
`;
  }
  if (platform === 'win32') {
    // VBS 字符串里的引号要写成两个引号；cmd /c 的整条命令再用一层引号包住，
    // 且最外层要写成两个引号（cmd 会剥掉首尾一对，剩下的才是真实引号），
    // 否则路径带空格（C:\Program Files\nodejs\）时命令会断开。
    const vbs = (s) => String(s).replace(/"/g, '""');
    const cmdLine = `cmd /c ""${node}" "${SERVER}" >> "${LOG}" 2>&1"`;
    return `' 登录后在后台启动小红书运营工作台（由 workbench.mjs autostart 生成）
Set sh = CreateObject("WScript.Shell")
sh.Environment("Process")("XHS_WORKSPACE") = "${vbs(WORKSPACE)}"
sh.Run "${vbs(cmdLine)}", 0, False
`;
  }
  return `[Unit]
Description=XHS Workbench（小红书运营工作台）

[Service]
Environment=XHS_WORKSPACE=${WORKSPACE}
Environment=PATH=${process.env.PATH || '/usr/bin:/bin'}
WorkingDirectory=${WORKSPACE}
ExecStart=${node} ${SERVER}
Restart=on-failure
StandardOutput=append:${LOG}
StandardError=append:${LOG}

[Install]
WantedBy=default.target
`;
}

export function autostartStatus() {
  const file = autostartFile();
  return { platform: PLATFORM, enabled: fs.existsSync(file), file };
}

/** 自启脚本是否还指向别的版本目录（升级后旧版本目录会被清理，指着它的自启就失效了，或每次开机都拉起旧版本）。只比较内容，不碰 launchctl / systemctl */
export function autostartDrift(read = (f) => fs.readFileSync(f)) {
  const file = autostartFile();
  if (!fs.existsSync(file)) return false;
  let cur;
  try {
    const buf = read(file);
    cur = file.endsWith('.vbs') ? buf.toString('utf16le').replace(/^﻿/, '') : buf.toString('utf8');
  } catch { return false; }
  return cur !== autostartContent();
}

/** 已开启自启但内容过期时重写（工作台每次启动调用一次）。macOS / Linux 下次登录生效，不立即重新注册。返回是否改写了 */
export function refreshAutostart() {
  if (!autostartDrift()) return false;
  const file = autostartFile();
  const content = autostartContent();
  if (file.endsWith('.vbs')) fs.writeFileSync(file, '﻿' + content, 'utf16le');
  else fs.writeFileSync(file, content);
  return true;
}

/** 开启 / 关闭开机自启。关闭只删除启动项，不会停掉正在运行的工作台 */
export function setAutostart(on) {
  const file = autostartFile();
  if (on) {
    ensureDir(path.dirname(file));
    const content = autostartContent();
    // wscript 按 ANSI（中文系统是 GBK）读 .vbs，UTF-8 的中文注释和数据目录路径会乱码；
    // 带 BOM 的 UTF-16LE 是 wscript 明确支持的格式
    if (file.endsWith('.vbs')) fs.writeFileSync(file, '﻿' + content, 'utf16le');
    else fs.writeFileSync(file, content);
    // 立即注册；当前已有工作台在运行时，新实例会因单实例锁自动退出
    if (PLATFORM === 'darwin') {
      const uid = process.getuid();
      spawnSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' });
      spawnSync('launchctl', ['bootstrap', `gui/${uid}`, file], { stdio: 'ignore' });
    } else if (PLATFORM === 'linux') {
      spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
      spawnSync('systemctl', ['--user', 'enable', 'xhs-workbench.service'], { stdio: 'ignore' });
    }
  } else if (fs.existsSync(file)) {
    if (PLATFORM === 'linux') spawnSync('systemctl', ['--user', 'disable', 'xhs-workbench.service'], { stdio: 'ignore' });
    fs.unlinkSync(file);
  }
  return autostartStatus();
}

// ---------- 防休眠 ----------

let keeper = null;

function startKeeper() {
  if (keeper) return;
  if (PLATFORM === 'darwin') {
    keeper = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
  } else if (PLATFORM === 'win32') {
    const ps = `Add-Type -Name P -Namespace W -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; while ($true) { [W.P]::SetThreadExecutionState(0x80000001) | Out-Null; Start-Sleep -Seconds 50 }`;
    keeper = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { stdio: 'ignore', windowsHide: true });
  } else {
    keeper = spawn('systemd-inhibit', ['--what=idle:sleep', '--who=xhs-workbench', '--why=定时任务', 'sleep', 'infinity'], { stdio: 'ignore' });
  }
  keeper.on('error', () => (keeper = null));
  keeper.on('exit', () => (keeper = null));
}

function stopKeeper() {
  if (!keeper) return;
  try {
    keeper.kill();
  } catch {
    /* 已退出 */
  }
  keeper = null;
}

/** mode: off | auto（有排期或定时任务时）| always；needed：auto 模式下当前是否有定时任务 */
export function applyKeepAwake(mode, needed) {
  if (mode === 'always' || (mode === 'auto' && needed)) startKeeper();
  else stopKeeper();
  return !!keeper;
}

export function keepAwakeActive() {
  return !!keeper;
}

process.on('exit', stopKeeper);
