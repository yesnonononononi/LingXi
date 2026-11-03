# 纯 H2 源码收口验收

日期：2026-11-02。范围：唯一 H2 运行引擎、文件检查点、开发初始化、离线旧库迁移与打包守卫。没有迁移安装版/开发环境真实数据，没有替换客户端、停止或重启现有应用，也没有推送。

## 实现

- 默认数据源与分页固定 H2 2.5.252，移除运行期引擎开关、SQLite 初始化/时间处理/异常翻译。
- SQLite 驱动只在测试作用域；旧 SQLite DDL 仅作为迁移测试夹具保存。
- 保留 H2 CLOB、UTC 时间、唯一索引、条件更新及事务重试；补齐 H2 死锁分类。
- 旧数据在建库前被拒绝；运行期修改数据目录失败时保持文件和配置原样。
- 清单提醒整数列使用 0/1；迁移按真实检查点标识追加 `.json` 核对文件。
- 开发初始化始终产出 H2：支持停库 H2 复制与旧 SQLite 快照转换，不覆盖已验证的正文与凭据。

核心提交：`b69edbc6`；开发与迁移：`11011b1a`；打包/变异守卫：`539ecd82`。另以独立提交修复原有压缩配置断言及 OOM 重放工具编译/签名漂移。

## 验证结果

| 项目 | 结果 |
| --- | --- |
| 后端全量回归 | Maven 汇总 1,573 条，0 失败、0 错误、8 跳过，BUILD SUCCESS |
| 开发初始化追加回归 | 3 条通过；H2 副本、占用拒绝、SQLite 正文引用迁移及缺正文拒绝发布 |
| 单引擎输入/邮件契约 | 9 条通过；删除无意义的双引擎重复参数，业务断言保留 |
| 实际后端包 | 构建成功；1,333 个归档条目；H2 驱动恰好一份，SQLite 驱动与旧适配/DDL 未进入包 |
| 包扫描正对照 | 人工加入 SQLite 条目的归档被拒绝；扫描谓词自检通过 |
| 受限堆真实存储路径 | Xmx=512 MiB，夹具 13,124,512 字节，峰值 271 MiB，整段 JSON 转换 0 次，流式写入 65 次 |

全量测试在 `.run/pure-h2-final/target` 隔离构建；开发及追加测试、包构建在 `.run/h2-development/target`。全量结束后只清理了两类测试的重复 H2 参数，并对其 9 个场景定向复跑。未重复报告它们为两种数据库。

## 变异证明

以下变异在独立源码副本中运行，全部由断言或真实数据库错误检出，原始字节还原通过。编译错误及未发现测试不计为有效变红。

| 变异 | 检出证据 |
| --- | --- |
| M5：分页退回 SQLite | MybatisPlusConfigTest，H2 与 SQLITE 方言不等 |
| M9：未迁移旧库放行 | StorageEngineGuardTest，旧库及各日志残留必须拒绝 |
| M10：跳过共存迁移凭据 | StorageEngineGuardTest，无凭据/错误指纹不能 READY |
| M18：SQLite 驱动回到 runtime | StorageDriverPolicyTest，依赖作用域断言失败 |
| M19：默认 URL 退回 SQLite | 源码策略与 YAML/连接等价性断言失败 |
| M20：整笔重试次数改成 1 | 真实同行锁超时保存失败，检查点回归变红 |
| M21：整数提醒条件改回 FALSE | ChecklistPersistenceTest，真实 H2 类型比较失败 |
| 检查点扩展名修复回退 | 迁移端到端测试把有效 ck-small.json/ck-1.json 报为缺失，成功断言失败；恢复后 3 条重新通过 |

源码扫描器还用深层子目录中含 NUL 的正样本验证了递归与字节覆盖；打包扫描先验证包含旧适配/SQLite 驱动的正样本再检查真实包。

## 原始记录

```text
%TEMP%/lingxi-pure-h2-final.log
%TEMP%/lingxi-pure-h2-development.log
%TEMP%/lingxi-h2-development-restored.log
%TEMP%/lingxi-h2-input-contract-final.log
%TEMP%/lingxi-pure-h2-package.log
%TEMP%/lingxi-h2-package-canary.log
%TEMP%/lingxi-h2-contract-mutation.log
%TEMP%/lingxi-pure-h2-mutations-1631cz0b/evidence/mutation-gate.json
```

运行包：`.run/h2-development/target/dp-0.0.1-SNAPSHOT.jar`。源码未推送，安装包未重建。

受限堆结果只覆盖本轮真实存储负载，不代表长期无泄漏。历史 OOM 微负载的区分能力门禁未重新放行；长期并发运行、异常退出/备份恢复及实际客户端切换仍需发布验收。迁移步骤与回退边界见 [H2 切换与回退](../h2-cutover-and-rollback.md)。
