# 本地开发数据隔离

IDE、`spring-boot:run` 等源码启动自动启用 `dev,local`，使用端口 8089。数据库、JSON 配置、技能、日志与沙箱状态分别位于项目 `.lingxi/development` 下。安装包使用端口 8088 和原有用户目录，两个环境可以同时运行。

数据目录是一个集合：**SQLite 库文件 `lingxi.sqlite` + `checkpoints` 目录**。库里只存检查点正文的文件标识，正文在 `checkpoints/<executionId>/<fileId>.json`；两者必须一起搬、一起备份，只搬一个就会出现「库指向不存在的正文」。

首次初始化前退出安装版和 IDE 后端，在项目根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Initialize-Development.ps1
```

脚本先独占打开一次库文件确认没有进程在写，再用驱动生成一致性快照（`VACUUM INTO`，WAL 里的提交一并合并，**不复制正在写入的主文件**），然后把检查点正文、图片、配置和技能整棵复制，并把数据库快照的 SHA-256 与 `checkpoints` 文件清单写进 `initialization.json`。开发副本只调整设置中的 `dataDir`、`skillDir`；模型、MCP、工作空间、会话等保持复制时的内容。已有开发目录不会被覆盖，后续两个环境各自修改各自的数据。

快照步骤需要 JDK 21 与 `sqlite-jdbc`：脚本默认按 `pom.xml` 里固定的版本到 Maven 本地仓库找 jar（仓库路径按 `MAVEN_REPO_LOCAL` → `settings.xml` 的 `localRepository`（用户级 `~/.m2` 或 Maven 安装目录的 `conf/`）→ `~/.m2/repository` 的顺序解析），也可以显式指定：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Initialize-Development.ps1 `
  -SqliteJdbcJar D:\languages\mvn\repository\org\xerial\sqlite-jdbc\3.50.3.0\sqlite-jdbc-3.50.3.0.jar
```

应用内改「数据存储目录」走的是同一套语义：`SettingsDirectoryMigrator` 在**排除检查点写入的同一段窗口**里先做库快照、再复制 `checkpoints` 目录，然后落库新路径；库文件还在旧目录上写，因此必须重启后新目录才真正生效（设置页会提示「需要重启」）。

前端运行 `npm run dev` 或 `npm run app:dev`，通过 Vite 连接 8089。源码桌面客户端拥有独立 userData 和单实例锁，只连接 IDE 开发后端，不自动运行 `target` 中可能过期的 jar。

`local` 是本地专用档位，不能给安装包追加该档位。若需指定不同的开发根目录，设置 `lingxi.development.directory`；已经初始化的开发设置也需同步调整两项目录值。

## H2 引擎的本地开发目录

默认引擎仍是 SQLite，上面的流程与产物完全不变。只有把引擎开关切到 H2 时才走下面的差异路径：

| 项 | SQLite（默认） | H2 |
| --- | --- | --- |
| 开关 | `lingxi.storage.engine: sqlite`（缺省值，无需配置） | `lingxi.storage.engine: h2`（或环境变量 `LINGXI_STORAGE_ENGINE=h2`） |
| 库文件 | `data/lingxi.sqlite`（+ `-wal`/`-shm`） | `data/lingxi-h2.mv.db` |
| 迁移凭据 | 无 | `data/migration-from-sqlite.json`（只能由迁移工具生成） |
| 数据目录热搬迁 | `SettingsDirectoryMigrator` 做库快照后搬迁 | **不支持**：H2 库文件不能在运行中安全复制，必须先离线迁移 |
| 检查点正文 | `data/checkpoints/<executionId>/<fileId>.json` | 完全一致（`snapshot_file` 语义不变） |

H2 库只接受「从空库开始」：数据要么由一次性迁移工具从 SQLite 副本搬过来，要么什么都没有。应用启动时会校验 `migration-from-sqlite.json` 的 `verified`、重算源库 SHA-256 与 H2 侧行数，任一项不符直接拒绝启动（不静默建空库）。

### 一次性迁移工具

`tools/migrate/SqliteToH2Migration.java` 是单文件源码工具（不进 Maven 模块），`scripts/Migrate-SqliteToH2.ps1` 负责解析 jar、校验参数、规范化路径与禁区拒绝。**源与目标都必须显式传入，工具不会自动挑选源目录**。

```powershell
# 1) 先把正在使用的库复制成副本（切勿直接指向 data 下的活跃库）
$run = Join-Path $env:TEMP ("lingxi-h2-verify\" + (Get-Date -Format 'yyyyMMdd-HHmmss') + "-dev")
New-Item -ItemType Directory -Path (Join-Path $run 'source') -Force | Out-Null
Copy-Item .lingxi\development\data\lingxi.sqlite (Join-Path $run 'source\lingxi.sqlite')
Copy-Item .lingxi\development\data\checkpoints (Join-Path $run 'source\checkpoints') -Recurse

# 2) 迁移（目标必须不存在或为空；产出 H2 库 + 清单 + checkpoints）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Migrate-SqliteToH2.ps1 `
  -Source (Join-Path $run 'source\lingxi.sqlite') `
  -Target (Join-Path $run 'target')

# 3) 复算校验（只读业务数据，只刷新清单的 verified 字段）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Migrate-SqliteToH2.ps1 -Verify `
  -Source (Join-Path $run 'source\lingxi.sqlite') -Target (Join-Path $run 'target')
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `-Source` / `-Target` | 必填。`-Source` 必须是副本文件；`-Target` 迁移时必须为空目录 |
| `-Verify` | 只复算比对，不写业务数据；要求目标已有库与清单 |
| `-Schema` | H2 基线 DDL，缺省按 `src/main/resources/db/h2/V1__schema.sql`、`db/h2/V1__schema.sql` 顺序查找 |
| `-DeriveSchema` | **仅演练**：按源库结构推导 DDL。**必须与 `-AllowDerivedSchemaForDrill` 同时使用**，单独使用直接按参数错误退出（退出码 2）。产物清单 `verified` 恒为 `false`、目标目录会写 `DERIVED-SCHEMA-NOT-FOR-PRODUCTION.txt`，**不得用于应用启动** |
| `-AllowDerivedSchemaForDrill` | 演练硬开关：显式承认「本次产物不用于生产」。只在 `-DeriveSchema` 下有意义 |
| `-Checkpoints` / `-Manifest` | 检查点目录与清单路径，缺省分别是源库同级的 `checkpoints`、目标目录内的 `migration-from-sqlite.json` |
| `-Batch` / `-DatabaseName` | 批大小（默认 500）、H2 库文件名主干（默认 `lingxi-h2`） |
| `-H2Jar` / `-SqliteJdbcJar` / `-LocalRepository` | 覆盖 jar 与本地仓库解析（缺省按 pom 版本从本地仓库找） |

退出码：`0` 通过（演练模式下「指纹全对但 `verified=false`」也是 0，成功与否看 `verified` 与标记文件，不要只看退出码）；`1` 校验失败（清单已写、目标目录保留便于定位，换新目标重跑）；`2` 参数/前置状态非法（缺基线脚本、缺演练开关、目标已有库等，不产生文件）；`3` 命中路径禁区（不产生文件）。

### `-DeriveSchema` 只能演练：为什么必须配硬开关

按源库结构「推导」H2 DDL 会把 SQLite 的 `TEXT` 推成 H2 的 `VARCHAR(1000000000)`（实测 H2 2.5.252 的 `TEXT` 就是它，**不是 `CLOB`**），大文本会整段驻留内存——等于用迁移工具精准复刻历史 OOM 事故；推导版还缺 `schema_version` / checksum 等基线对象。所以：

- 只给 `-DeriveSchema` → 参数错误（退出码 2），一个文件都不建；
- 两个开关都给 → 迁移照做，但**清单 `verified` 恒为 `false`**（即使所有指纹都一致）、`failureReason` 写明「derived schema 仅供演练，不可用于生产」、目标目录写出 `DERIVED-SCHEMA-NOT-FOR-PRODUCTION.txt`（原因 / 生成时间 / 工具版本 / 该库不得被应用启动使用 / 处置办法）；
- 真实基线模式**不写**这个标记文件；
- `-Verify` 在带标记的目录里也只复算、永远不把 `verified` 改回 `true`。

`StorageEngineGuard` 只接受 `verified=true` 的清单，因此演练产物天然起不来；工程做法就是删掉整个目标目录重做。

```powershell
# 演练（只有确认「这是演练、产物不用于生产」才这么跑）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Migrate-SqliteToH2.ps1 `
  -Source (Join-Path $run 'source\lingxi.sqlite') -Target (Join-Path $run 'drill') `
  -DeriveSchema -AllowDerivedSchemaForDrill
```

注意：`-Verify` 会按你传入的 `-Source` 重算 `sourceSha256` 并刷新清单，请传**与迁移时同一份（或字节一致）**的副本；传另一份内容等价的副本也能通过（逐表指纹一致），但清单里的 `sourceSha256` 会变成新传入的那份。

**路径禁区**：`%USERPROFILE%\.lingxi\data` 与 `<仓库根>\.lingxi\development\data`，以及它们的父目录和子目录一律拒绝；脚本与工具两层都做同一判定。

迁移做了什么：逐表按主键顺序搬运（显式列清单，不 `SELECT *`），CLOB 走字符流，时间按 UTC 毫秒写入 `TIMESTAMP(3)`，有界列超长直接失败而不是截断，`GENERATED ALWAYS` 的派生列只读不写；搬完对 identity 表 `RESTART WITH max+1` 并用「插入探针 + 回滚 + 再 RESTART」验证下一个业务插入正好是 `max+1`（实测 H2 2.5.252 接受回退型 RESTART，不留 id 缺口）；检查点正文按 `executionId/snapshot_file` 整棵复制并逐文件核对 SHA-256；最后用同一份规范化编码器对两侧逐表算「行数 + 全字段指纹」，全部一致才写 `verified: true`。

故意改坏一处（CLOB 改 1 个字符、时间改 1 毫秒、删 1 个检查点正文）后重跑 `-Verify`，必须得到退出码 1 与 `verified: false`——这是「搬运没搬全」能被发现的唯一手段。

### 用 H2 引擎初始化开发目录

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Initialize-Development.ps1 -Engine h2
```

H2 模式下脚本先独占打开一次源 SQLite 库证明安装版与 IDE 后端都已退出，用 `VACUUM INTO` 生成一致性快照，再把快照迁移进开发目录（SQLite 快照只是中间产物，迁移完即删），产出 `.lingxi/development/data/lingxi-h2.mv.db` 与 `migration-from-sqlite.json`，`initialization.json` 里会额外记录 `engine`、`h2DatabaseFile`、`h2MigrationVerified`、`h2MigrationToolVersion`、`h2MigrationSourceSha256`、`h2MigrationTables`。

两条明确拒绝（H2 文件库不能热复制）：

- 源数据目录里已经有 `*.mv.db`：请先退出安装版，用离线方式迁移，或直接由安装版自身完成 H2 迁移；
- 找不到 H2 基线 DDL：脚本会失败退出，不会用推导结构建出「应用起不来的库」。

本脚本**没有任何路径会走推导结构**：它从不向迁移脚本传 `-DeriveSchema`，并且在搬完后做双重校验——目标数据目录里出现 `DERIVED-SCHEMA-NOT-FOR-PRODUCTION.txt`、或清单 `verified` 不为 `true`，都会直接失败并清掉暂存目录。演练产物想进开发目录，必须有人同时改脚本、删标记文件并手改清单，而这会被启动期守卫再拦一次。

（基线 DDL 由 H2 基线任务产出，路径为 `src/main/resources/db/h2/V1__schema.sql`；未合入时用 `-H2Schema <脚本>` 显式指定。）

### 切换前的自检清单

1. `-Verify` 通过（退出码 0、`verified: true`）；
2. 目标目录里**没有** `DERIVED-SCHEMA-NOT-FOR-PRODUCTION.txt`（有就说明是演练产物，整个目录删掉重做）；
3. `migration-from-sqlite.json` 里的 `sourceSha256` 与实际副本一致、`fileFingerprints` 覆盖全部检查点正文；
4. 目标目录里没有 `*.trace.db`、`*.lock.db` 残留；
5. 工作区与 `%TEMP%` 演练目录都已清理（验证记录只留文本）。


