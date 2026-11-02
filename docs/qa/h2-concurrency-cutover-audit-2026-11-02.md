# H2 并发语义收口与历史提交审计

日期：2026-11-02。审计起点：`36be93f3`（切换 SQLite）及 `2adbb9ac`（单写者事务与行锁替代）。本轮按职责收口，不整体回滚历史提交。

## 已删除或恢复

| 历史改动 | 本轮处理 | 依据 |
| --- | --- | --- |
| ChecklistWriteMonitor 全局公平锁 | 删除类、服务与仓储调用，包和源码守卫禁止恢复 | H2 父行锁可保护同一聚合，不同清单不应全局串行 |
| 清单两个 SELECT 去掉 FOR UPDATE | 恢复按 id、按会话活动行的锁定读 | 父行必须先于步骤读取和聚合裁决被锁定 |
| READ_SNAPSHOTS 线程快照表 | 删除 ThreadLocal；已落库进度/状态基线由聚合实例持有 | 同线程的新读取不能替旧对象换上较新的写入令牌，线程也不应长期持有读过的清单 |
| SessionRepository.lockById 普通读 | 恢复 H2 FOR UPDATE | 方法与领域接口承诺锁住会话状态行 |
| SessionMessageRepository.lockSessionForAppend 普通读 | 恢复 H2 FOR UPDATE，并移回幂等查询之前 | 同会话的幂等判断和追加必须在父行锁内提交 |
| EmailRepository.findByBusinessKeyForUpdate 普通读 | 恢复 H2 FOR UPDATE | 并发创建后的锁定回查要符合方法契约 |
| EmailMessageRepository.findByDedupKeyForUpdate 普通读 | 恢复 H2 FOR UPDATE | 既有去重消息的裁决必须由实际行锁保护 |
| 邮箱每次先尝试 INSERT，再靠重复键回查 | 先复用既有邮箱；创建竞争仍由唯一索引裁决，失败方锁定回查 | 已有邮箱不必每次制造约束异常 |
| 配置冻结先查快路径与嵌套事务仅试一次 | 删除 SQLite 专用分支；独立事务统一有限重试 | H2 允许外层写其他业务行时，独立提交配置版本；真实版本竞争仍需重试 |
| 建库解析器的 SQLite BEGIN/END 触发器分支 | 删除，修正单引擎说明 | H2 初始化器已拒绝这类 SQL 触发器脚本，旧库迁移工具拥有自己的离线解析 |

实现提交：`31b72abf`（清单）、`fd409589`（会话/邮箱）、`d1a051df`（冻结）、`0dce6dc9`（建库解析）。恢复的是 6 个实际锁定读入口，没有新增数据库表或改写检查点结构。

## 审计后保留

| 历史设计 | 保留理由 |
| --- | --- |
| 清单进度/状态、步骤状态的条件更新 | 拒绝过期领域对象覆盖；父行锁不能保护事务外提前读出的旧对象 |
| 活动清单、responseId、邮件业务键/去重键、恢复代际唯一索引 | H2 对不存在的行不能靠既有行锁裁决首次创建，唯一约束仍是最终事实 |
| SessionReadService.markReadIfUnread 条件更新 | 单条原子更新可维护版本和已读事实，不是模拟行锁的全局串行器 |
| 恢复任务先插后查及版本条件领取 | 幂等与代际竞争仍存在，恢复旧的先查再插只会扩大竞争窗口 |
| 受理前独立冻结配置 | 缩短受理事务并保证执行引用已提交的不可变版本；不再以 SQLite 为强制限制 |
| 邮件消费冲突文案与条件批量更新 | H2 同样会发生同一消息的并发消费，不能静默吞掉消费失败 |
| 整笔事务重试、每条执行独立回收 | H2 也有锁超时/死锁；短事务减少锁和回滚副本存活时间 |
| 通用 LIMIT/OFFSET、显式更新时间 | H2 可直接执行；更新时间是恢复/清理的业务事实，不应机械改回旧方言或默认值依赖 |
| 文件检查点与排除写入的复制窗口 | 库引用与正文文件仍需保持一致，不能恢复大正文入库与整段缓存 |
| LocalExecutionLock 与工具 SERIAL_MUTATION 策略 | 分别保护同一执行身份、文件和命令副作用，不是本次 SQLite FOR UPDATE 替代物 |
| SQLite 测试依赖、离线迁移工具、旧数据启动检测 | 仅负责读取既有数据及拒绝错误升级；SQLite 不进入运行包，也不作为运行期选项 |

`36be93f3` 中的其余业务持久化改动逐项复核：执行回收与恢复任务主要是注释/时间口径，MCP/Provider 为 JSON 真源说明，SessionMapper 使用通用分页；驱动、建库、类型、目录迁移和连接池已经由上一轮纯 H2 收口替换。

## 回归与变异

- 清单持久化、领域、提醒及循环定向回归 76 条通过；纯活动行锁定读与源码策略追加 5 条通过。
- 会话/邮箱真实锁定读、响应幂等、会话状态和运行配置定向回归 56 条通过。
- 真实事务验证：同一清单等待父行提交，不同清单可以并行；另一次同线程读取不能替旧聚合刷新写入基线。
- 外层事务已写会话行的两个线程同时取得同一配置版本号，唯一约束拒绝一方后在新事务中重试成功；外层回滚不撤销已提交的两个配置版本。
- 独立源码副本中去掉按 id 行锁、恢复全局串行锁、借用其他读取的基线、恢复嵌套仅试一次，均由对应测试检出。
- 活动清单行锁的首个变异逃逸：原提醒测试会在后续 UPDATE 阻塞，不能证明 SELECT 持锁。新增只读测试后，去掉活动行 FOR UPDATE 导致断言失败，恢复后通过。
- 再移除会话与邮箱 4 个仓储 FOR UPDATE，真实连接锁契约测试 4/4 变红。
- 全量复跑发现 UTC 测试夹具只接受三位毫秒，无法解析 H2 输出的 `.7`。`48b9888` 改为接受 ISO 可变精度；真实 H2 的 0/7/70/700 毫秒与 UTC 默认值共 6 条通过。恢复三位限定后，4 个精度场景中 2 个解析失败；没有改动运行期时间处理器。
- 静态自检先用嵌套目录中含 NUL 的正样本验证扫描覆盖与命中，再检查本轮修改的 20 个现存 Java 文件及全部 583 个生产 Java 文件；没有新增 `var` / JDBC 调用，生产源码没有旧串行锁或线程快照缓存符号。

## 全量与内存记录

首次全量：1,576 条，1 失败、0 错误、8 跳过。失败仅为受限堆峰值 419 MiB 超过原有 360 MiB 门槛；子进程 RESULT=OK、无 OOM、整段 JSON 转换 0 次。没有修改堆参数、夹具或断言阈值。

第二次全量：1,576 条，1 失败、1 错误、8 跳过。峰值门槛测到 388 MiB，另一个错误是上述 UTC 夹具的小数位解析缺陷，已单独修复并补变异。

隔离对照：上一轮构建峰值 318 MiB，当前构建 248 MiB，两者均通过原门槛。首次全量的高峰记录不能抹去，也不能仅凭后一次通过证明峰值稳定。检查点、上下文及大文本的 7 个主要受测生产类与上一轮构建逐字节相同，SHA-256 记录在 `lingxi-h2-heap-class-comparison.json`；这不代表已证明完整进程的长期内存稳定。

后端包重新构建成功，`Verify-PureH2Package.ps1` 检查 1,331 个归档条目通过；带入 `ChecklistWriteMonitor$1.class` 的变异包被拒绝。SQLite 测试依赖没有进入运行包。

修复 UTC 夹具后的最终全量：1,580 条，0 失败、0 错误、8 跳过，BUILD SUCCESS。受限堆峰值 317 MiB，通过原有 360 MiB 门槛；最终通过不抹去前两轮峰值波动，也不等于长期运行验收。

原始记录位于 `%TEMP%`：

```text
lingxi-h2-checklist-lock.log
lingxi-h2-lock-contracts.log
lingxi-h2-active-read.log
lingxi-h2-row-lock-mutations-a1sh1urq/evidence/results.json
lingxi-h2-row-lock-mutations-a1sh1urq/evidence/results-final.json
lingxi-h2-active-read-mutation.log
lingxi-h2-repository-lock-mutation.log
lingxi-h2-concurrency-final.log
lingxi-h2-concurrency-final-r2.log
lingxi-h2-concurrency-final-r3.log
lingxi-h2-heap-prior-control.log
lingxi-h2-heap-current-control.log
lingxi-h2-heap-class-comparison.json
lingxi-h2-utc-fraction.log
lingxi-h2-utc-fraction-mutation.log
lingxi-h2-concurrency-package.log
lingxi-h2-global-monitor-package-canary.log
```

本轮不迁移真实数据、不修改框架仓、不替换安装版、不重启现有应用、不推送。
