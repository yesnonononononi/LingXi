# H2 切换与回退

2026-11-02：源码已统一为 H2 文件库，检查点正文保留文件存储。代码变更不代表已迁移用户数据、替换安装版或重启服务。

## 升级前

1. 停止安装版与开发后端，备份整个数据目录及配置目录。SQLite 的主文件、WAL、SHM 和检查点必须来自同一停写时点。
2. 在真实数据目录之外准备旧库副本与检查点目录。不要复制仍在写入的主库文件。
3. 为 H2 准备一个空目标目录，不覆盖已有数据库。

## 迁移与校验

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Migrate-SqliteToH2.ps1 `
  -Source D:/backup/lingxi-copy/lingxi.sqlite `
  -Checkpoints D:/backup/lingxi-copy/checkpoints `
  -Target D:/backup/lingxi-h2-ready

powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Migrate-SqliteToH2.ps1 `
  -Verify -Source D:/backup/lingxi-copy/lingxi.sqlite `
  -Checkpoints D:/backup/lingxi-copy/checkpoints `
  -Target D:/backup/lingxi-h2-ready
```

两次命令必须成功退出，清单必须为 `verified=true`。迁移会比对逐表行数与全字段指纹、正文文件指纹，校验 identity 起点，保持时间的 UTC 毫秒语义。大文本使用真实 H2 CLOB。

`snapshot_file` 保存文件标识，实际正文路径为 `checkpoints/<executionId>/<fileId>.json`。缺正文或指纹不一致必须失败，不允许手改清单放行。

停库状态下，把已验证的目标数据集合放到最终位置，再离线修改配置目录内 `user-configs.json` 的 `dataDir`。启动后核对历史会话、上下文、审批/选择恢复、后台任务与检查点恢复；确认前保留旧库和配置备份。

## 行为变化

- SQLite 不再是运行期选项，旧的引擎开关不会切换数据库；只含旧数据的目录会在建库前拒绝启动。
- H2 数据目录必须停库搬迁。运行期修改会返回中文处置提示，原配置与目标文件保持原样。
- SQLite 驱动仅保留在测试和离线迁移工具作用域，不进入应用包。旧版 SQLite DDL 只作为测试夹具保存。
- 不恢复历史整段检查点入库或正文缓存，不通过回滚旧切库提交实施升级。

## 回退边界

H2 尚未承接新写入时，可停止新版，恢复旧应用、SQLite 数据集合和配置备份。

H2 已承接新写入后，旧 SQLite 只代表迁移时点。直接切回会丢失此后的会话、工具状态与恢复进度。当前没有 H2 到 SQLite 的反向增量迁移工具，此时应保留 H2 数据并修复问题，或另行设计数据回迁。

## 构建验证

```powershell
mvn -o -B test
mvn -o -B -DskipTests package
powershell -NoProfile -File scripts/Verify-PureH2Package.ps1 -Jar target/dp-0.0.1-SNAPSHOT.jar
```

变异门禁 `tools/qa/Run-MutationGate.ps1` 在每次测试后按原始字节还原文件，建议在独立源码副本中运行。OOM 微负载的旧门禁未获重新放行；功能回归及受限堆测试通过也不能替代长期运行与安装版验收。
