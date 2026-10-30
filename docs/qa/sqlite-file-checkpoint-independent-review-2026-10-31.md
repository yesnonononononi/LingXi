# SQLite 与文件检查点：独立复核

被审提交：`5a939e2`；比较基线：`43083c2`。日期：2026-10-31。

结论：迁移实现和全量测试数字属实，但不能按“已知缺陷 0、全部收口”验收。确认 2 项 P1 与 3 项 P2，其中两个并发缺陷已有确定性复现。

## 已独立验证的结果

- 12 个提交；202 个文件，新增 26、修改 87、删除 88、重命名 1，`+6581 / -3623`。
- 隔离构建目录复跑 `mvn -o clean test`：1457 条，失败 0、错误 0、跳过 8，BUILD SUCCESS。
- 原有前端目标测试 `backendSandbox.test.cjs`、`developmentIsolation.test.cjs`：10/10 通过。
- 重新执行 `mvn -o package -DskipTests` 成功。产物含 91 个依赖 jar（加目录条目为 92 项）、唯一 SQLite JDBC 驱动及 Windows x86_64 JNI，无 H2 jar。检查 H2 名称的扫描器先通过正对照。
- 实际驱动查询：`SQLITE_ENGINE=3.50.3, JOURNAL=wal`。
- 原内存守卫本次实测：夹具 13,124,512 字节，峰值 118 MiB，整段 JSON 转换次数 0。

所有数据库与检查点复核都使用隔离目录；没有部署到安装版或操作用户数据。NSIS 安装后的验收仍未覆盖。

## R1 / P1：结束登记会移除另一笔尚未结束的写入

位置：`LocalFileCheckpointStore.release` 第 431–433 行；登记端为 `begin` 中的 `computeIfAbsent(...).add(...)`。

`pending.remove`、`pending.isEmpty`、`inFlight.remove` 并非一个原子操作。合法交错为：

1. A 结束，移除自己的文件标识，观察集合为空；
2. B 开始，复用同一个集合并登记新文件；
3. A 继续执行 `inFlight.remove(executionId, pending)`，把含有 B 的集合一起移除；
4. 清理器把 B 已发布但尚未提交的文件当成孤儿删除；B 随后提交会留下断链引用。

生产保存的提交回调在方法内 `executionId` 监视器之外执行，因此与下一次 `begin` 的交错并未被业务锁排除。

确定性探针只在“集合为空”的观察点插入线程调度屏障，未改产品逻辑，使用真实文件存储与清理器，结果：

```text
REGISTRY registeredWhileUnsettled=false, newFileExists=false
BUG_REPRODUCED=UNSETTLED_CHECKPOINT_DELETED
```

修复需要让同一执行的登记与释放都成为原子操作；仅改释放端、登记端仍在 map 操作之外 `add`，不足以封住窗口。同批补“提交回调与下一次写入交错”的回归守卫。

## R2 / P1：不同执行的真实事务并发保存会读后升写失败

位置：`ExecutionCheckpointService.save` 第 48–54 行；外层 `LocalExecutionRepository.save` 开启事务，只按执行 ID 互斥。

两个不同执行可以同时读到 SQLite 的旧快照。A 更新提交后，B 在原事务中更新会立即收到 `SQLITE_BUSY_SNAPSHOT`；当前保存入口没有整笔事务的重试。单执行监视器和 `busy_timeout` 均不能解决这个交错。

探针通过真实 `DataSourceTransactionManager` / `TransactionTemplate` 包住生产保存方法，两个执行各自读取摘要后设屏障，让 A 先提交，再让 B 更新：

```text
CONCURRENT_SAVE first=COMMITTED, second=SQLiteException:[SQLITE_BUSY_SNAPSHOT] ...
VERSIONS first=2, second=1
BUG_REPRODUCED=CONCURRENT_SAVE_BUSY_WITHOUT_RETRY
```

应协调真实写入事务或在事务外有限重试整笔保存，不能在已过期的读事务内仅重试 UPDATE。

现有受限堆夹具直接 `new LocalExecutionRepository` 与 `new ExecutionCheckpointService`，没有 Spring 代理，也没有外层事务模板，因此其中“三并发通过”不能证明生产事务路径通过。

## R3 / P2：驱动处于官方 WAL 损坏缺陷影响范围

位置：`pom.xml:36`，`sqlite-jdbc 3.50.3.0`；生产开启 WAL，连接池允许 4 个连接。

实际查询确认底层为 SQLite 3.50.3。SQLite 官方说明 WAL-reset 竞态影响 3.7.0 至 3.51.2，在 3.51.3 修复，另有 3.50.7 等回补版本；触发要求同库多个连接并发写入或 checkpoint。

这是低概率、严格时序的已知引擎缺陷，本次没有在本项目中复现数据库损坏。普通测试全绿不足以排除此风险；发版前应选择含官方修复的稳定驱动。

来源：[SQLite WAL 缺陷说明](https://www.sqlite.org/wal.html)、[3.51.3 修复记录](https://www.sqlite.org/releaselog/3_51_3.html)。

## R4 / P2：仅剩孤儿文件时，UI 无法触发清理

位置：`ExecutionCleanupService.preview:35`、`useExecutionCleanup.ts:18` 与 `:40`、`DataTab.vue:180`。

预览只统计可回收的数据库行。没有候选行但存在孤儿 JSON / `.part` 时，返回 `executionCount=0`；前端据此令 `canClean=false`，按钮禁用，清理函数也直接返回。

同样的问题会阻断跨调用游标：若第一次清理返回 `remainingCount=0`，但本轮目录预算之后仍有孤儿文件，界面无法发起第二次扫描。直接 POST 接口验证绕过了这层限制，不能据此认定“UI 可手清”已通过。

此项为静态确认：必须把“可回收行数为零”与“无需扫描文件”分开，同时补真实前端调用守卫。本地缺少 Vue / tsx 依赖，追加动态探针未能启动，未把依赖错误算作产品缺陷证据。

## R5 / P2：字符串变异的 OOM 对照受 spy 调用历史影响

位置：`LimitedHeapCheckpointHarness.java:83`，及第 177 行的调用历史统计；相关内存 QA 报告。

保持相同的 512 MiB、同一夹具及负载，使用隔离编译覆盖类，产品源码未修改：

| 保存方式与计量方式 | 结果 | 峰值堆 | 整段转换次数 |
| --- | --- | --- | --- |
| 当前流式方式，原 spy 夹具（全量测试） | 成功 | 118 MiB | 0 |
| 字符串中转变异，原 spy 夹具 | OOM，退出码 3 | 506 MiB | 未跑完 |
| 同一字符串变异，保留 spy、每次保存后清空调用历史，用原子计数器保留次数 | 成功，40 条历史与 5 轮上下文均完成 | 368 MiB | 65 |
| 同一字符串变异，非保留型计数 mapper | 成功，同负载完成 | 458 MiB | 65 |
| 当前流式方式，同一非保留型计数 mapper | 成功，同负载完成 | 103 MiB | 0 |

因此，原测试中字符串变异的 OOM 受 spy 调用历史保留对象影响，不能据此声称“生产中只要恢复字符串中转，同负载就必然 OOM”。调用次数守卫仍然有效，且流式路径的内存收益仍有支持；需要把交互断言与内存计量分开，修正报告归因。

这些都是固定合成夹具的结果，不是旧 H2 完整历史版本或真实安装版的同负载对照。此外，上下文阶段写入 5 个不同会话，未覆盖同一大上下文连续更新的压力场景。

## 本机证据

目录：`.lingxi/review-sqlite-20261031-001626/`。

- `full-test.log`、`frontend-targeted.log`、`package.log`、`artifact-verification.json`。
- `ReviewConcurrencyProbe.java`、`registry-probe.log`、`transaction-probe.log`。
- `engine-version.log`、`memory-review-controls.json`，及各内存对照日志与隔离编译源文件。

本次只出复核结论，未将上述问题擅自修改为另一套实现。
