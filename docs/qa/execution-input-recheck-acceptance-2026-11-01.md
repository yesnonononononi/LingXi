# 输入复查改造验收记录

日期：2026-11-01。对应[架构方案](../execution-wakeup-architecture-plan.zh-CN.md)。仅验证本次源码和隔离测试 JVM，没有替换运行中的后端 JAR。

## 回归范围

后端在 `.run/execution-input-wakeup/target` 隔离构建：1,544 条测试，0 失败、0 错误、8 跳过。包含 H2、SQLite 输入契约、选批消费、新轮事务回滚、检查点事务/并发、应用装配和委派交错回归。

```powershell
mvn -o '-Djacoco.skip=true' '-Dlingxi.build.directory=.run/execution-input-wakeup/target' '-Dtest=*,!CompactModelConfigBindingTest,!OomReplayHarnessTest' test
```

初始全量中的两个未改动区域失败测试类未纳入上述通过数，不宣称全仓无排除全绿：

- `CompactModelConfigBindingTest`：压缩档位的 reasoning_effort 期望 `none`，实际为 null。
- `OomReplayHarnessTest`：现有 OOM 回放工具编译失败。相关工具文件已有其他未提交修改，本次保留。

前端 `chatAsyncDelegationStatus.test.cjs` 共 11 条通过，`vue-tsc -b` 通过。新增用例实际挂载组件，验证 WAITING、CANCELLED、COMPLETED 都能显示保留输入的原因；该测试文件已经在 test / test:all 清单中。

## 回退变异

每个变异都实际编译并运行目标测试；必须出现断言失败，编译失败、测试未运行和等价变异均不算证明。变异结束恢复原源码与字节码，并再运行恢复后的基线。

| 故意引入的缺陷 | 对应回归守卫 |
| --- | --- |
| 有输入却返回挂起 | SubAgentWaitInterceptorTest |
| 先查输入、后读依赖 | InputSourceContractTest.finalChildPublicationAtDependencyReadIsSeenBeforeCompletion，两种引擎 |
| 删除释放后复查 | LocalExecutionRepositoryResumeTest.releaseRechecksAfterWaitingProjectionAndOutsideTheGate |
| 终态释放后不复查 | LocalExecutionRepositoryResumeTest.terminalReleaseRechecksAfterTurnClosure |
| 根运行资格释放后不补查 | PreparedChatExecutorTest.completedRootIsRecheckedAfterContextAndRunQualificationAreReleased |
| 正常完成后不受理新轮 | InputWakeupServiceTest.completedInputUsesANewTurnAndNeverResumesTheOldExecution |
| 消费时重查并扩大批次 | InputSourceContractTest.selectedMailBatchDoesNotConsumeLaterArrivalsAndBothEnginesShareTheQuery，两种引擎 |
| 取消按正常完成处理 | InputWakeupServiceTest.failedAndCancelledInputStaysPendingAndIsReported |
| 删除主动暂停检查 | InputWakeupServiceTest.explicitPauseAndAutomaticRoundLimitBlockAutomaticWork |
| 自动轮数上限晚挡一轮 | 同上 |
| 删除报告批次去重 | InputNoticeReporterTest |
| 删除自动受理事务 | InputSourceContractTest.automaticAdmissionCommitsTheSelectedMailAndRollsBackItsNewTurnOnFailure，两种引擎 |
| 重启后忽略持久化子依赖 | InputSourceContractTest.persistedSuspendedChildSurvivesAnEmptyProcessRegistry，两种引擎 |
| 登记控制槽位时忽略取消 | LocalExecutionRepositoryResumeTest.cancelIntentBeforeRegistrationStopsTheNewControlSignal |
| 排队后忽略新到的暂停 | LocalExecutionRepositoryResumeTest.pauseAfterEnqueuePreventsControlRegistrationAndPreservesPendingSnapshot |
| 把暂停竞争改判失败 | ExecutionResumeCoordinatorTest.pauseArrivingAfterDispatchIsYieldedInsteadOfReclassifiedAsFailure |
| 主动恢复不先保存清除意图 | ChatResumeTeamAttributeTest.manualResumePersistsClearedPauseIntentBeforeControlRegistration |
| 旧轮上下文回写不持会话门闩 | InputTurnContinuationTest.contextWriteCompletesBeforeLateInputCanPrepareANewTurn |
| 挂起保存不记录暂停意图 | LocalExecutionRepositoryResumeTest.userPauseIsPersistedBeforeReleaseRecheck |
| 界面隐藏保留输入提示 | chatAsyncDelegationStatus.test.cjs |

读取顺序用例同时检查 `status=CONTINUE` 和 `next=false`；只检查状态会把 InterceptorResult.NONE 的默认状态误判成显式继续，不能守住该窗口。

其他基线包括：两个检查并发只创建一个真实新轮；旧通知转查最新权威执行；查询失败只重试一次且不冒充空输入；失败、取消、主动暂停、上限到达均保留输入；同批次报告在检查点重新加载后仍去重；无控制槽位的启动失败也触发终态检查。

本机日志和变异明细位于 `.run/execution-input-wakeup/`，不纳入版本库。主要文件为 `full-accepted.log`、`frontend-final.log`、`frontend-final-types.log`、`mutation-summary.json`、`mutation-restored-baseline.log`。

## 自检与边界

新增 Java 行扫描先以包含 NUL 的递归金丝雀验证，检查 var、原生 JDBC、方法体全类名和 xxxOf 命名；弃用唤醒入口扫描覆盖全部生产 Java 文件。共享文件中原有三处修改未纳入本次提交，其余原有未提交工作也保留。

本期不消除“邮件消费成功、检查点尚未持久化就崩溃”的输入丢失窗口；不自动重启失败、取消的执行；子执行续接仍通过标准委派。详细前提和升级条件见架构方案。
