# WorkBuddy 及其他桌面 / IDE 类 agent

WorkBuddy、Cursor、Trae 等桌面或 IDE 类 agent 通常没有可在后台调用的命令行，使用**收件箱模式**：

1. 运行 `node "<技能包目录>/scripts/workbench.mjs" bridge-test --inbox`
2. 运行 `node "<技能包目录>/scripts/workbench.mjs" start --open`
3. 按 SKILL.md 第三节「值守模式」在会话中循环领取并处理任务

注意：

- 值守期间 agent 窗口要保持打开；关掉后网页里的消息会排队，下次值守时继续处理。
- 每次 `inbox-next` 最长等待 110 秒。如果你的 agent 允许更长的命令执行时间，可以用 `--wait 300` 减少轮询次数。
- 如果你所用的 agent 其实提供命令行（如 CodeBuddy 的 `codebuddy -p`），优先运行 `bridge-test` 尝试 CLI 模式。
