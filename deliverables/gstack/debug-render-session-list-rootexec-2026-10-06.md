# 手动测试缺陷排查与修复报告：首屏无渲染 / 会话列表不加载 / root_execution_id 死列移除

**日期**：2026-10-06
**场景**：调试复盘（缺陷根因定位 + 修复 + 独立验证）
**参与成员**：排障手（gstack-investigator） + 质量门神（gstack-qa-lead）

---

## 📌 TL;DR（执行摘要）
- 整体结论：🟢 **通过** —— 用户上报的两条缺陷均已定位真因、修复并由 QA 独立验证（变异测试证明修复承重）；附带的后端 `root_execution_id` 死列已按用户决策零代价移除，后端测试全绿。
- 阻塞项数量：**0**。
- 下一步：可选收尾 —— ① 会话级实时订阅（刷新/非活跃会话也能实时更新）作为独立迭代立项；② 前端 4 条既存无关红（`reasoningEffort`）是否顺手修。

---

## 🎯 核心结论卡片

| 项目 | 内容 |
|------|------|
| Go / No-Go | 🟢 Go（两条上报缺陷可关闭） |
| 严重度分布 | 🔴 1 / 🟠 2 / 🟡 2 / 🟢 0 |
| 关键行动项 | 3 条 |
| 建议负责人 | 前端渲染链 → 前端负责人；会话级订阅设计 → 架构/前端 |

---

## 1. 各成员核心结论

### 🔧 排障手（调试与根因）
- 核心判断：两条缺陷都是**前端重构引入的回归**，且都不是"后端没发数据"，而是前端把数据接丢了。
  - 缺陷①：新建会话时把**未被 Vue 代理的裸对象**交给流式路由器，流式写入绕过响应式 → 模板不重渲染（"发完消息一片空白"）。
  - 缺陷②：`loadInitialData` 从旧文件迁到 `useChatWorkspace.ts` 时，**漏掉了写回 `localSessions` 那一行**，列表请求发了但结果被丢弃。
- 关键建议：验证缺陷①**不能靠手动读 computed**（惰性求值会假性通过），必须观察渲染副作用。

### ✅ 质量门神（QA 与发布）
- 核心判断：两条修复均**已验证**，且用**变异测试**证明"承重"——逐个回退修复，对应守卫立刻变红。
- 关键建议：把独立验证套件接入 `npm test`（已办）；后端移除需在**全新库**上验证（原缺陷真实失败态），而不是只看存量库。

---

## 2. 综合审查发现（按严重度排序）

| # | 严重度 | 类别 | 位置 | 问题描述 | 建议 | 来源 |
|---|--------|------|------|---------|------|------|
| 1 | 🔴 | 前端响应式 | `frontend/src/views/chat/useChatView.ts:279` | 新建会话分支返回**裸对象** `newSession`，未取 `localSessions` 中的响应式代理；流式写入落点绕过 Vue 响应式 → 首条消息无任何渲染 | 返回代理：`return currentActiveSession.value ?? newSession;`（已修） | 排障手 |
| 2 | 🟠 | 前端状态 | `frontend/src/views/chat/useChatWorkspace.ts:144` | `chatApi.fetchSessions()` 结果仅用于错误判定，**从未写回** `localSessions`；且 options 未持有 `localSessions`，物理上无法写回 → 左侧列表恒空 | 新增 `localSessions` option 并写回 `if (sessionsRes.ok) localSessions.value = sessionsRes.data;`（已修） | 排障手 |
| 3 | 🟠 | 后端 DDL↔PO | `init.sql` / `ExecutionPO` | 工作区 init.sql 删了 `execution.root_execution_id`，但 PO 仍映射 → **全新库** `Unknown column`、事件解析全失败、`InitSqlPoConsistencyTest` 红 | 评估后确认为**只写不读的死列**，零代价彻底移除（已修） | 排障手 |
| 4 | 🟡 | 文档失实 | `init.sql:163` | 注释仍称"委派归属在 root_execution_id"，但列已删 | 改为"归属在 snapshot 的 `lingxi.root_execution_id` 属性"（已收口） | 质量门神 |
| 5 | 🟡 | 前端既存红 | `tests/reasoningEffort.test.ts` | `useReasoningEffort.ts` 删除了 `syncReasoningEffort` 导出，4 条测试未同步 → `npm test` 非全绿 | 恢复导出或改写用例（**未动，待定夺**） | 排障手 |

---

## 3. 关键决策与验证证据

### 3.1 缺陷① —— 首条消息无渲染
- **根因链**：`ensureBoundSession`（新建分支）→ 本地裸对象 `newSession` → `handleSendMessage` → `StreamSessionRouter.bindRootSession` → 消息访问器 `() => currentRootSession?.messages` → 写入未被代理的裸数组。
- **决定性证据**（`watchEffect` 模拟模板订阅，观察渲染序列）：
  - 修复前：`["", ""]`（裸会话实际已有 2 条消息，模板却看不到）
  - 修复后：`["", "", "user:1|assistant", "user:1|assistant", "user:1|assistant:你发送的是「1」"]`
- **修复**：`useChatView.ts:279` → `return currentActiveSession.value ?? newSession;`
- **边界复核**：同一会话发第 2 条（走"已持久化会话"分支，本就不受影响）、选中历史会话后再发、会话列表为空、列表请求失败 —— 均通过。

### 3.2 缺陷② —— 会话列表不加载
- **根因**：迁文件时漏写 `if (sessionsRes.ok) localSessions.value = sessionsRes.data;`（HEAD `useChatView.ts:656` 原有此行，git 佐证）。
- **接口口径（与用户确认）**：左侧用**扁平根会话列表** `/session/list`（`SessionAPI.list(1,100)`），**不是** `/tree` —— `/tree` 是"单个会话取根+子树"，不适合做列表。
- **修复**：`useChatWorkspace.ts` 增 `localSessions: Ref<ChatSession[]>`（:11/:28）+ :145 写回；`useChatView.ts:162` 传参。
- **证据**：`loadInitialData` 后 `localSessions.length = 1`（id 为有效雪花串）。

### 3.3 缺陷A —— `execution.root_execution_id` 移除
- **评估结论（优于假设）**：**无需 `parent_turn_id` 替代 —— 该列是"只写不读"的死列**。
  - 语义是**执行归属**（委派链根执行），**真源不是该列**，而是 snapshot 里的属性 `lingxi.root_execution_id`（`ExecutionAttributes.ROOT_EXECUTION_ID`，由 `SubAgentRequestFactory` 在委派时写入子执行请求）。
  - 写该列 2 处（`LocalExecutionRepository.applySummary`、`ExecutionRegistrationServiceImpl.registerInitial`）；**读该列 0 处** —— `findSummariesByIds` 虽 select 它，但三个消费方（`ExecutionQueryServiceImpl.summariesByIds` / `ExecutionResumeCoordinator.readStatus` / `ExecutionStartupReaper`）**都不读**。
  - `parent_turn_id` 属**轮次**维度，表达不了**执行**归属，换算需跨表 2 次查 → 违反"无代价"判据，且本就不需要。
- **实施**：主代码 8 文件 + 测试 3 文件（PO/domain 删字段、repo 投影去列、applySummary 去写、record 去形参、`RequestPreparer`/`ExecutionCommand` 清理、`execution-status-schema.sql` 去列）。
- **验证**：`mvn -o test` → **431 tests / 0 fail BUILD SUCCESS**；`InitSqlPoConsistencyTest` 转绿；**全新库启动**（`LINGXI_DATA_DIR=<临时目录>`）→ 启动成功、**无 `Unknown column`**、`execution` 表 10 列与 PO 完全对齐。
- **存量库兼容**：会留孤儿列 `root_execution_id`，但 PO 不再映射 → 无害，**无需迁移**（用户当前库已实测启动正常）；原数据仍在 snapshot 属性中，可随时重建。

### 3.4 回归守卫接入
- `frontend/tests/chatLiveRenderFixes.test.ts`（实现者，2 用例）+ `frontend/tests/qaIndependentVerification.test.ts`（QA，6 用例）**共 8 条已接入** `npm test` 脚本，CI 可执行。

---

## ✅ 行动清单

| # | 行动 | 负责方 | 紧急度 | 期望完成 |
|---|------|--------|--------|---------|
| 1 | 会话级实时订阅立项：设计"GET 流为唯一事件源、POST 只做受理回执"，避免与 POST 流重复消费（正文重复追加） | 架构/前端 | P2 | 下一迭代 |
| 2 | 决定前端 4 条既存红（`reasoningEffort.test.ts`）：恢复 `syncReasoningEffort` 导出或改写用例，让 `npm test` 全绿 | 前端负责人 | P3 | 近期 |
| 3 | 清理孤儿资源 `src/test/resources/stream-legacy-schema.sql:8`（仍声明 `root_execution_id BIGINT`，全仓无 Java 引用，零影响） | 后端负责人 | P3 | 随手 |

---

## ⚠️ 待完善 / 已知局限

- **会话级实时订阅未纳入本轮**（用户决策）：当前修复保证"活跃会话发消息即实时渲染"；"刷新页面/非活跃会话也能实时更新"仍需新增会话级 GET 流订阅，且必须解决与 POST 流的重复消费问题。
- **前端 `npm test` 未全绿**：4 条失败全在 `reasoningEffort.test.ts`，属既存无关问题，非本次改动引入。
- **渲染副作用以 `watchEffect` 模拟模板订阅**（非真实 DOM diff）；机制相同，结论可迁移，但未做真实浏览器 E2E。
- **存量库孤儿列**：`~/.lingxi/data/lingxi.mv.db` 保留 `ROOT_EXECUTION_ID`，无害；不建议加破坏性 `DROP COLUMN`。
- `ExecutionCommand` 为死类（全仓无引用），本次仅删其 `rootExecutionId` 字段，未整体删除。

---

## 📚 成员产出索引

- gstack-investigator（排障手）：缺陷①②根因+修复+证据；缺陷A评估与移除（8 主文件 + 3 测试文件）
- gstack-qa-lead（质量门神）：缺陷①②独立验证（含变异测试）；缺陷A独立验证（grep 悬空检查 + 零读取方复核 + 全新库启动）；QA 套件接入 `npm test`

### 变更文件清单

**前端**
- `frontend/src/views/chat/useChatView.ts`（M：缺陷①修复 + 传参）
- `frontend/src/views/chat/useChatWorkspace.ts`（新增：缺陷②修复）
- `frontend/tests/chatLiveRenderFixes.test.ts`（新增：2 用例）
- `frontend/tests/qaIndependentVerification.test.ts`（新增：6 用例）
- `frontend/package.json`（M：test 脚本 +2 文件）

**后端**
- `src/main/java/com/summit/dp/execution/infrastructure/persistence/po/ExecutionPO.java`
- `src/main/java/com/summit/dp/execution/domain/model/Execution.java`
- `src/main/java/com/summit/dp/execution/infrastructure/repository/ExecutionRepositoryImpl.java`
- `src/main/java/com/summit/dp/execution/infrastructure/repository/LocalExecutionRepository.java`
- `src/main/java/com/summit/dp/execution/application/service/ExecutionRegistrationService.java`
- `src/main/java/com/summit/dp/execution/application/service/impl/ExecutionRegistrationServiceImpl.java`
- `src/main/java/com/summit/dp/shared/utils/RequestPreparer.java`
- `src/main/java/com/summit/dp/execution/application/command/ExecutionCommand.java`
- `src/test/java/com/summit/dp/execution/ExecutionSummaryCheckpointTest.java`
- `src/test/java/com/summit/dp/shared/utils/RequestPreparerExecutionIdentityTest.java`
- `src/test/resources/execution-status-schema.sql`
- `init.sql`（M：第 163 行注释收口）

---

> 本报告由软件工坊 AI 协作生成，关键决策请由工程负责人复核。
