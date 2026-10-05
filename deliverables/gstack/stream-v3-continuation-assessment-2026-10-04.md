# 流式事件 v3 精简设计：推进状态评估与收尾方案

**日期**：2026-10-04
**场景**：全流程交付（进度核查 + 基线修复 + 迁移收口决策）
**参与成员**：产品官（产品评审）+ 排障手（调试与根因）
**主理人**：沽思航 · 软件工坊 CEO

---

## 📌 TL;DR（执行摘要）

- **整体结论**：🔴 **不通过（暂缓 step 5，先修当前断链）**
- **阻塞项数量**：1 个 P0 + 2 个 P1
- **一句话**：v3 后端已就绪，但**前端 v3 入口 `attachStreamV3` 零调用**，而 `sseRouter` 已把 URL 切到 `?schemaVersion=3` —— 帧进了 v3 发布器，却由只认 `AI_MESSAGE/CARD_PENDING` 的旧 `messageRouter` 解释，**静默丢弃**。当前代码处于「协议已切、消费者未切」的断链状态。
- **下一步**：先完成前端 v3 ingress 接线（§13.1 第 4 步的真正收尾），再谈删除旧链路（第 5 步）。**不要现在就删 v2**。

---

## 🎯 核心结论卡片

| 项目 | 内容 |
|------|------|
| Go / No-Go | 🔴 **No-Go**（step 5 删除旧链路）；🟡 可 Go（基线修复 + 前端接线） |
| 严重度分布 | 🔴 1 / 🟠 2 / 🟡 3 / 🟢 2 |
| 关键行动项 | 5 条 |
| 建议负责人 | 前端接线（P0）→ 后端零 SQL 收尾（P1）→ 基线（P1）→ 清理（P2） |

---

## 1. 各成员核心结论

### 🔍 产品官（产品评审）

- **核心判断**：**step 5 前置条件未满足，不能删旧链路。** §13.1 明文要求「前端全量切至 v3 并通过验收后」才删，而实测前端根本没切。更关键的是 —— §13.2 要求的验收证据里，**零 SQL 全链测试只覆盖「带元数据的 v3 路径」，未覆盖旧链路是否已被真正旁路**；而 `AgentEventListener#broadcast` 仍保留 legacy 分支，任何缺 `rootSessionId` 元数据的执行（如旧检查点恢复）仍会走 `publishLegacy` 并承担查库与投影开销。
- **关键建议**：把「继续推进」理解为**先补完第 4 步的接线，再补 §13.2 验收证据，最后才删除**。删除不是收尾动作，而是**被验证驱动的动作**。

### 🔧 排障手（调试与根因）

- **核心判断**：**发现两处硬事实，均经主理人独立复核。**
  1. **P0 断链**：`frontend/src/services/streamV3Sync.ts:48` 的 `attachStreamV3` **零调用方**（仅被单测引用）；`useStreamV3Store` 仅被 `streamV3Sync.ts` 自己 import。前端唯一活着的渲染路径是 `useChatView.ts:873 → messageRouter.routeToSession`（旧协议词表）。而 `sseRouter.ts:85` 已固定请求 `?schemaVersion=3`。**结果：v3 帧到达后被旧路由器按未知类型静默忽略。**
  2. **基线是既有破损，非本次引入**：`SubAgentRequestFactoryTest:85` 断言旧的单行竖线格式与 `# 团队成员` 标题；而 `TeamPromptComposer` 在 `fbb897f` 已改为多行 `### 成员名单(TEAM ROSTER)` 格式，且 `TeamPromptComposerTest:34-42` 已锁定新格式并**通过**。→ **生产侧权威，测试需更新**（4 处断言）。
- **关键建议**：断链是最优先项，其余（基线、测试脚本、零 SQL 收尾）都是它的下游。

---

## 2. 综合审查发现（按严重度排序）

| # | 严重度 | 类别 | 位置 | 问题描述 | 建议 | 来源 |
|---|--------|------|------|---------|------|------|
| 1 | 🔴 | 前端接线 | `frontend/src/services/streamV3Sync.ts:48`<br>`frontend/src/views/chat/useChatView.ts:898-905`<br>`frontend/src/stores/sseRouter.ts:85` | **v3 入口零调用 + URL 已切 v3 = 断链**。`attachStreamV3`/`detachStreamV3`/`useStreamV3Store` 无任何视图调用；实时入口仍走 `messageRouter`（词表 `COMPLETE_TEXT`/`AI_MESSAGE`/`CARD_PENDING`）。v3 帧（`TEXT_DELTA`/`RESPONSE_FINALIZED`）无匹配分支被静默丢弃。 | 在 `useChatView`（及子会话路由）的实时入口接 `attachStreamV3`，让唯一 ingress 消费 v3 帧；旧 `routeToSession` 退居历史/兜底。**或**先回退 URL 到 `schemaVersion=2` 待接线完成——二选一，不能保持现状。 | 排障手（主理人复核） |
| 2 | 🟠 | 零 SQL 违约 | `src/main/java/com/summit/dp/session/infrastructure/transcript/DatabaseConversationTranscriptSink.java:45` | §12 要求「删除 execution 查询，元数据直接驱动持久化身份」，但实现仍 `executionIdentity.sessionId(executionId)`（`selectById` 查 execution 表）；**元数据里明明有 `sessionId` 却被忽略**。每轮模型响应提交都触发一次查库。 | 改为优先读 `ExecutionEventMetadata` 的 `sessionId`，缺失时才回退查询（或按 §12 彻底删除回退）。 | 主理人（源头核查） |
| 3 | 🟠 | 测试锁错行为 | `src/test/java/com/summit/dp/session/DatabaseConversationTranscriptSinkMetadataTest.java:24-30` | 该用例传入 `"sessionId":"other"` 却断言 DB mock 值 `500L` 胜出 —— **把「忽略元数据 sessionId」的错误行为固化成契约**。修 #2 时此用例会红，必须一并改对。 | 改为断言使用元数据的 `sessionId`；补一条「元数据缺失才回退」用例。 | 主理人（源头核查） |
| 4 | 🟡 | 测试基线 | `src/test/java/com/summit/dp/tools/baseTools/sub_agent/delegation/SubAgentRequestFactoryTest.java:85` | 断言旧话术格式，与 `TeamPromptComposer` 现状及 `TeamPromptComposerTest` 冲突（1 失败 / 465）。 | 按新格式更新 4 处断言（标题 `### 成员名单(TEAM ROSTER)`、单行改多行块、注意 L88 尾随空格）。 | 排障手 |
| 5 | 🟡 | 测试未纳管 | `frontend/package.json` 的 `test` 脚本 | `tests/streamV3.test.ts`（22 个 v3 用例，单独跑全绿）不在 `npm test` 清单里 —— 22 个核心 v3 用例被 CI 静默跳过。 | 加入 `test` 脚本。 | 主理人 |
| 6 | 🟡 | 验收证据缺口 | `src/test`（无压缩身份用例） | §13.2 要求「压缩身份：内部摘要不产生 v3 帧；主模型压缩工具调用响应 streamKey 与落 transcript 一致」。全仓 `grep compact` 在测试目录**零命中**。经复核框架：本仓压缩走主模型工具调用（`ToolResultType.CONTEXT_COMPACT`，`AgentLoopStepRunner:103/231-256`），**行为本身符合 §3.3，缺的是测试锁定**。 | 补一条压缩轮身份用例，把 §3.3 契约钉住。 | 主理人 |
| 7 | 🟢 | 迁移隔离 | `AgentEventListener.java:133-147` | 生产端已按元数据分流（有 `rootSessionId` 走 v3，否则 legacy），方向正确。但「旧执行恢复」仍落 legacy —— `SessionAttributeRestorer` 须确保恢复入口补齐元数据（§12 已列），否则恢复期仍走旧链。 | 复核恢复入口元数据补齐是否全覆盖（含 `ChatServiceImpl#resume`、`ToolCallDecision`、`CommandApprovalExecutor#finish`）。 | 排障手 |
| 8 | 🟢 | 死代码 | `stream/application/**`、reaper CLAIMED 分支 | §11 目标类全部仍存活且可达（`SseEventPublisher` 仍被请求级流/子会话/卡片待决/审批等多个非 v2 场景使用）；§10.1 的 reaper CLAIMED 死分支待清理。 | **现在都不删**；按下方删除时序表在验收通过后处理。 | 排障手 |

---

## 3. §13.1 分步推进状态（实测）

| 步骤 | 设计内容 | 实测状态 | 证据 |
|------|---------|---------|------|
| 1 | 修复构建/测试基线 + metadata 补 rootSessionId/historyRevision + CLAIMED 四路分流 + FAILED 上限可查询 + 删 reaper 死代码 | 🟡 **部分**：metadata ✅、`ExecutionResumeCoordinator`/`ResumeDisposition`/`ExecutionStartupReaper` ✅、CLAIMED 用例 ✅；**基线仍有 1 红（#4）、FAILED 上限表示待确认** | `ExecutionEventMetadata.java`、`ExecutionStartupReaperTest`、`ExecutionResumeTaskRepositoryTest` |
| 2 | 响应身份拦截器 + transcript 直接取 key + 压缩身份 | 🟡 **部分**：拦截器 ✅（`StreamResponseIdentityInterceptor`，order=-900，写回新 key，catchErr=false）、零 SQL 用例 ✅（`AgentEventV3ZeroSqlTest`）；**transcript 仍在查库（#2）；压缩用例缺失（#6）** | 同上 |
| 3 | v3 直投协议 + 三处分流 | 🟢 **基本完成**：协议 DTO ✅、`EventStreamPublisher` ✅、生产端分流 ✅（`AgentEventListener#broadcast`） | `StreamV3Event/Type/Payloads`、`EventStreamPublisher.java:93-113` |
| 4 | 前端唯一 ingress + JSON 命令 + bootstrap 时序 + §8.1 四条退出 | 🔴 **未完成（P0）**：状态与用例 ✅（`streamV3Store`/`streamV3Sync`/`streamV3.test.ts` 22 绿），但**未接入任何视图**，实时入口仍走旧路由器 | `streamV3Sync.ts:48` 零调用方 |
| 5 | 删除旧投影/注册器/校准/双传输/ v2 处理器 | ⛔ **前置未满足**：见 #1；删除清单见 §5 | — |

---

## 4. 交付清单

**代码变更（本次评估未改码，仅产出方案）**：无。本次为核查 + 决策，不含实现。

**待交付的修复（按序）**：
1. 前端接 `attachStreamV3`（P0）
2. `DatabaseConversationTranscriptSink` 走元数据 sessionId（P1）
3. `SubAgentRequestFactoryTest` 4 处断言更新（P1）
4. `package.json` 纳入 `streamV3.test.ts`（P2）
5. 补压缩身份用例（P2）

**测试覆盖要求**：见 §6 验收清单。

**发布检查清单 / 回滚预案**：
- 回滚点：`git diff HEAD > .run/wip-backup-2026-10-04.patch`（工作树极脏，201 文件改动，动前必须快照）。
- 前端接线若出问题，回退单点：`sseRouter.ts:85` 的 `schemaVersion` 参数改回 `2` 即可恢复旧链（后端 v2 仍在）。
- 后端改动独立可回滚（单文件改动）。

---

## ✅ 行动清单

| # | 行动 | 负责方 | 紧急度 | 期望完成 |
|---|------|--------|--------|---------|
| 1 | 在实时入口接入 `attachStreamV3`，让 v3 帧被唯一 ingress 消费；或先回退 `schemaVersion` 参数止损 | 前端 | **P0** | 立即 |
| 2 | 复核并修复「前端接线完成后 streaming 端到端可见」——用手工冒烟或 e2e 证明 delta 能上屏 | 前端 + QA | **P0** | 接线后 |
| 3 | `DatabaseConversationTranscriptSink` 优先用元数据 `sessionId`；同步修正 `DatabaseConversationTranscriptSinkMetadataTest` | 后端 | P1 | 本轮 |
| 4 | 更新 `SubAgentRequestFactoryTest` 4 处断言（以 `TeamPromptComposerTest` 为准） | 后端 | P1 | 本轮 |
| 5 | `package.json` 纳入 `streamV3.test.ts`；补压缩身份用例（§3.3） | 前端 + 后端 | P2 | 本轮 |

---

## ⚠️ 待完善 / 已知局限

- **未做端到端验证**：本次为静态核查 + 单测基线，未起服务实测「帧是否真的被丢弃」。P0 断链结论基于「URL 已切 v3 + 消费者只认 v2 词表 + v3 入口零调用」三条事实的推理链，**建议实施前用一次手工冒烟确认现象**（发一条消息，看是否有增量上屏）。
- **FAILED 重试上限的可查询表示**（§10.1 末段）本次未逐一核对 SQL，需实施时确认 `listDispatchable` 不会反复选中已耗尽任务。
- **`SessionAttributeRestorer` 恢复入口元数据补齐**覆盖面未逐一核对（#7）。
- 本报告未修改任何代码、未运行额外测试（除已记录的基线）。

---

## 📚 成员产出索引

- gstack-product-reviewer（产品官）：Go/No-Go 结论 —— step 5 No-Go，前置未满足；建议「先补 §13.2 验收证据再删除」。
- gstack-investigator（排障手）：Q1 根因（`fbb897f` 改格式、测试 `cdea3fb` 未同步，生产权威）；Q2 删除清单（「可立即删除 = 无」；`SseEventPublisher` 非 v2 专属，被多场景复用）。
- 主理人独立复核：P0 断链三事实、`DatabaseConversationTranscriptSink:45` 查库、测试锁错行为、`TeamPromptComposerTest` 锁新格式、零 SQL 与 CLAIMED 用例存在性、压缩路径为工具调用型。

---

> 本报告由软件工坊 AI 协作生成，关键决策请由工程负责人复核。
