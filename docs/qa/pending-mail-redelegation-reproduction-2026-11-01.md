# 历史邮件待处理时重新委派的针对性回放

日期：2026-11-01。生产代码基线：`9194cd1f`。对应截图：`agentMail_waitingFor_Resolve.png`。

## 结论

**当前重构没有消除所有“只回复历史邮件，新任务未产生产物就结束”的路径。**

新任务没有被请求组装或邮箱注入物理删除：实际送模消息中，本次任务同时存在于系统任务段和用户消息中。但旧邮件会追加成最后一条用户消息。如果模型选择只回复旧邮件，框架仍可收为 COMPLETED、发送“子任务已完成”通知；邮件已经消费，输入复查不会因新任务尚未履约而自动补跑。

这是当前代码允许的确定性反例，不是对截图中真实模型决策的追溯，也不表示真实模型每次都会如此选择。

## 测试链路

测试文件：`src/test/java/com/summit/dp/workflow/application/input/QaPendingMailRedelegationTest.java`。

- 真实 SubSessionResolver 复用子会话，真实 SubAgentRequestFactory 组装“历史 + 新委派”。根会话为 10，子会话为 20，避免同值掩盖邮箱路由错误。
- 真实 H2 / SQLite 文件库，沿用 Mapper、Repository、EmailService 事务；旧邮件投递到根会话业务键下的工程师邮箱。
- 真实 RuntimeProcessorTemplate、DefaultConversationManager、模型调用包装器、邮箱注入和共享收尾拦截器；检查真实送模消息和 Execution 终态。
- 真实 SendMailToAgentTool 回信、SubAgentCompleteNotifier 发送结束通知；晚到复查走 InputWakeupService。
- 产物工具为测试探针，实际写入 JUnit 临时目录的 `behavior/third-round.txt`。这不是对桌宠第三轮功能本身的实现或验收。

只有模型选择使用固定脚本：同一个“优先处理最后用户输入”的脚本，在有旧邮件和旧邮件已消费时分别运行；另设遵守新委派的模型脚本作为正对照。检查点使用框架进程内仓储，终态复查读端提供本次真实运行返回的执行对象；不涉及安装中的 JAR 或真实模型 API。

## 实测结果

每个场景分别在 H2、SQLite 跑一次，共 8 条，全部符合下列观测。**反例测试通过表示缺口仍被复现，不表示缺陷已经修复。**

| 场景 | 模型调用 | 产物工具调用 | 结果 |
| --- | --- | --- | --- |
| 新委派前已有旧邮件；模型选择回复最后输入 | 2 | 0 | 回旧邮件后 COMPLETED，产物和 behavior 目录均不存在 |
| “开始第三轮”回复期间旧邮件提交 | 3 | 0 | 同一循环 CONTINUE，随后只回旧邮件，最终 COMPLETED、无产物 |
| 同一模型，旧邮件在新委派前已经消费 | 2 | 1 | 正常生成文件，内容正确 |
| 旧邮件仍在末尾，但模型继续履行新委派 | 2 | 1 | 正常生成文件，内容正确 |

两个反例还核对：所有模型请求都保留新任务；工程师旧邮件已消费；主理人收到真实回信和“子任务已完成”通知；再次输入复查不调用恢复、新轮受理或保留报告。

## 红测与回退验证

把反例的验收改为“本次任务产物必须存在”，8 条中 **4 条反例失败、4 条正对照通过**。因此不能把本次回放的绿色结果解释成任务已完成。

另做 4 次真实源码变异，均先编译成功，再因断言变红：

| 变异 | 运行数 | 失败数 |
| --- | --- | --- |
| 从 messages 删除本次任务 | 8 | 8 |
| 把邮箱业务键错换成子会话 ID | 2 | 2 |
| 将旧邮件移到本次任务之前 | 2 | 2 |
| 有输入时退回 SUSPENDED，不再 CONTINUE | 2 | 2 |

恢复源码和字节码之后，与请求组装、邮箱注入、输入来源、收尾、完成提醒和自动复查一起运行，**55 条通过，0 失败、0 错误、0 跳过**。

运行方式：

```powershell
mvn -o '-Djacoco.skip=true' '-Dlingxi.build.directory=.run/execution-input-wakeup/target' '-Dtest=QaPendingMailRedelegationTest' test
```

本机明细在 `.run/delegation-pending-mail/`，包括 `baseline-2.log`、`mutation-summary.json`、`acceptance-requires-artifact.log` 和 `restored-regressions.log`，不纳入版本库。

## 对重构效果的判断

调度层的修复有效：邮件撞上收尾时，确实会在同一循环继续，不再依赖挂起后的无条件唤醒。截图暴露的另一层问题仍存在：**“输入已清空、模型没有再调用工具”不能证明新委派已经履约。**

后续若修复这一点，需要明确新任务的完成条件和验收证据，再将这两组反例的期望改为“继续履行新任务或明确未完成”，不能仅用邮件消费、执行终态或结束通知替代验收。
