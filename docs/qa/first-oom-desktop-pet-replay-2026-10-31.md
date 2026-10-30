# 桌宠会话首次 OOM：真实数据情景重放

日期：2026-10-31。结论：真实事故数据能够在旧安装版重现 H2 写缓冲区扩容 OOM；SQLite 与文件检查点显著降低该场景的内存压力，但上下文并发写入仍有独立缺陷。

## 数据来源与边界

首次事故时间为 2026-10-30 15:12:28.721（UTC+8）。原日志位于证据库同目录的 `lingxi.trace.db` 第 15234 行，路径包含 `WriteBuffer.grow → ValueDataType.writeString → Record$Type.write`，扩容目标为 146,319,967 字节。

原始证据库：

```text
C:\Users\summit\.lingxi\diagnostics\h2-root-cause-20261030-153813\evidence\lingxi.mv.db
大小：708,292,608 字节
SHA-256：48089C21D099C43CA9450108ABF9CAB2EABEF1122C74448D88BB60FC12BBC6F9
```

通过旧安装版 Mapper 只读导出桌宠根会话及架构师、工程师、QA 四个关联会话，共 20 份可读执行快照、4 份上下文和对应运行配置修订。原始数据库及 24 份正文的 SHA-256 在压测后全部复核一致。

- 根会话：`2115988021194158080`。
- 丢失的根执行：`2116061439910375424`，原始正文仍不可读，无法声称精确还原事故瞬间。
- 最近的可读根执行：`2116061030625996800`，原始 UTF-8 大小 8,228,383 字节，约 7.85 MiB，含 379 条执行消息及 372 条请求初始消息。
- 根上下文：10,876,478 字节，427 条消息；更新时间为事故后的 15:17:00。
- 工程师上下文：6,464,376 字节，更新时间为事故后的 15:32:46。

分三组，避免混淆时间与来源：

| 场景 | 数据与重放设定 |
| --- | --- |
| `pre` | 19 份事故前已提交快照；根执行使用最近可读正文；上下文取该执行消息，避免引入事故后的上下文。 |
| `recovered` | 原始备份中全部 20 份可读快照及幸存上下文，包含事故后提交的数据；选根、工程师、架构师三个执行常驻。 |
| `reconstructed` | 此前用同会话旧执行和幸存上下文重建的 14,988,752 字节辅助样本，明确不属于丢失的原始快照。 |

活动执行由历史正文装载，场景内将状态设为 RUNNING、完成时间置空，递增 `modelAttempts` 触发更新；正文内容不扩写、不截断，不复制虚假的历史执行。历史执行保持原终态。旧版导入历史后整段 JSON 缓存条目数为 0，不能把“40 个终态快照持续占用该缓存”当作原生产行为。

## 实现与运行条件

- 离线重放快照保存、上下文替换、历史数据、提交后文件回收及还原，不创建 Agent、不调用模型、不执行历史工具指令。
- 使用实际 Mapper、仓储、文件存储和 Spring 事务代理；没有 Mockito spy 或调用参数记录器。
- 旧版加载事故诊断目录保存的安装版 classes 与依赖，H2 2.3.232；连接池初始 5、最大 20。
- 新版业务代码冻结于独立工作树 `b400215`，包含 R1 原子登记和 R2 检查点事务重试；SQLite 连接池初始 1、最大 4，WAL/FULL、busy_timeout=5000、DEFERRED。
- `sqlite` 使用驱动 3.50.3.0，实测引擎 3.50.3；`sqlite354` 将驱动置于类路径首位，使用 `b7c7514` 对应的 3.54.1.0，实测引擎 3.54.1。两提交之间仅 pom.xml 变化，业务 classes 一致。驱动来源与引擎查询日志均保留。
- 全部使用安装版自带 JRE：`D:\ide\LX\resources\backend\runtime\bin\java.exe`，初始堆 128 MiB。旧启动器上限为 512 MiB；当前启动器上限为 1,024 MiB，分别测试。
- 每组全新隔离目录，顺序启动独立 JVM。每 10ms 采样堆、每 100ms 采样进程工作集，并保存 GC 日志；旧版 OOM 生成堆转储。
- 同时扫描控制台、标准错误及 H2 trace 的 OOM，避免只看子进程退出码。扫描器先用含 NUL 的 OOM 正样本验证。OOM、锁冲突、超时分别归类。

`pre` 为单执行 30 次保存，通常每轮间隔 500ms，每 5 轮更新上下文；`paced` 改为每轮间隔 2,000ms。`recovered` 先让首执行保存 20 次，再三线程各保存 20 次，每轮间隔 250ms；`raw` 不加跨执行互斥、每 5 轮更新上下文；`serial` 仅在压测中用一个信号量串行化存储操作，并每轮更新上下文，用于排除锁竞争的内存对照。`reconstructed` 为单执行 30 次保存、每轮更新上下文。

## 17 组实测

峰值为 JVM 堆已使用量，工作集另列，单位均为 MiB。保存计数包含历史导入与首次活动执行保存；还原数为活动执行数。`raw/serial` 名称只表示预定策略，旧版三对象场景在单执行预热阶段即失败，尚未进入三线程阶段。

| 场景 | 结果 | 堆峰值 | 保存 / 上下文写入 / 还原 | 工作集峰值 |
| --- | --- | ---: | ---: | ---: |
| h2-pre-single-512 | OOM | 504 | 39 / 5 / 0 | 698.8 |
| sqlite-pre-single-512 | PASS | 157 | 49 / 7 / 1 | 316.6 |
| h2-recovered-raw-512 | OOM | 503 | 35 / 6 / 0 | 757.6 |
| sqlite-recovered-raw-512 | SQLITE_BUSY | 315 | 56 / 9 / 0 | 454.9 |
| h2-recovered-serial-512 | OOM | 507 | 33 / 15 / 0 | 786.2 |
| sqlite-recovered-serial-512 | PASS | 494 | 100 / 83 / 3 | 638.9 |
| sqlite-recovered-serial-1024 | PASS | 534 | 100 / 83 / 3 | 677.7 |
| h2-reconstructed-single-512 | OOM | 506 | 25 / 4 / 0 | 735.6 |
| sqlite-reconstructed-single-512 | PASS | 473 | 51 / 31 / 1 | 623.9 |
| h2-pre-single-512-repeat | OOM | 507 | 39 / 5 / 0 | 690.6 |
| h2-pre-single-512-paced | OOM | 499 | 39 / 5 / 0 | 684.7 |
| sqlite-pre-single-512-paced | PASS | 153 | 49 / 7 / 1 | 321.8 |
| h2-pre-single-1024 | PASS | 989 | 49 / 7 / 1 | 1287.6 |
| sqlite354-pre-single-512 | PASS | 166 | 49 / 7 / 1 | 341.4 |
| sqlite354-recovered-raw-1024 | SQLITE_BUSY | 357 | 56 / 9 / 0 | 510.8 |
| sqlite354-recovered-serial-512 | PASS | 488 | 100 / 83 / 3 | 642.6 |
| sqlite354-recovered-serial-1024 | PASS | 793 | 100 / 83 / 3 | 978.7 |

合计 9 组通过、6 组 OOM、2 组上下文锁冲突。SQLite 10 组均未 OOM，其中 8 组完成。串行化对照通过不能替代真实并发验收。

新版成功场景另起进程进行完整 Execution 对象的流式 SHA-256 指纹比对，按场景设定调整状态、完成时间及计数后，158 份检查点全部一致；正文文件数也与执行行数一致。指纹覆盖当前模型可序列化的请求、消息正文、图片与工具记录等字段。将读取对象的 `modelAttempts` 加一后，验证器退出码为 1，明确报告指纹不一致；正常运行退出码为 0。变异仅修改验证进程内对象，不修改文件。

## 已复现的内存原因

事故前数据的单执行场景在 512 MiB 下重复两次，以及放慢至每 2 秒保存一次，均在 20 次循环保存成功后、下一次保存时失败。常规重放的错误路径包括 `WriteBuffer.grow → ValueDataType.writeString`；重复组还出现与首次事故一致的 `Record$Type.write` 撤销记录序列化路径。

`h2-pre-single-512` 的 434,200,882 字节堆转储中：

- `byte[]` 浅大小合计 415,563,231 字节，约 396 MiB。
- H2 `CacheLongKeyLIRS` 保留约 232,381,355 字节，约 222 MiB，可见页面引用多份大字符串。
- `WriteBuffer` 底层已有 78,382,851 字节缓冲区，约 75 MiB；当次扩容申请 117,574,276 字节，约 112 MiB，失败时旧缓冲区仍存在。
- 可见多份底层 15,482,848 字节的 UTF-16 字符串，以及执行行、上下文行的撤销记录。

因此单个 UTF-8 文件大小不能代表写入时总堆占用；已观测到页面保留、多份字符串及缓冲扩容共同占用。重建样本另有一次在 Jackson TextBuffer 扩容时失败，不能把六次 OOM 都写成同一个分配点。

旧版改成 1 GiB 后此轮完成，但堆采样峰值达 989 MiB。新版同组事故前原始数据在 512 MiB 下完成，峰值分别为 153、157、166 MiB。这支持迁移对该持久化内存路径有实质改善；有限组数和固定负载不提供线上 OOM 概率，也不证明长期无泄漏。

## 新发现：上下文事务并发冲突，仍需修复

两个真实并发场景均得到：

```text
FAILURE phase=CONCURRENT
CannotAcquireLockException: SQLITE_BUSY_SNAPSHOT
ModelContextService.replace(ModelContextService.java:55)
```

一个使用 SQLite 3.50.3、512 MiB，另一个使用 SQLite 3.54.1、1 GiB。失败时堆峰值分别为 315、357 MiB，均不是 OOM。

`ModelContextService.replace` 在同一事务先 `findSummary`，再序列化正文、执行更新。其他连接在此间提交写入后，原读取快照不能直接升级写事务。R2 的整笔新事务重试目前只覆盖执行检查点保存，没有覆盖上下文入口；升级驱动、加堆及等待写锁均不能替代该事务处理。

下一步应让上下文保存入口也具备整笔新事务重试，并将序列化放在短写事务之外；用不同真实会话的上下文替换与检查点保存混合并发补回归，再取消压测信号量复验。当前不能用受控串行通过宣称多 Agent 并发已验收。

本次不修改业务实现或框架；模型请求、HTTP 响应、真实工具执行、完整应用常驻对象、NSIS 安装验收不在此次离线重放范围。根执行原始正文缺失的边界也仍然存在。

## 本地复跑与证据

完整私有目录：

```text
C:\Users\summit\.lingxi\diagnostics\h2-root-cause-20261030-153813\first-oom-replay-20261031-011122
```

目录保留 `ExportFirstOomDataset.java`、`FirstOomScenarioReplay.java`、`SavedCheckpointVerifier.java`、`RunMatrix.ps1`、`RunSupplement.ps1`、数据清单与哈希、`all-results.json`、每组日志/GC/独立数据库、H2 堆转储及解析结果。原始正文和运行配置留在本地，不进入 Git。

独立新目录准备相同清单后，单组运行格式如下；输出目录必须不存在旧库：

```text
java -Xms128m -Xmx512m -cp <tool;对应版本classes;对应版本lib/*> FirstOomScenarioReplay <h2|sqlite> <数据目录> <pre|recovered|reconstructed> <全新输出目录> <1|3> <轮数> <间隔毫秒> <上下文更新间隔> <raw|serial>
```

首次事故日志、重放日志及内存分析应共同阅读。`all-results.json` 含实际计数、退出码、时间与工作集；`artifact-hashes.json` 固定重放源码、清单和汇总；`evidence-integrity.json` 固定压测后的证据校验结果。正常、变异指纹日志分别为 `semantic-verification.log`、`semantic-mutation.log`。
