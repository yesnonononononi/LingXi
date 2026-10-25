# 无用执行数据清理

设置 → 数据管理中的「清理无用执行数据」先读取预计条数，再通过 POST 执行清理；完成后展示实际删除与剩余条数。预览结果只供展示，删除时重新检查版本、状态与引用。

可清理对象必须同时满足：

- execution 已处于 COMPLETED、FAILED 或 CANCELLED。
- 没有属于现存会话的 chat_turn 引用。
- 没有 tool_call、execution_resume_task 或 task 引用；这些引用无论自身状态如何都保留。
- 执行的进程内控制槽位已释放。

已删除会话留下的孤立轮次不会阻止回收；重发回滚后失去轮次引用的执行也可回收。入口只删除 execution，不级联修改其他模块记录。

有效历史快照仍承担 resend 基线，不能按年龄直接删除，也不能用展示历史替代模型上下文。CREATED、RUNNING、SUSPENDED 及未知状态均不在回收范围内。本功能不调整历史保留策略，不处理 API Key 脱敏。

接口：

- GET `/execution/cleanup/preview`：`executionCount`。
- POST `/execution/cleanup`：`deletedCount`、`remainingCount`。

计数按后端统一 JSON 规则返回十进制字符串。清理每批最多 200 条候选，单次事务最多扫描 10,000 条；仍有候选时可再次清理。过程中失败则整次回滚，并发清理按实际删除行数计数。

删除释放的是数据库内部可复用空间，不承诺 H2 文件立即缩小。该入口也不删除外部备份、图片或配置文件。
