# SQLite 上下文重试：独立定向复测

时间：2026-10-31 10:42 起（UTC+8）。被测提交：`58f35e5`，修复提交：`1296ded`。结论：此前桌宠真实数据触发的上下文并发失败，在本轮定向复测中已通过。

## 目标回归

隔离工作树与构建目录运行 `mvn -o package`，限定以下六个测试类，共 20 条，失败、错误、跳过均为 0，构建成功：

- `ModelContextReplaceTransactionTest`：3 条，覆盖不同会话更新、与检查点混合并发、首次插入。
- `ModelContextServiceTest`：5 条。
- `TransactionRetryTemplateTest`：6 条。
- `ConcurrentCheckpointSaveTransactionTest`：2 条。
- `CheckpointInFlightRegistryTest`：2 条。
- `ExecutionCleanupCursorProbeTest`：2 条。

## 原始桌宠数据对照

复用首次事故导出的真实数据与 `recovered` 场景，三执行常驻，先单执行保存 20 轮，再三线程各保存 20 轮；每轮间隔 250ms，每 5 轮替换上下文。均使用 SQLite 3.54.1、实际 Spring 事务与文件存储，不加跨执行串行信号量，不使用 Mockito 记录大对象。

新探针按生产装配为 `ModelContextService` 注入真实事务管理器；旧代码对照保留其原有事务注解。额外流式校验还原上下文的完整正文指纹。

| 代码 / 堆上限 | 结果 | 保存 / 上下文写入 / 还原 | 堆峰值 MiB | 重试日志数 |
| --- | --- | ---: | ---: | ---: |
| 修复前 `b400215` / 1 GiB | 原锁冲突复现，退出码 4 | 55 / 9 / 0 | 443 | 1 |
| 修复后 / 512 MiB，第一轮 | 通过，退出码 0 | 100 / 19 / 3 | 491 | 3 |
| 修复后 / 512 MiB，第二轮 | 通过，退出码 0 | 100 / 19 / 3 | 404 | 5 |
| 修复后 / 1 GiB | 通过，退出码 0 | 100 / 19 / 3 | 512 | 3 |

修复前仍在 `ModelContextService.replace` 收到 `SQLITE_BUSY_SNAPSHOT`。修复后三轮确实遭遇锁冲突，经重试完成，均零失败、零 OOM；还原上下文正文校验通过。另起进程对三组共 60 份落盘检查点进行完整 Execution 对象的流式指纹比对，全部一致，正文文件数与行数一致。

统计按进程退出码及实际失败断言判断成功；可恢复的锁冲突警告不归为失败。首版汇总器仅匹配日志中的 BUSY 词，曾将成功重试误分类，已修正汇总及复跑脚本；保存次数、失败数、退出码和原始日志未改。

原始证据数据库 SHA-256 再次复核仍为 `48089C21D099C43CA9450108ABF9CAB2EABEF1122C74448D88BB60FC12BBC6F9`。

## 证据与范围

本地目录：`C:\Users\summit\.lingxi\diagnostics\h2-root-cause-20261030-153813\fix-targeted-check-20261031-104252`。

保留冻结源码、目标测试 XML、构建日志、更新后的重放探针与事务装配日志、四组独立数据库/检查点/GC 日志、`results-summary.json` 及 `semantic-verification.log`。原始数据来源与根快照缺失边界见 `first-oom-desktop-pet-replay-2026-10-31.md`。

本轮覆盖持久化并发及相关回归；未重跑全量测试、完整模型/工具执行或安装版验收。业务代码与框架均未修改。
