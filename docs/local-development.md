# 本地开发数据隔离

IDE、`spring-boot:run` 等源码启动自动启用 `dev,local`，使用端口 8089。数据库、JSON 配置、技能、日志与沙箱状态分别位于项目 `.lingxi/development` 下。安装包使用端口 8088 和原有用户目录，两个环境可以同时运行。

数据目录是一个集合：**SQLite 库文件 `lingxi.sqlite` + `checkpoints` 目录**。库里只存检查点正文的文件标识，正文在 `checkpoints/<executionId>/<fileId>.json`；两者必须一起搬、一起备份，只搬一个就会出现「库指向不存在的正文」。

首次初始化前退出安装版和 IDE 后端，在项目根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Initialize-Development.ps1
```

脚本先独占打开一次库文件确认没有进程在写，再用驱动生成一致性快照（`VACUUM INTO`，WAL 里的提交一并合并，**不复制正在写入的主文件**），然后把检查点正文、图片、配置和技能整棵复制，并把数据库快照的 SHA-256 与 `checkpoints` 文件清单写进 `initialization.json`。开发副本只调整设置中的 `dataDir`、`skillDir`；模型、MCP、工作空间、会话等保持复制时的内容。已有开发目录不会被覆盖，后续两个环境各自修改各自的数据。

快照步骤需要 JDK 21 与 `sqlite-jdbc`：脚本默认按 `pom.xml` 里固定的版本到 Maven 本地仓库（优先 `settings.xml` 的 `localRepository`）找 jar，也可以显式指定：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Initialize-Development.ps1 `
  -SqliteJdbcJar D:\languages\mvn\repository\org\xerial\sqlite-jdbc\3.50.3.0\sqlite-jdbc-3.50.3.0.jar
```

应用内改「数据存储目录」走的是同一套语义：`SettingsDirectoryMigrator` 在**排除检查点写入的同一段窗口**里先做库快照、再复制 `checkpoints` 目录，然后落库新路径；库文件还在旧目录上写，因此必须重启后新目录才真正生效（设置页会提示「需要重启」）。

前端运行 `npm run dev` 或 `npm run app:dev`，通过 Vite 连接 8089。源码桌面客户端拥有独立 userData 和单实例锁，只连接 IDE 开发后端，不自动运行 `target` 中可能过期的 jar。

`local` 是本地专用档位，不能给安装包追加该档位。若需指定不同的开发根目录，设置 `lingxi.development.directory`；已经初始化的开发设置也需同步调整两项目录值。
