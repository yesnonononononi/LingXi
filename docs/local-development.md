# 本地开发与数据隔离

源码启动使用 `dev,local` 配置，默认后端端口 8089。数据、配置、技能、日志和沙箱状态位于 `.lingxi/development`，与安装版隔离。目录已有内容时，初始化脚本拒绝覆盖。

运行期数据库固定为 H2 2.5.252，不再提供 `lingxi.storage.engine` 开关。数据目录是一个集合：`lingxi-h2.mv.db`、`checkpoints/<executionId>/<fileId>.json`，以及迁移过的数据附带的 `migration-from-sqlite.json`。检查点正文继续使用文件。

## 初始化开发副本

先退出安装版和 IDE 后端，再执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Initialize-Development.ps1
```

脚本读取安装版设置中的数据与技能目录，保留业务配置，只把副本中的 `dataDir`、`skillDir` 改到开发目录。

- 来源是当前 H2 库：在整个复制窗口持有独占文件句柄，复制库、检查点及其他数据，校验库文件 SHA-256。正在使用的库会被拒绝。
- 来源是旧 SQLite：用驱动生成包含 WAL 提交的一致性快照，再调用一次性迁移工具转换为 H2；正文与逐表指纹校验通过才发布开发目录。SQLite 快照只在暂存目录中存在。
- 无法识别的旧版或多份 H2 库、缺少来源库、已存在的开发目录均会明确失败。

旧库转换需要 JDK 21 与 Maven 本地仓库中的固定版本 SQLite/H2 jar，可通过 `-SqliteJdbcJar`、`-H2Jar`、`-LocalRepository` 指定。H2 副本复制不依赖 SQLite 驱动。`initialization.json` 记录来源、指纹及初始化方式。

## 迁移既有 SQLite 数据

迁移必须使用停写后取得的完整副本；工具拒绝直接操作安装版和开发环境的真实数据目录。命令与回退边界见 [H2 切换与回退](h2-cutover-and-rollback.md)。

迁移工具使用 `src/main/resources/db/h2/V1__schema.sql` 建库，不能按 SQLite `TEXT` 推导生产列类型。`-DeriveSchema -AllowDerivedSchemaForDrill` 只供演练，产物始终不被标记为已验证。

## 修改目录与备份

H2 数据目录不支持运行期搬迁。停止应用后备份并复制整个数据目录，再离线修改 `config/user-configs.json` 中的 `dataDir`；设置行优先于 `lingxi.data.dir`。技能目录仍可在设置页修改。

只有 `lingxi.sqlite` 或其日志残留的目录会在创建 H2 库前被拒绝。两库并存时，启动守卫要求迁移凭据为 `verified=true` 且旧库 SHA-256 匹配。旧库保留为迁移时点的备份，运行期不写它。
