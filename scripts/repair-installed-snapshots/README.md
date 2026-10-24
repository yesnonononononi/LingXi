# 安装版快照修复

用于开发实例曾共用安装版数据库、写入 `ToolMessageEntity.exitCode` 与执行根字段 `compactionState`，导致旧安装版无法恢复上下文或重发的情况。

必须先退出安装版与开发后端，完整备份 `lingxi.mv.db` 和配置目录。工具只通过现有 MyBatis-Plus Mapper 更新 `execution.snapshot`、`session_context.content`，保留执行状态、时间和全部消息正文，并递增版本号。每条原始快照另行备份，整批修改放在一个事务内，校验失败即回滚。

将**目标安装包** `app.jar` 内的 `BOOT-INF/classes` 解压为工作目录的 `classes`，`BOOT-INF/lib` 解压为 `lib`。不能用当前框架依赖替代目标版本：自检必须先复现旧版不认识 `exitCode`，修复后仍严格拒绝其他未知字段。

```powershell
$repairClasspath = 'tool;classes;lib/*'
javac -encoding UTF-8 -proc:none -cp 'classes;lib/*' -d tool RepairInstalledSnapshots.java
java -cp $repairClasspath RepairInstalledSnapshots self-test
java -cp $repairClasspath RepairInstalledSnapshots inspect '<数据库目录>' '<原始快照备份目录>'
java -cp $repairClasspath RepairInstalledSnapshots apply '<数据库目录>' '<原始快照备份目录>'
java -cp $repairClasspath RepairInstalledSnapshots verify '<数据库目录>' '<原始快照备份目录>'
```

先在数据库副本上执行完整流程。`verify` 使用目标安装包内的 `ResendTargetResolver` 与 `ModelContextService` 验证实际读取链路，不会重新执行用户任务。最后重启安装版并检查会话加载接口。
