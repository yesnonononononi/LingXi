# 审批后 SSE 流断裂 + 子会话历史不加载 —— 修复与验证报告

**日期**：2026-10-06
**场景**：调试复盘 + 修复交付（两缺陷）
**参与成员**：排障手（gstack-investigator）+ 质量门神（gstack-qa-lead）
**团队**：`gstack-sse-subsession`

---

## 📌 TL;DR（执行摘要）

- 整体结论：🟢 **通过（可收口/发布）**
- 两缺陷根因均已用读码 + 探针证实，修复已落地并通过**独立验证**；**变异测试四处修复点全部承重**（回退即变红）。
- 后端 `mvn -o test` → **437 tests / 0 failures**（基线 431/0，+6 全绿）；前端 `npm test` → **56 / 52 pass / 4 fail**（4 条为既有 `reasoningEffort` 红）；`vue-tsc -b --force` → exit 0。
- 阻塞项数量：**0**
- 下一步：可选清理项（删死依赖、补一条 suspend→approve→resume 集成测试、修 4 条既有红）。

---

## 🎯 核心结论卡片

| 项目 | 内容 |
|------|------|
| Go / No-Go | 🟢 **Go** |
| 严重度分布 | 🔴 0 / 🟠 0 / 🟡 2 / 🟢 4 |
| 关键行动项 | 3 条（均非阻塞） |
| 建议负责人 | 后端：SSE/执行生命周期 owner；前端：会话渲染 owner |

---

## 1. 各成员核心结论

### 🔧 排障手（根因定位与修复）
- **核心判断**：两缺陷都是「状态被提前终结 / 被整体替换」的经典问题，且都不在前端「渲染位置」而在**生命周期与数据合并**。
- **缺陷①根因**：`ChatServiceImpl#chatStream`(122) 与 `#resend`(167) 的 `finally` **无条件** `finish(emitter)`；执行因 PROMISE 挂起时 `executePrepared` 即返回 → **卡片弹出那一刻根流就被关掉**；用户批准走 v2 JSON 决策（不建流），恢复事件 `publish` 到 rootSessionId 时**无订阅者 → 静默丢弃**。
- **缺陷②根因**：子会话历史写入 `SubSessionVO.messages` 后，流结束对账 `useChatHistory.ts:83-85` 用会话树新 VO **整体替换** `cur.subSessions`（新 VO messages 为空）→ 已加载历史整段丢失；叠加 `useChatSubSession.ts` 的**一次性分页守卫**，之后点击永不重拉 → 永久「暂无消息」；另有 `SubSessionDetailDrawer` 的第二套加载/解析。
- **关键建议**：① 走路线 A（挂起不关流 + 恢复复用同一 emitter），前端零改动；② 子会话历史并入根会话同一条管线，只差「路由键 + 渲染位置」。

### ✅ 质量门神（独立验证）
- **核心判断**：两处修复**均达标**，无阻塞项；变异测试证明修复承重而非巧合通过。
- **关键建议**：标注 v1 决策接口（`POST /tool-call/decide`）为遗留/废弃；清理 `VersionedToolCallDecisionService` 的死依赖；补 suspend→approve→resume 集成测试。

---

## 2. 综合审查发现（去重合并后按严重度排序）

| # | 严重度 | 类别 | 位置 | 问题描述 | 建议 | 来源成员 |
|---|--------|------|------|---------|------|---------|
| 1 | 🟡 | 遗留双实现 | `ToolCallDecisionService.decide` / `CommandApprovalExecutor.decide`（v1 `POST /tool-call/decide`） | v1 决策**各自 `connect(rootId)` 建新流**并在 finally finish —— 若被使用会在挂起期新开一条流与旧流并存。当前前端只走 v2，故不影响本缺陷 | 标注 v1 为遗留/废弃，或删除 | 质量门神 |
| 2 | 🟡 | 死代码 | `VersionedToolCallDecisionService`(:65) | 注入的 `SseEventPublisher sseEventPublisher` **声明后从未使用** | 清理该字段 | 质量门神 |
| 3 | 🟢 | 语义偏宽 | `SseEventPublisher#disconnectRoot` | 关的是「整根会话桶」而非「本条请求流」。当前前端未使用 `subscribeSession`（全仓无消费方），无实际差异 | 未来引入常驻会话流时再评估 | 质量门神 |
| 4 | 🟢 | 边界 | `useChatHistory` 空树守卫 `length>0` | 服务端合法返回**空**子会话树时 `cur.subSessions` 不更新 → 保留陈旧子会话 | 轻微，记录备查 | 质量门神 |
| 5 | 🟢 | 边界 | `mergeSubSessionTree` | 对「树里缺失的 id」按树为准丢弃；若树接口返回**不完整**会丢该子会话已加载消息（与 `fetchSessionDetail` 同口径） | 可接受 | 质量门神 |
| 6 | 🟢 | 性能 | `handleSelectSubSessionOption` | 「确实为空」的子会话每次点击都重拉（自愈换 1 次多余请求） | 可接受 | 质量门神 |

> 两处**原始缺陷**（🔴 级）已修复并由变异测试验证承重，不计入上表。

---

## 3. 修复清单（10 文件，scope-locked）

**缺陷①（后端 4 文件）**
- `src/main/java/com/summit/dp/agent/application/service/impl/ChatServiceImpl.java`：`chatStream`/`resend` 的 `finally` 改为 **`execution == null || state != SUSPENDED` 才 finish**（挂起时保留流）。
- 新增 `src/main/java/com/summit/dp/agent/infrastructure/listener/RootStreamCloseListener.java`：`onExecutionSuspended` 空实现；`onExecutionFinished` **仅当执行所属会话 == 其根会话**才 `disconnectRoot(root)`（子执行终结不关，避免截断根的后续事件）。
- `src/test/java/.../ChatAdmissionOrderTest.java`（+2）、新增 `src/test/java/.../RootStreamCloseListenerTest.java`（4）。

**缺陷②（前端 5 文件 + package.json）**
- `frontend/src/utils/session.ts`：新增 `mergeSubSessionTree`（保留已加载 `messages` 同引用、`turns` 走 `mergeTurns` 求并、元数据取树新值）。
- `frontend/src/views/chat/useChatHistory.ts`：对账改用它，不再整体替换子会话。
- `frontend/src/views/chat/useChatSubSession.ts`：守卫放宽为「`loaded && hasMessages` 才短路」（空结果可自愈重拉）；从协同条点击即展开右侧面板。
- `frontend/src/components/chat/SubSessionDetailDrawer.vue`：统一改走 `chatApi.fetchSessionMessages`，删除第二套 `SessionAPI.messages + parseSessionMessages`。
- 新增 `frontend/tests/subSessionHistoryReuse.test.ts`（3）；`frontend/package.json` 接入。

**快照**：`.run/wip-backup-2026-10-06b.patch`

---

## 4. 验证证据（质量门神独立复跑）

| 项 | 命令 | 结果 |
|----|------|------|
| 后端全量 | `mvn -o test -DfailIfNoTests=false` | 437 / 0 / 0，BUILD SUCCESS（基线 431/0） |
| 前端全量 | `cd frontend && npm test` | 56 / 52 pass / 4 fail（4 条既有 `reasoningEffort`） |
| 类型检查 | `npx vue-tsc -b --force` | exit 0 |

**变异测试（逐点回退 → 守卫变红 → 恢复变绿）**

| # | 回退点 | 目标守卫 | 回退前 | 回退后 | 恢复后 |
|---|---|---|---|---|---|
| 1 | `ChatServiceImpl` finally 改无条件 finish | `ChatAdmissionOrderTest.suspendedExecutionKeepsStreamOpen` | 绿 | **红** | 绿 |
| 2 | `RootStreamCloseListener` 去掉根会话过滤 | `RootStreamCloseListenerTest.subExecutionTerminalDoesNotCloseRootStream` | 绿 | **红** | 绿 |
| 3 | `useChatHistory` 对账改整体替换 | `subSessionHistoryReuse` #3 | 绿 | **红** | 绿 |
| 4 | `useChatSubSession` 恢复一次性守卫 | `subSessionHistoryReuse` #2 | 绿 | **红** | 绿 |

**关键时序核实（缺陷①）**：框架 `RuntimeProcessorTemplate.process` 第 6 步 `onComplete` → … → **同步** 把终态事件写出（`AgentEventListener`）→ 之后才 `clear → unregister → notifyFinished → disconnectRoot`。故**关流不会吃掉终态事件**。挂起期间 `SseEmitter(0L)` 永不超时 + 30s 心跳，流真实存活。

---

## 5. ✅ 行动清单

| # | 行动 | 负责方 | 紧急度 | 期望完成 |
|---|------|--------|--------|---------|
| 1 | 标注/删除 v1 决策接口 `POST /tool-call/decide`（与 v2 并存且会建双流） | 后端 SSE owner | P2 | 下个迭代 |
| 2 | 清理 `VersionedToolCallDecisionService` 未使用的 `SseEventPublisher` 字段 | 后端 | P3 | 顺手 |
| 3 | 补一条 suspend→approve→resume 同一流的集成测试；修 4 条 `reasoningEffort` 既有红并给 `npm test` 的 `&&` 链加 `;`/`\|\| true` 以免 native 测试被跳过 | QA / 前端 | P2 | 下个迭代 |

---

## 6. ⚠️ 待完善 / 已知局限

- **挂起期间刷新页面**：旧流随断连被摘，前端**无会话级重订阅**（`subscribeSession` 零调用）→ 恢复事件收不到；重载/对账会用权威历史兜底（非实时）。属**既有缺口**，本次未扩面。
- **未覆盖面**：无 suspend→approve→resume 的**端到端集成测试**；无 v2 决策恢复事件投递的集成测试；`resend` 挂起分支无独立单测（与 `chatStream` 同构，仅读码）。
- **极窄边界**：若「已挂起后 `modelContextService.replace` 抛异常」，`execution` 保持 null → 会误关流；但该异常路径随即把执行收口为终态、不可再批准，实际无害。
- **既有基线红**：`reasoningEffort.test.ts` 4 条（`syncReasoningEffort` 未导出），非本次引入。

---

## 7. 📚 成员产出索引

- **排障手（gstack-investigator）**：任务 #1/#2 完成。根因（读码 + tsx 探针硬复现）、方案取舍（路线 A vs B）、10 文件改动、后端 437/0 证据。
- **质量门神（gstack-qa-lead）**：任务 #3 完成。独立复跑、读码核对、4 项变异测试、边界证伪 6/6、达标判定「均可收口」。

---

> 本报告由软件工坊 AI 协作生成，关键决策请由工程负责人复核。
