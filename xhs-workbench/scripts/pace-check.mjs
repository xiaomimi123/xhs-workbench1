#!/usr/bin/env node
// 采集前置检查（只读）：打印这个账号现在能不能采集、今天读了多少、上限和冷静期。
// 用法：node scripts/pace-check.mjs [--account default] [--json]
// 退出码：0 可以开始 / 2 先别开始（需等待）/ 3 现在不能采集
// 只能看，不能改：总开关、冷静期、上限都只能由人在网页的「采集状态」里改。
// 真正的闸门在工作台服务端（开始采集时检查并记账），这个脚本只是让人和 agent 在动手前能看一眼。
import { paceSummary, paceText } from '../server/pace.mjs';

const argv = process.argv.slice(2);
const at = argv.indexOf('--account');
const account = at >= 0 && argv[at + 1] ? argv[at + 1] : 'default';
const summary = paceSummary(account);
console.log(argv.includes('--json') ? JSON.stringify(summary, null, 2) : paceText(summary));
process.exit(summary.status === 'go' ? 0 : summary.status === 'wait' ? 2 : 3);
