# H2 OOM 重放器复核（2026-10-31）

本次起因是验收报告中的测试结果，用户已确认没有发生新的线上 OOM，也没有切换生产数据库。

## 结论

修正重放器后，新路径六组与旧形态正对照两组均完成，没有记录到 OOM；但正对照不再变红，门禁按原规则返回 **FAIL / 退出码 1**。含义是本负载不能有效区分新旧形态，不能沿用上一轮 OOM 验收 PASS，也不能解释为新路径发生了 OOM。

512 MiB 下仍有两组瞬时峰值接近堆上限。GC 后占用明显回落，高峰不等于常驻存活量；本轮没有证明长期无泄漏，也没有证明真实应用的并发余量充足。

## 已修正的测试偏差

1. `CheckpointReplay.replay` 原先每轮执行 `wholeJsonCache.add(body.concat(" "))`，人为保留所有历史副本。对照文件检查点改造前的 `746b54b^`，旧 `LocalExecutionRepository.cacheAfterCommit` 实际是 `checkpoints.put(id, snapshot)`，按执行 ID 替换，终态删除。新重放器共享按执行 ID 保存的 Map，只在保存成功后替换，并在 RESULT 输出 `retainedCheckpoints`。本夹具没有终态阶段，因此运行结束前每个执行保留一份。
2. 矩阵原先用 `java CheckpointReplay.java` 源码模式启动，编译器与受限堆负载在同一个 JVM。现在先在独立进程编译三个工具，受测 JVM 只运行 class。一次预实验的峰值由约 500 降到 348 MiB，但正式复跑仍测到 500.5 MiB，不能把编译器说成全部高峰的原因。

旧正对照 OOM 混入了额外历史保留，不能再据它声称“已准确还原旧缓存、证明负载足够”。历史真实事故证据不受本次测试修正影响。

## 正式复跑

H2 2.5.252；每组独立 JVM / 文件库；`-Xms128m`；30 轮、间隔 500 ms；默认 1 个 worker，recovered 为 20 轮；pre/recovered 每 5 轮替换上下文，reconstructed 每轮替换。没有降低原门禁负载或放宽阈值。

| 路径 | 场景 | Xmx MiB | 峰值 MiB | Full GC | 结果 |
| --- | --- | ---: | ---: | ---: | --- |
| 文件检查点 + CLOB | pre | 512 | 500.5 | 0 | CLEAN |
| 文件检查点 + CLOB | pre | 1024 | 347.8 | 0 | CLEAN |
| 文件检查点 + CLOB | recovered | 512 | 353.3 | 0 | CLEAN |
| 文件检查点 + CLOB | recovered | 1024 | 331.8 | 0 | CLEAN |
| 文件检查点 + CLOB | reconstructed | 512 | 496.3 | 0 | CLEAN |
| 文件检查点 + CLOB | reconstructed | 1024 | 614.3 | 0 | CLEAN |
| VARCHAR + 最新版缓存 | reconstructed | 512 | 487.5 | 0 | CLEAN，正对照未变红 |
| VARCHAR + 最新版缓存 | pre | 512 | 409.5 | 0 | CLEAN，正对照未变红 |

所有组 `failure=none`、退出码 0。扫描器先经过历史 OOM 正样本、正常负样本和结论文案陷阱自检；再递归扫描每组控制台、stderr、GC 日志等文件。文件路径与扫描数量保存在各组 `scan.log`，没有只凭退出码下结论。

GC 日志的具体回收证据：512 MiB reconstructed 组在 23.595 s 的一次 Mixed GC 从 `458M` 降到 `88M`。这能说明当次有大量可回收对象，不能证明不存在长期保留。

另一个临时诊断副本在同样 pre / 512 MiB / 30 轮负载结束、数据库连接尚未关闭时调用一次 `System.gc()`：文件路径从约 185 MiB 降到 51 MiB，1 秒后采样约 54 MiB。该强制 GC 只存在于临时诊断副本，没有加入正式矩阵或生产代码，也没有用于门禁放行。

## 回归守卫

`mvn -o -B -Dtest=OomReplayHarnessTest test`：2 条通过。用例编译并调用真实重放器负载方法，以数据库调用替身隔离缓存保留行为；两个执行各保存五轮，断言缓存恰好两份，文件路径零份，并确认十次保存确实发生。

语义变异：把缓存键从 `executionId` 改成每轮递增的 `SAVED.get()`，制造逐轮保留，断言从预期 2 变成实际 10，1 条失败；恢复后 2 条重新通过。变异没有改动其他会话的工作树文件。

## 证据与边界

本机原始产物：

```text
C:\Users\summit\AppData\Local\Temp\lingxi-h2-memory-audit-20261031-223904\
  corrected-gate.log
  corrected-gate\oom-gate-summary.md
  corrected-gate\run-h2-new\matrix-h2-new.json
  corrected-gate\run-positive-control\matrix-positive-control.json
  file\console.log
  varchar\console.log
  source-file\console.log
  bounded-source-varchar\console.log
  harness-tests.log
  cache-mutation.log
  harness-restored.log
```

只读使用独立的 `replay-fixtures` 与历史日志；本次没有连接、迁移或替换开发及安装版数据库，没有修改应用堆参数。

本重放器仍是 JDBC 存储微负载，不包含 Spring/MyBatis 全链路、Execution 对象图、恢复与真实并发；workers 在现实现中串行运行。reconstructed 仍是合成样本，其长度按字符构造，不能视为原始事故正文的逐字节重放。历史 SQLite 峰值来自另一套程序，不能直接拿两份峰值计算引擎常驻内存倍率。

后续验收需要真实仓储路径下的同负载对照、并发与长时运行，记录自然 GC 后的存活量及分配热点，再判断是否需要调整 H2 写入方式或缓存预算。当前只能报告“本轮未 OOM，OOM 区分能力验收未通过”。
