# 后台命令

`execute_command` 增加可选参数 `background`，默认仍同步执行。设为 `true` 时先保存真实的任务、会话和轮次身份，再启动工作空间命令，立即返回字符串 `taskId`。安全检查、审批、沙箱、超时与输出预算仍然生效。

使用 `manage_command` 操作当前会话的任务：

- `{"action":"list"}`：返回最近 50 项摘要，并补齐更早的全部在途任务。
- `{"action":"read","taskId":"实际任务 ID"}`：返回当前输出或持久化结果，以及状态、退出码和截断标记。
- `{"action":"stop","taskId":"实际任务 ID"}`：等待确认停止；取消失败会报错，可重试。已自然结束的任务保留原结果。

默认 Agent 同时提供这两个工具；自定义 Agent 使用后台模式时，应同时选中它们。只读档位保留命令控制，命令本身仍受终端安全策略约束。

界面调用入口为 `GET /task/runtime/list?sessionId=...`、`GET /task/runtime/{id}?sessionId=...` 和 `POST /task/runtime/{id}/stop?sessionId=...`。任务标识始终使用字符串，不能转成 JavaScript `Number`。

输出由框架持续读取并限制长度；终态落库失败会保留原结果重试。应用正常关闭时尝试停止存活任务；重启后无法确认的在途任务标为 `LOST`，不会自动重放命令。当前实现不提供跨重启接管进程或自动恢复执行。

任务用途取自 `execute_command.intention` 并持久化，用于界面列表名称。状态写入后，经所属根会话 SSE 发送 `BACKGROUND_TASK_CHANGED` 通知；界面回查当前会话任务，进入会话和断线重连时也会回查。通知不依赖模型执行是否结束。
