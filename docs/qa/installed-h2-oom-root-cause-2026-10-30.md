# 安装版 H2 写盘内存耗尽与文件损坏调查

## 结论

2026-10-30 安装版 LX 的故障链为：H2 后台写盘时申请大块堆内存失败，进入 panic；旧版 H2 在 panic 后仍能继续后台提交，最终持久化了失效页引用。会话列表和“补充并恢复”读取 `execution` 时触发缺块异常。

首次内存错误与文件损坏均已取得本机证据；panic 后继续提交的引擎缺陷已用独立小库复现。尚未取得故障时的 heap dump，因此不能把内存耗尽精确归因于某一条快照、图片或某个在途请求。

## 安装产物与证据保全

- 运行产物：`D:\ide\LX\resources\backend\app.jar`，当日进程 PID 8284，09:05 启动，15:37 退出。
- 从安装包提取的 H2 为 `2.3.232`，SHA-256 与本机用于诊断的同版本 Maven 包一致：`8DAE62D22DB8982C3DCB3826EDB9C727C5D302063A67EEF7D63D82DE401F07D3`。
- 从安装版 `app.asar` 提取的启动器确认堆参数为 `-Xms128m -Xmx512m`。
- 用户退出安装版后，以排他读取方式确认库文件已释放，再复制证据库和工作库。
- 原库 708,292,608 字节；原库、证据副本及诊断结束时的原库 SHA-256 均为 `48089C21D099C43CA9450108ABF9CAB2EABEF1122C74448D88BB60FC12BBC6F9`。
- 本机证据目录：`C:\Users\summit\.lingxi\diagnostics\h2-root-cause-20261030-153813`。目录包含完整数据库与业务日志，不随本报告提交。

## 故障时间线（北京时间）

| 时间 | 证据 |
| --- | --- |
| 15:12:28.302 | 安装版日志记录根执行恢复。时间接近只是相关性，不能单独认定该请求耗尽内存。 |
| 15:12:28.721 | `lingxi.trace.db:15234` 首次记录后台 flush 失败：`OutOfMemoryError: Capacity: 146319967`。 |
| 15:12:30.157 | trace 记录 `The database has been closed [90098-232]`，异常原因仍是上述 OOM。 |
| 15:12:34.204 起 | Druid 重建连接，出现 `OverlappingFileLockException`。这是 OOM 后的异常，不能反过来作为双进程同时写库的证据。 |
| 15:13–15:37 | 库内仍产生新 chunk。安装版完整日志中的启动 PID 未更换。 |
| 15:18:09.298 | 安装版开始对会话列表报 `Chunk 57627 not found [2.3.232/9]`。 |
| 15:19:15.881、15:19:23.839、15:25:44.696 | “补充并恢复”沿 `ChatController.resume → ResumeSupplementService.accept → ExecutionResumeCoordinator.readStatus` 报同一缺块异常。 |

OOM 栈位于 `WriteBuffer.grow → ValueDataType.writeString → RowDataType.write → VersionedValueType.write → Record.Type.write → FileStore.serializeAndStore → MVStore.panic`。申请失败的缓冲区约 139.5 MiB；这不是数据库文件大小，也不是整台机器的内存上限。

## 文件损坏验证

1. 使用与安装包完全一致的 H2，在全新 JVM 中以 `ACCESS_MODE_DATA=r;IFEXISTS=TRUE` 打开副本。窗口查询及按执行 ID 读取仍报同一缺块异常，排除了“只存在于原进程内存中”的解释。
2. 直接只读遍历 MVStore 表数据树：`table.49`（`execution`）有 280 条可读记录、1 个不可读子页；该页引用 chunk 57627，当前 layout 中对应记录为 null。表内计数为 281，单独 `COUNT(*)` 成功不能证明数据可完整读取。
3. 失效引用为 `position=3846c00005c63e`，父页为 `38898018b20113`，键范围为 `[2116061439910375424, 2116061676372652032)`，包含本次根执行。
4. 官方 MVStore dump 的旧 layout 中保留了异常块记录：`chunk.e11b` 的 `livePages=fffffff8`（有符号值 -8），`liveMax=ffffffffffffea80`（-5504），而总页数为 20。存活页统计已经破坏。
5. H2 2.3.232 的 `Chunk.isLive()` 只判断 `pageCountLive > 0`；`FileStore.dropUnusedChunks()` 会移除判定死亡的 chunk 元数据和存储空间。负计数、丢失元数据和仍被表引用的页共同说明存储结构已不一致。

逐表数据树检查中，其他表的页均可遍历；这仅覆盖现存表数据树，不代表所有二级索引、LOB 引用或业务关系已经验证。官方 Recover 在副本上导出 280 条 execution 记录，不能据“导出完成”宣称全量无损恢复，未据此替换原库。

## 引擎缺陷与独立验证

H2 官方 [PR #4338](https://github.com/h2database/h2database/pull/4338) 描述了后台 panic 后继续提交、使后续 chunk 引用未写成功页面的问题；[PR #4343](https://github.com/h2database/h2database/pull/4343) 合入修复。对应[提交 1bf9ee3](https://github.com/h2database/h2database/commit/1bf9ee3)在写入和后台循环入口增加 panic 检查。

本机 H2 2.3.232 源码的 `storeBuffer` 只判断 `closed`，`writeInBackground` 只判断 `isOpen` 和只读标记，没有上述 panic 防护。实际 OOM 来自后台序列化线程，与官方问题描述的失败阶段不完全相同；二者共有的“panic 后继续写入”机制已独立验证，不能声称重放了当日全部并发时序。

探针使用全新小型 MVStore：先提交基线，再写入待提交值，注入 panic，等待后台周期；不会消耗真实堆内存，也不接触用户数据库。

| H2 版本 | panic 前版本 | 后台周期后版本 | 结果 |
| --- | --- | --- | --- |
| 2.3.232（安装版相同包） | 1 | 2 | panic 后仍推进提交版本 |
| 2.5.252（仅诊断对照） | 1 | 1 | panic 后停止推进 |

探针源码与原始输出分别保存在证据目录的 `PanicWriteProbe.java`、`panic-probe-232.txt`、`panic-probe-252.txt`；2.5.252 只测试独立小库，没有用于打开或升级原库。

## 应用侧内存压力与后续边界

安装版将整个 Execution 序列化成 JSON，写入 `execution.snapshot` 的 `CHARACTER VARYING` 列，并在进程内缓存活跃检查点。副本中可读快照最大约 806 万字符，多个当日快照约 770 万字符；大文本及旧新行版本、撤销记录、序列化缓冲区会共同占用堆。这说明 512 MiB 配额与当前持久化方式存在实际压力，但故障时缺少堆转储，不能计算各对象的精确占比，也不能认定最大可读快照就是出错快照。

后续修复需要分别处理：选择并验证包含 panic 防护的 H2 版本；控制快照写入及缓存的峰值内存；让数据库致命故障尽早停止服务；另行验证缺失检查点的恢复方案。单纯放大堆无法补回已经损坏的数据页。

本轮仅调查和保全现场，未更换安装包、启动应用或改写原库。
