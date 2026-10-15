# 接入其他 agent 命令行

只要 agent 有"传入一段提示词 → 输出回复后退出"的无界面模式，就可以接入 CLI 模式。手动编辑 `~/XHS-Workbench/config/bridge.json`：

```json
{
  "mode": "cli",
  "adapter": {
    "id": "my-agent",
    "name": "我的 Agent",
    "command": "/绝对路径/my-agent",
    "args": ["run", "--auto-approve"],
    "promptVia": "stdin",
    "parser": "text"
  }
}
```

字段说明：

| 字段 | 说明 |
|---|---|
| `command` | 命令的绝对路径（用 `which my-agent` 或 Windows 上 `where my-agent` 查询） |
| `args` | 参数列表，可用占位符：`{prompt}` 提示词、`{workspace}` 数据目录、`{skillDir}` 技能包目录 |
| `promptVia` | `stdin`：提示词从标准输入传入（推荐）；`arg`：通过 `args` 中的 `{prompt}` 传入 |
| `parser` | `text`：标准输出即回复；`claude-stream-json`：Claude Code 兼容的流式 JSON |
| `resumeArgs` | 可选，续接会话的参数，如 `["--resume", "{agentSessionId}"]`（仅流式 JSON 解析器能拿到会话 id） |
| `timeoutMs` | 可选，写在顶层，单次任务超时时间，默认 30 分钟 |

编辑后在工作台「连接与设置」页点「重新测试连接」验证。
