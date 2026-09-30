# 评估：引入业务侧 `chat_turn`、与框架 `execution` 解耦

**日期**：2026-09-30
**评估对象**：用户提出的 `chat_turn` 表设计 + 「把耦合 executionId 的点全部换成 turnId」
**结论摘要**：方向正确，**8 条补丁消除 6 条**，并连带消除我标为「真耦合」的那条；但有 **3 项新代价**，且其中 1 项（双状态机一致性）是必须先定规则的新风险。建议**分阶段实施，不要在当前这次改动上原地变形**。

---

## 一、语义切分本身是这次改造最关键的一步

用户给的两句话定义，把此前混在一起的两件事分开了：

| 概念 | 归属 | 语义 | 生命周期 |
|---|---|---|---|
| `execution` | 框架 | **运行时快照记录**，负责提供可回滚能力 | 框架自己创建/更新/终结；业务只读不写 |
| `chat_turn` | 业务 | **业务上最权威的用户单次请求记录** | 业务在「接受请求」那一刻创建，`execution_id` 可空 |

这直接击中了本次改造的结构性病根：**P7（预插执行行）的本质就是「借框架的表存业务概念」**。业务需要一条"请求已被接受"的记录，而框架的表只在 loop 起来时才写 —— 于是业务只好抢在框架之前往别人的表里插一行，再为这行擦屁股（P8）。`chat_turn` 给了这个概念自己的家，两个补丁同时消失。

---

## 二、逐条对照：能消除多少

| 补丁 | `chat_turn` 之后 | 原因 |
|---|---|---|
| **P7 预插执行行** | ✅ **消除** | 业务写自己的表，不再触碰框架 `execution`。`ExecutionRegistrationService` 整体删除 |
| **P8 启动失败收口** | ✅ **消除** | 变成业务自己的状态流转 `ACCEPTED → FAILED`；不再需要「只命中 CREATED/RUNNING」的条件 UPDATE，也不需要四层透传 |
| **P2 modelName 从 agentRequest 反解** | ✅ **消除** | turn 创建时业务直接从自己的 `RuntimeContext.modelConfig()` 写入快照，**永不回读框架对象** |
| **P3 `startAt` 语义依赖** | ✅ **消除** | `started_at` 由业务在自己的表上写，不再依赖「框架 `start()` 只设一次、`resume()` 不重置」 |
| **P4 root_execution_id 从 attributes 反解** | ✅ **消除** | 换成 `parent_turn_id` 一等列 |
| **P1 init.sql 与真库漂移** | ✅ **根因消失** | 框架 `execution` 不再需要任何业务摘要列 → 回到 6 列 → 与 `ExecutionPO` 天然一致，漂移的**产生原因**没了（只剩"删掉历史草稿列"这种纯清理） |
| **P5 状态码映射 5 处** | 🟡 **大幅减少（5 → 1）** | 展示/查询改用 `chat_turn.status`（VARCHAR，自解释）；但**框架控制**（cancel/suspend/resume 要 executionId）仍需读 `execution.status` 判定可恢复性 → 保留 1 处 |
| **P6 String↔Long 双口径** | ❌ **不变** | 框架 SPI 签名就是 `appendRound(String executionId, ...)`，转换点仍在。这是框架接口类型问题，与 executionId 耦合无关 |
| **真耦合：摘要寄生在 `LocalExecutionRepository#save()`** | ✅ **消除** | 摘要移到业务自己的表，由业务边界钩子维护；`LocalExecutionRepository` 回归纯适配器（只写 status + snapshot） |

**小计：8 条里消除 6 条、大幅减少 1 条、不变 1 条；外加那条"真耦合"也消除。**

### 额外收益（比补丁数量更值钱）

1. **两个"业务问题靠读框架表来回答"的服务基本溶解**
   - `ExecutionIdentity` 的 5 个 DB 方法（`sessionId(String)` / `rootSessionId` / `latestSuspendedExecutionId` / `activeExecutionIds`）**全部**可换成 `chat_turn` 查询 —— 而且 `uk_chat_turn_execution` 让「executionId → 轮次 + 会话」变成**一次唯一键查询**（今天要查框架表才拿到 sessionId，turnId 根本不存在）。
   - `ExecutionQueryService.latestStatesBySession`（`SessionVO.runStatus`/`lastOutcome` 的数据源）可换成 `chat_turn.status` 聚合 —— 而且业务状态才是用户该看的状态。
2. **依赖方向变干净**：业务只**读**框架表，不再**写**框架表。这是本次改造里唯一一处"业务代码承担框架职责"的消除。
3. **验收 #9（只有 USER 没有 AI 也要能看到状态）从"靠补丁实现"变成"天然成立"** —— turn 在 ACCEPTED 时就存在，`execution_id` 为 NULL 本身就是合法状态。

---

## 三、新增代价与新风险（必须先讲清楚）

### R1（最高）双状态机一致性 —— 新的主要风险
改后同一次运行有**两套状态**：`chat_turn.status`（6 值）与 `execution.status`（0–5）。它们必须同步，而同步点分散在边界钩子上（`onStart` / `onSuspend` / `onComplete` / `onCancel` / `onError`）。

- 今天的 `execution.status` 是框架在**写 snapshot 的同一个 `save()` 里**写的，**不可能与快照漂移**。这是很硬的性质。
- 一旦业务把**控制决策**（能不能 resume、能不能 cancel）改判 `chat_turn.status`，就引入新失效模式：**钩子漏触发 = 那次执行再也恢复不了**（今天不会，因为框架自己维护 status）。
- **建议的分工（强烈）**：
  - `chat_turn.status` 权威用于**展示**（UI 状态、列表徽标、历史统计）；
  - `execution.status` 权威用于**控制**（resume / cancel / suspend 的可行性判定）。
  - 这样 R1 的失效被限制在"展示降级"这一可容忍区间，不会变成"执行不可恢复"。

### R2 进程崩溃后的收尸要变成两处
今天只有 `execution` 需要启动收尸（`ExecutionMapper.markOrphanRunsFailed`：把遗留 CREATED/RUNNING 条件更新为 FAILED）。改后 `chat_turn` 也会残留 `ACCEPTED`/`RUNNING`，必须配套一条收尸（把「无存活执行的 turn」标 FAILED）。**收尸点从 1 处变 2 处，且两处要一起做，否则会出现「turn 说在跑、执行早就没了」。**

### R3 代码总量不减反增，只是耦合方向变干净
- 删：`ExecutionRegistrationService`(+Impl)、`markFailedIfUnfinished`(mapper+repo+impl)、`applySummary`、`ExecutionPO`/DDD `Execution` 的 8 个字段、`findSummariesByIds`。
- 增：`chat_turn` 的 PO + Mapper + Repository(+Impl) + 领域模型 + 应用服务 + 生命周期监听器（约 6–7 个文件）、第二次迁移。
- **净效果：文件数大致持平或略增，但"业务写框架表"这个 smell 消失。** 不要用"能少写多少代码"来评估它，要用"依赖方向对不对"来评估。

### R4 前端要全量改名
`executionId` → `turnId` 涉及 10 个前端文件（`types/chat.ts`、`utils/session.ts`、`services/chat.ts`、`useChatHistory.ts`、`useChatView.ts`、`ChatView.vue`、`ChatMessageItem.vue`、`SubAgentSidePanel.vue`、`chatSessionStore.ts`、`messageRouter.ts`），且 `session_message` 的列也要从 `execution_id` 改成 `turn_id`（列已存在但语义不同 → 需要一次真正的迁移，不是新增）。

---

## 四、DDL 评审意见（3 条具体修改建议）

1. **`UNIQUE KEY uk_chat_turn_execution (execution_id)` 会把「重新生成」这个未来需求锁死。**
   一轮一次执行 → 唯一键成立；但计划里明确"未来若支持同一问题多次重新生成，再引入 turn" —— 到那时**一轮会有 N 次执行**，唯一键直接不成立，必须迁移。
   → 建议：要么现在就把"当前执行"做成普通列（如 `current_execution_id`，普通索引），把历史执行留在框架表里；要么明确接受"重新生成时改表"。**我倾向后者 + 在注释里写明这个约束**，因为首版不做重新生成。

2. **`status VARCHAR(16)` 的 `WAITING` 与框架 `SUSPENDED` 的对应关系要写进注释。**
   `ACCEPTED`（已受理、框架执行可能还不存在）/ `RUNNING` / `WAITING`(=框架 SUSPENDED) / `COMPLETED` / `FAILED` / `CANCELLED`。建议在 DDL 注释里显式写出与 `ExecutionState` 的映射，否则半年后会有人猜。

3. **`started_at` 的写入时机需要定死。**
   你说"本轮开始执行的时间"。两种取法：(a) ACCEPTED 时刻（含排队/准入等待）；(b) 框架 `onStart` 时刻（纯执行）。计划要求"总历时包含暂停和等待审批"，所以 **(b) 更贴合**，且 `created_at` 已经承载了 ACCEPTED 时刻。建议注释里写明"取框架 onStart 时刻；未真正开始则为 NULL"。

---

## 五、建议的实施方式

**不要在当前这次改动上原地变形。** 当前工作树已经处于"8 列摘要 + 预插 + 收口"的形态且未提交、未完成验收；在它上面再叠一层 turn 化，会让 diff 完全不可读、也无法判断哪部分是回归。

建议分三步，每步可独立验证：

| 阶段 | 内容 | 验证点 |
|---|---|---|
| **S0** | 把当前形态（8 列摘要 + 预插 + 收口）**先跑通验收并提交**，作为可回滚基线 | 全量测试回到"254 / 6 既有失败"；前端 tsc + build 绿 |
| **S1** | 建 `chat_turn` 表 + 迁移 + 在 `commitUserMessage` 处**同时**写 turn 与消息（turn 为权威展示源）；历史接口增加 `turns` 字典（与 `executions` 并存） | turn 与 execution 双写一致性测试；旧数据 turn_id 为 NULL 的降级 |
| **S2** | 切换读路径到 turn（历史接口、`SessionVO.runStatus`、`ExecutionIdentity` 的 DB 方法）；**删除** P7/P8 相关代码与 `execution` 的 8 个摘要列 | 全量测试；确认 `LocalExecutionRepository` 回到纯适配器 |

**S2 完成时**，本次改造的 P7/P8/P2/P3/P4 + 真耦合才真正消失。

---

## 六、一句话总结

`chat_turn` 是对的方向 —— 它把「业务记录」和「运行时快照」这两个被我混在一起的概念分开了，**能消除 8 条补丁中的 6 条**，并让业务停止写框架表。但它不是"少写代码"，而是"换个地方写、换个方向依赖"；**最需要先定的是双状态机的权威划分**（展示看 turn、控制看 execution），否则会把今天很硬的性质（框架 status 与快照不可漂移）换成一个新失效模式（钩子漏触发就恢复不了）。
