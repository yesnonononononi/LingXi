# 应用级会话状态流

- `GET /application/events`：应用挂载时建立单一 SSE 连接，切换会话不重建连接。
- `APPLICATION_READY`：连接已注册，前端随后调用 `GET /application/sessions` 同步全部根会话元数据。
- `SESSION_STATE`：载荷为 `SessionVO`，包含权威会话 ID、`version`、`isRead` 和 `renderStatus`。
- `HEARTBEAT`：每 15 秒发送；前端 45 秒未收到任何帧时重连，重试间隔为 1～30 秒。
- `POST /session/{id}/read?expectedVersion={version}`：返回当前权威会话视图。版本已变化时保留新状态的未读标记。

| renderStatus | 展示 |
| --- | --- |
| WAITING | 灰点，待确认 |
| COMPLETED | 绿点，完成 |
| FAILED | 红点，失败 |
| RUNNING | 蓝色三柱动画，正在运行 |
| null | 新会话或取消执行，不显示结果标记 |

运行态始终显示动画；待确认、完成、失败只在 `isRead === false` 时显示。打开会话时确认已读，后续状态迁移重新置未读；页面隐藏时不确认已读。
不从旧的 `runStatus`、`lastOutcome` 或前端本地状态推测四态。数据库迁移只增加 `is_read`，不回填旧执行的未读历史。

执行检查点只有实际迁移才发送应用事件，归属取持久化执行记录。事务提交前，已读投影与执行状态在同一事务中写入；提交后才广播。
已读操作与状态迁移共用会话行锁，普通会话元数据更新不能覆盖 `is_read`。已读变化不调整会话更新时间。
会话在执行途中被删除后，跳过该会话的渲染投影，执行检查点仍正常收尾。
前端按版本丢弃过期快照和回执，只更新元数据，保留当前消息。完整快照不使用会变化的侧栏偏移分页，避免重连时漏掉会话。

验证入口：`ApplicationSessionStateTest` 和 `frontend/tests/applicationSessionState.test.ts`。
覆盖四态、已读持久化、事务回滚、并发版本保护、完整快照、断线重连、心跳超时、亮暗侧栏与操作项。
