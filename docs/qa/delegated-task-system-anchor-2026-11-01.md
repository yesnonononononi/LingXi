# 委派任务系统锚点核验

日期：2026-11-01。核验基线：`6b6381f8` 及当前项目实际依赖的 harness-runtime 1.1.8-SNAPSHOT。

## 已有落点

当前生产链路已经实现“把本次委派任务作为系统任务底色”，无需新增接线：

1. CallSubAgentTool 在请求线程调用 SubAgentRequestFactory，组装完成后才登记、异步提交子执行。
2. SubAgentRequestFactory 读取 `argument.getTask()`，同时写入 `AgentRequest.task` 和本次用户消息。
3. DefaultConversationManager.startConversation 将 request.task 交给 SystemPromptAssembler.withTaskPrompt，渲染为首条系统消息中的 Task Manifest。
4. DefaultContextPruner 保留系统消息；模型摘要重建保留原首条系统消息，因此任务不依赖摘要模型复述。
5. 检查点同时保存 AgentRequest.task 和运行中的首条系统消息；恢复首轮继续使用这条系统消息。

任务作用域是本次 execution。重新委派时，新的 task 替换首条系统消息中上一轮的任务，不把旧任务永久固化到整个子会话。邮件与摘要不会修改 request.task。

## 实际依赖验证

新增参数化守卫 `SubAgentRequestFactoryTest.taskStaysInSystemPromptThroughPruningSummaryAndCheckpointResume`，覆盖首派、复用两条路径：

- 复用历史故意携带错误的上一轮系统任务，首轮初始化后必须替换为本次任务。
- 追加大段历史工具输出和最后一条协作邮件，执行真实 DefaultContextPruner；断言工具内容实际缩减、首条系统消息保持不变。
- 执行两次真实 DefaultModelCompacter。固定摘要明确不包含本次任务，系统任务仍须完整保留。
- 将挂起 execution 写入临时 JSON 检查点，重新加载后检查 task 与首条系统消息。
- 走真实 RuntimeProcessorTemplate 恢复入口，检查恢复后实际送给模型的首条消息仍包含本次任务。

| 路径 | 剪枝前 tokens | 剪枝后 tokens | 摘要次数 | 恢复送模任务 |
| --- | --- | --- | --- | --- |
| 首派 | 4320 | 317 | 2 | 保留 |
| 复用 | 4322 | 319 | 2 | 保留，旧系统任务已替换 |

运行时类来自 `D:/languages/mvn/repository/io/github/yesnonononononi/harness-runtime/1.1.8-SNAPSHOT/harness-runtime-1.1.8-SNAPSHOT.jar`，不是临时编译框架源码冒充项目依赖。框架仓保持只读。

CallSubAgentSessionReuseTest 还从实际工具入口捕获异步提交的请求，核对首派、复用、缺历史三种情况都把工具参数中的任务写入 request.task。

## 回退守卫

| 验证方式 | 结果 |
| --- | --- |
| 业务源码移除 task 下发 | 5 条失败 |
| 业务源码误写为固定旧任务 | 5 条失败 |
| 测试侧模拟摘要重建丢掉首条系统消息 | 2 条失败 |
| 测试侧模拟检查点恢复丢失 task 属性 | 2 条失败 |

后两项是边界故障注入，不是修改框架源码。所有变异均编译成功、以断言失败变红。恢复源码和字节码后，请求组装、真实工具入口与此前待处理邮件回放共 **23 条通过，0 失败、0 错误、0 跳过**。

运行方式：

```powershell
mvn -o '-Djacoco.skip=true' '-Dlingxi.build.directory=.run/execution-input-wakeup/target' '-Dtest=SubAgentRequestFactoryTest,CallSubAgentSessionReuseTest,QaPendingMailRedelegationTest' test
```

本机明细位于 `.run/delegation-task-anchor/`，包括 baseline-2.log、mutation-summary.json、restored-regressions.log，不纳入版本库。

## 对本次问题的意义

当前已经具备受保护的本次委派任务锚点。之前邮件回放中的任务也在系统段；本次进一步验证了压缩和恢复不会在正常链路中裁掉它。因此无需再把相同任务重复接入 task，邮件提示可以明确引用“本次委派任务 / Task Manifest”，避免使用“最新用户消息”指代主任务。
