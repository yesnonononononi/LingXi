# SQLite + 文件检查点改造：终局验收记录（R1–R6 闭环）

日期：2026-10-31。基线提交 `be3cd21`（R6 修复 `1296ded`，QA 用例 `5ead91f` / `be3cd21`）。
本记录**取代**早前「已知缺陷 0、全部收口」的结论：那份结论已被独立复核
（`docs/qa/sqlite-file-checkpoint-independent-review-2026-10-31.md`）推翻，随后由真实事故重放
（`docs/qa/first-oom-desktop-pet-replay-2026-10-31.md`）再补一项缺陷，共 R1–R6 六项，全部修复并复验。

## 1. 结论

| 项 | 结果 |
| --- | --- |
| 后端全量 `mvn -o clean test` | `Tests run: 1481, Failures: 0, Errors: 0, Skipped: 8` / `BUILD SUCCESS` |
| 打包 `mvn -o package -DskipTests` | `BUILD SUCCESS`，`target/dp-0.0.1-SNAPSHOT.jar`（64,427,387 字节） |
| 打包依赖构成 | `BOOT-INF/lib` 内仅 `sqlite-jdbc-3.54.1.0.jar`，**h2 零命中**；驱动内含 `org/sqlite/native/Windows/x86_64/sqlitejdbc.dll` |
| 前端清理用例 | `tests/executionCleanup.test.ts` + `tests/executionCleanupOrphanScan.test.ts` = 12/12 |
| 真实事故重放（raw 并发档） | R6 classes 下两组 × 4 次全部 PASS；无 R6 的冻结 classes 对照两组均 FAILURE（exit 4） |
| 已知缺陷 | R1–R6 全部关闭；另有 2 处**已缓解但未重构**的读后写入口（见 §4），以及 1 项 P3 产品观察项 |

不是「缺陷 0」的措辞：R1–R6 是六次真实缺陷修复，最后这一轮（R6）才把「多执行并发写上下文」这条路径关掉。

## 2. R1–R6 一览

| 编号 | 缺陷 | 提交 | 独立复核方式 |
| --- | --- | --- | --- |
| R1 | 在途登记释放非原子，清理器会删掉另一笔已发布未提交的正文 | `e9dff12` | 变异回旧三步 release → 用例红 `Expected TimeoutException ... nothing was thrown` |
| R2 | 不同执行并发保存检查点，真实事务下报 `SQLITE_BUSY_SNAPSHOT` | `b400215` | 变异 `SAVE_MAX_ATTEMPTS=1` → 并发用例红 `CannotAcquireLockException: [SQLITE_BUSY_SNAPSHOT]` |
| R3 | 驱动 3.50.3 处于官方 WAL-reset 损坏缺陷影响区间 | `b7c7514` | 实查 `SQLITE_VERSION=3.54.1 / JOURNAL_MODE=wal / DRIVER=3.54.1.0` |
| R4 | 仅剩孤儿文件时预览判「无可清理」，UI 按钮禁用并阻断后续游标扫描 | `78050b8` | 变异退回只看行数 → 前端 2 例红；`hasUnscannedFiles` 恒 false → 后端 1 例红 |
| R5 | OOM 变异证据受 spy 调用历史影响，归因需按计量方式区分 | QA 报告 | 保留型 spy 字符串中转 OOM(506 MiB)；不保留历史 438–476 MiB；流式 138–200 MiB、整段转换 0 |
| R6 | `ModelContextService.replace` 事务内先读摘要后升写，真实并发报 `SQLITE_BUSY_SNAPSHOT` | `1296ded` | 变异 `DEFAULT_MAX_ATTEMPTS=1` → 上下文并发用例 3/3 红 + 检查点并发用例红；主理人与 QA 各自独立复现 |

## 3. R6 修复要点（本轮唯一新增的主干修复）

- 新增共享 `com.summit.dp.shared.persistence.TransactionRetryTemplate`：每次重试 `REQUIRES_NEW` 开**全新事务/新快照**
  （`SQLITE_BUSY_SNAPSHOT` 只能靠丢弃整笔事务解决，`busy_timeout` 对「读锁升写」无效）；
  只对 `CannotAcquireLockException` / `SQLTransientException` / SQLite 5 / 6 / 517 / 262 重试，
  4 次上限 + 20/40/60ms 线性退避，耗尽如实上抛；**调用方已有事务时只跑一次**（谁拥有事务谁拥有重试权）。
- `ModelContextService.replace`：序列化移到重试边界之外（几十 MB 正文只序列化一次），重试只重放「读摘要 → 版本条件写」；
  仍走领域方法、仍只读摘要不读旧正文、不新增缓存、正文仍在 SQLite。
- R2 的检查点保存改用同一工具，删除重复实现；`ChatTurnLifecycleProjector` 同样改整笔重试；
  `ChecklistServiceImpl` 的 `updateStep` / `modify` / `delete` 三条写路径补上 `ChecklistWriteMonitor`（原来漏配）。

## 4. 读后写入口审计结论（还有什么可能复发）

| 入口 | 处置 | 理由 |
| --- | --- | --- |
| 检查点保存、上下文替换、轮次投影 | 整笔新事务重试 | 事务内先读后写的唯一正解 |
| 消息追加、邮箱建箱、恢复任务入队 | 写先行 + 唯一索引裁决 | 事务第一条语句即写，无过期快照窗口 |
| 会话已读位、任务服务、运行配置冻结、用户/模型/provider 配置 | 不需要修 | 单条条件更新 / 各自独立事务 / 无读后写 |
| 清单写（`ChecklistServiceImpl`） | 进程内写监视器串行化 | 读聚合按规则改写，压不成单条条件更新；局限为单 JVM |
| `SessionReadService.onExecutionStateChanged`（`BEFORE_COMMIT`） | **未修**，已缓解 | 跑在调用方事务内，另开事务会破坏原子性；靠版本条件写 + 明确业务异常 + 下一次事件自愈 |
| `EmailServiceImpl.consumePending` | **未修**，已缓解 | 冲突翻成可重试业务异常，消息保持 PENDING、下一轮轮询自愈；重试策略属调度层 |

后两处不会静默丢数据或静默覆盖，但**在极端并发下仍可能向上抛可重试错误**，这是已知取舍，不是「无缺陷」。

## 5. 用户三条终验（终局状态）

1. **删除本地开发环境 H2 库后正常运行 —— 通过**（本轮在 `be3cd21` 上再验一次）
   删除 `.lingxi/development/data/lingxi.mv.db` + `lingxi.trace.db` 后以 `--spring.profiles.active=dev,local` 冷启动最新包：
   `Started LingXiApplication in 6.189 seconds` + `SqliteSchemaInitializer: SQLite 建库完成: executed=1, total=1`，
   自动生成 `lingxi.sqlite` / `-wal` / `-shm`；`GET /execution/cleanup/preview` 返回
   `{"executionCount":"0","filesNeedScan":false}`。安装版路径为 `%USERPROFILE%\.lingxi\data`，与开发环境路径区分。
2. **快照落文件、UI 可手动清理 —— 通过**
   正文 `<数据目录>/checkpoints/<executionId>/<32位hex>.json`；`POST /execution/cleanup` 真机验证：
   COMPLETED 行+正文+空目录删、SUSPENDED 行+正文+目录留、无行孤儿文件与 `.part` 回收；
   R4 修复后只剩孤儿文件时按钮仍可用并能发起第二轮扫描（前端 12/12）。
3. **OOM 可复现且变异变红 —— 通过**
   512 MiB 受限堆守卫在 360 MiB 阈值下绿（流式峰值 138/164/200 MiB、`CHECKPOINT_WHOLE_DOCUMENT_STRINGS=0`）；
   变异回整段 `writeValueAsString` → 子进程 `OutOfMemoryError`、退出码 3、断言红；还原后复绿、`git diff` 无残留。
   归因按 R5 修正口径：字符串中转在保留 spy 调用历史时 OOM，不保留时峰值抬到 438–476 MiB。

## 6. 未覆盖项（如实保留）

1. NSIS 安装包真机安装 → 启动 → 读写冒烟未做（只验证 jar 依赖构成、JNI 加载、打包链路）。
2. 完整 `npm run test:all` 未跑（链内有改造前既有历史红灯），只跑清理相关的两个前端文件。
3. 安装版真实进程总内存（Electron + 后端）未测，只测 JVM 堆。
4. 前端验证走 node 假渲染器，非真实 Electron/浏览器渲染。
5. 行/分支覆盖率未采集（仓库无 jacoco，离线不新增插件）。
6. 真实重放中「上下文替换重试分支」未被真实触发（4 次绿跑的重试都在检查点保存路径），该分支只有单测层证据。
7. P3 观察项：受保护执行存在时 `filesNeedScan` 恒 true → 清理按钮常亮、点击空转、文案可能误导，待产品决定是否收窄判定。

## 7. 证据索引

- 独立复核：`docs/qa/sqlite-file-checkpoint-independent-review-2026-10-31.md`（`0810e59`）
- 真实事故重放：`docs/qa/first-oom-desktop-pet-replay-2026-10-31.md`（`a7f2d7f`）
- R6 交付记录（含审计表）：`.lingxi/r6-delivery.md`
- QA 报告第 3 版：`.lingxi/qa-report-sqlite-r3.md`（取代第 2 版；第 1 版作废）
- 内存计量报告：`.lingxi/qa-sqlite-memory-report.md`（按 R5 修正）
- 交付报告：`.lingxi/delivery-sqlite-file-checkpoint.md`
