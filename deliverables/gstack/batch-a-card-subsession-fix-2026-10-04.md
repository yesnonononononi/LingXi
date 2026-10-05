# 批次 A：迁移验收补齐 + 第 2／3 组旧状态删除

**日期**：2026-10-04
**场景**：跨模块迁移验收（场景 3／5／6 + PLAN 专项 + 恢复语义）+ 第 2 组旧事件入口删除 + 第 3 组兼容消息状态删除
**状态**：🟡 **4A 完成；4B 验收待补齐** —— 三处评审问题已修（USER 提交丢弃 / 快照覆盖实时行 / 操作入口回归），「清空当前会话」已禁用待语义确定。

---

## 📌 TL;DR

- **计划卡链路已闭合**：`CreatePlanTool` 登记 PLAN → `ToolCallReadinessService` 发 `TOOL_CALL_UPDATED` → `streamV3Store.tools` → 适配层派生卡片 → `PlanCard` → JSON 决策回执更新同一实体。全程不需要 `CARD_PENDING / AI_MESSAGE / COMPLETE_TEXT`。
- **「动态任务清单」表述已收紧**：仓库里**没有**独立生产端、处理分支或组件；只存在 `PLAN_UPDATE` 的**遗留类型声明**（已删）。
- **子会话生产端投递缺陷（P0）已修**：投递用 rootSessionId、实体归属用 sessionId；根身份**沿业务服务从源头透传**，观察者零查询；缺根身份**告警并跳过**，全链路无任何「回落自身会话」。
- **本轮又暴露并修掉一个渲染缺陷**：同一轮次在恢复后换 streamKey 时，活响应**覆盖**了已提交正文 → 改为同轮次**追加**。
- **第 3 组兼容消息状态已删除**：旧消息同步写入（含 `applyAuthoritativeToolCall`）、三张子会话重复表、`chatSessionStore` 的消息子系统；会话选择 / 滚动 / 分页请求状态按要求保留。
- **第 2 组旧入口已删除**（前端 2 文件 + 后端 2 类 + 事件类型/分支/测试桩 + 前端遗留类型声明）。
- 门槛：`vue-tsc` 0 错、`npm test` **92 + 4** 全绿、`vite build` 通过、后端 `mvn -o test` **484 / 0**。

---

## 🎯 核心结论卡片

| 项目 | 内容 |
|------|------|
| Go / No-Go（进入第 3 组） | 🟢 **Go** |
| 本轮缺陷 | 🔴 1（P0 投递）/ 🟠 1（渲染覆盖）/ 🟡 3（评审纠正） |
| 新增可执行证据 | 后端 2 条 + 前端 2 条（PLAN 接线 / 恢复语义） |
| 删除文件 | 4（前端 2 / 后端 2） |

---

## 1. 子会话生产端投递缺陷（P0）

`CommittedStateV3Observer` 原先把消息/轮次投到**实体自身会话**的桶里。`EventStreamPublisher.publish` 对**没有订阅者的桶静默丢弃**，而前端只订阅根连接 → 子代理的提交与用量**一帧都收不到，且不报任何错**。

**修复：根身份从源头透传，投递用 rootSessionId、实体归属用 sessionId。**

| 生产者 | 根身份来源 |
|--------|-----------|
| `ConversationTranscriptService.append*` → `MessageRepository.appendAll` → `save` | 调用方传入 |
| `ChatTurnService.acceptTurn / markRunning / markWaiting / markTerminal / refreshUsage / recordFailureReason` | 调用方传入，经 `mutate` 透传到仓储 |
| `DelegationRecorder` | 形参里已有的 `rootSessionId` |
| `DatabaseConversationTranscriptSink` | `ExecutionEventMetadata.parseRootSessionId`，**原样透传** |
| `RequestPreparer` / `PreparedChatExecutor` | 会话自身即根 |
| `ChatTurnRuntimeListener` | 事件元数据（完整事件随元数据到达） |
| `ChatTurnLifecycleListener` | 回调传入的已提交 `Execution` |

挂起端口补全为与终结端口同形：`onExecutionSuspended(String, Execution)` —— 广播点本来就把执行读回内存，**不改框架源码、不加缓存**。

**观察者语义**：只读 `change.rootSessionId()`，**零查询**；缺失时**告警并跳过**，绝不回落自身会话。

### 本轮收口的两处

1. **`DatabaseConversationTranscriptSink` 不再猜根身份**：原为 `rootSessionId == null ? sessionId : rootSessionId`，等于把观察者的错误回落挪到上游 —— 子执行缺根元数据时照样投错桶且更隐蔽。现**原样透传**，未知就是 `null`，由通知侧告警跳过；旧检查点的身份补全属恢复入口职责。
2. **`CommittedStateChange` 过期注释修正**：`entity(...)` 的 javadoc 原称「根身份未知时由观察者按自身会话投递」，与现状矛盾，已改写为「只适用于不需要投递到具体连接的种类；MESSAGE/TURN 缺根身份会被告警跳过」。

### 验证

- `CommittedStateV3DeliveryTest#subSessionMessageAndTurnAreDeliveredOnRootConnection`：**只订阅根连接**，断言子会话消息与轮次都能收到，且信封上 `rootSessionId = 根`、`sessionId = 子会话`。
- `CommittedStateV3DeliveryTest#messageWithoutRootIdentityIsSkippedInsteadOfFallingBackToOwnSession`：不带根身份提交 → **不投递**（锁住「跳过而非回落」）。
- `ChatTurnLifecycleListenerTest#threadsRootSessionFromExecutionMetadata`：根身份取自执行元数据并透传。

---

## 2. PLAN 专项：真实接线

```text
attachStreamV3 → READY → bootstrap
→ server.push(PLAN 卡)          // 只推 v3 帧
→ 生产决策入口（chatApi.decideToolCall → POST /tool-call/decisions）
→ server.push(恢复响应)
→ 断言派生视图出现正文
```

断言：卡片经**真实流**到达并展示（`kind` 由 `content.kind` 分派、按钮读 `allowedActions`）；决策回执更新同一 `tools[toolCallId]` 且仍是**一条**；恢复正文出现在**派生视图**里；**逐卡 GET = 0**，整条链路只打一次决策接口。

> **边界（保留）**：该用例覆盖 SSE 接线与决策**服务入口**；**组件点击**与**回执合并到组件**仍未经真实 UI 验证（无浏览器测试框架）。

---

## 3. 恢复语义回归（按真实恢复建模）

原用例暂停 execution `900` 却用 `901` 恢复 —— 不成立。真实恢复**保持 executionId 与 turnId 不变，仅 streamKey 更新**。重写后的 `streamV3Concurrency.test.ts#场景3-5`：

1. 历史里**只放用户行**（assistant 内容只能来自落库行，避免未提交槽的副本把断言蒙过去）；
2. 第一段流式 → **`MESSAGE_COMMITTED` 落库**；
3. 挂起（同一 executionId/turnId）→ 该段定格，迟到增量不追加；
4. 恢复（**同一执行**）→ 新 streamKey 的段落；
5. 断言：**仍是一条** assistant 气泡、已提交内容保留、新段落正常展示、`isComplete === false`。

### 由此暴露的渲染缺陷（已修）

`overlayResponses` 原为 `assistant.content = text`（**覆盖**）。恢复后同一轮次换 streamKey 会产生**新段落**，覆盖会把**已提交正文从视图里抹掉**。现改为：同一轮次的活响应**追加**，归属不确定的兜底挂载仍**覆盖**（避免把别轮内容拼进来）。

---

## 4. 第 2 组旧入口删除（已完成）

| 端 | 删除项 |
|----|--------|
| 前端 | `views/chat/messageRouter.ts`、`views/chat/useSubSessionRouting.ts`（整文件）；`useChatView` 的 import/解构/`clearPendingSubSessionEvents`；`activeViewingSubSessionVO` 兜底改读 `streamV3.getSession` |
| 后端 | `SubAgentSessionEventPublisher`、`SubAgentSessionPayload`、`StreamEventType.SUB_AGENT_SESSION_CREATED`、`SessionStreamHub` 映射分支、`StreamProjectionReducer` 合并 case、`DelegationRecorder` 调用/注入、`CallSubAgentSessionReuseTest` 的 mock 与 verify |
| 类型 | `SubAgentSessionCreatedData`、`SUB_AGENT_SESSION_CREATED`、`PLAN_UPDATE`（全仓零生产端/零处理分支/零组件） |

**保留**：计划组件、`buildPromptCard`、历史聚合 `aggregateSessionMessages`、`CARD_PENDING` 声明（后端仍在发）。

---

## 4b. 第 3 组兼容消息状态删除（已完成）

按「旧消息同步写入 → 三张子会话重复表 → `chatSessionStore.messages` 及其剩余访问方法」依次删除，每组后重跑回归。

| 顺序 | 删除项 | 说明 |
|------|--------|------|
| 1 | **旧消息同步写入**：`useChatView` 决策回执后的三次 `applyAuthoritativeToolCall` 就地改写（`displaySessions` 各会话、`chatSessionStore.getAllMessages`、三张子会话重复表） | 回执携带的卡片是唯一工具实体，进 v3 状态源；视图适配层按 `toolCallId` 引用它 |
| 1b | `src/utils/toolCallState.ts` + `tests/toolCallState.test.ts` | 该文件只含 `applyAuthoritativeToolCall`，最后一个调用方删除后即死代码。其两条契约**归位**：「准备中的卡片不开放动作」迁入 `messageProjection.test.ts`（测的是 `buildPromptCard`）；「BIGINT 版本精确比较」迁入 `streamV3.test.ts`（测的是 store 的 `shouldApply`，原用例侧的 BigInt 语义由此真正落到生产代码上） |
| 2 | **三张子会话重复表**：`subSessionMessagesMap` / `subSessionRawRecordsMap` / `subSessionTurnsMap`（声明 + 切会话时的清空） | 仅供旧同步写入消费；v3 已按子会话 `sessionId` 分槽保存历史与轮次 |
| 3 | **`chatSessionStore` 的消息子系统**：`turnMessages` / `activeTurnMap` / `turnTimers` 三张表 + `TurnTimer`、`getTurnMessages` / `getAllMessages` / `syncHistoryMessages` / `getActiveTurnId` / `getLatestAssistantMessage` / `initTurn` / `startTimer` / `stopTimer` / `getTimerDuration` | store 现在只承载**会话级**状态：根会话映射、运行态、上下文用量 |

**保留**（用户明确要求）：会话选择（`activeViewingSubSessionId` 等）、滚动（`useChatScroll`）、分页请求状态（`subSessionPaginationMap` / `subSessionLoadingMore` / `subHistoryLoadError`）、`getContextUsage` / `seedContextUsage`（用量指示器）。

**顺带发现**：`sessionRootMap`（`bindSessionRoot` / `isSubSession` / `getRootSessionId`）与 `sessionStatusMap`（`setSessionSending` / `setSessionRunStatus` / `getSessionState`）在删除后**已无任何外部读取方**（均为 0 引用）。本轮未动 —— 它们不属于「消息子系统」这个范围；建议作为第 4 组单独清理。

## 4c. 第 4 组：死状态删除（4A）+ `session.messages` 职责迁移（4B）

### 4A：删除两张无引用状态表

`chatSessionStore` 删除 `sessionRootMap`（`bindSessionRoot` / `isSubSession` / `getRootSessionId`）与
`sessionStatusMap`（`setSessionSending` / `setSessionRunStatus` / `getSessionState`）及 `SessionRunState`
类型 —— 删除前逐一核查，外部读取方均为 0。会话的根归属由 v3 `sessions` 槽（`rootSessionId`）表达，
运行态由会话实体（`SessionVO.runStatus`）与执行状态表达。

**保留上下文用量**：`getContextUsage`（useChatView 指示器）与 `seedContextUsage`（tree 对账种入）仍有实际消费方，不能把整个 store 删掉。

### 4B：逐项迁移 `session.messages`（不是删引用）

| 职责 | 迁移落点 |
|------|---------|
| 自动滚动 | 改 watch **v3 派生视图**（`displayedMessages`）。前置插入由「lastId 不变而 firstId 变化」判定，滚动补偿（`beforePrepend` / `afterPrepend`)移到 useChatHistory：**先**记录高度，再写 v3，`nextTick` 后恢复 |
| 空会话判断 | `canChangeWorkspace` 只看 `displayedMessages`（旧检查冗余，删除） |
| 导出 | `handleExportSession` 读 `displayedMessages`，顺序即「提问 → 回答」 |
| 编辑定位 | `handleEditMessage` 在 `displayedMessages` 里按落库行 id 定位；派生视图不携带本地图片对象（用户行只持久化文本），原提问图片不随编辑重发带上 |
| 历史分页与对账 | `useChatHistory` 只「拉取 → 写入 v3」+ 维护分页请求状态；`mergeAuthoritativeMessages` / `mergeTurns` / `truncateHistoryForResend` / `mergeRawRecords` / `aggregateSessionMessages` 的本地合并全部删除 |
| 会话详情首页 | `fetchSessionDetail` 自带的首页原始行作为**代际基准**写进 v3（`replaceHistory`），元数据另入本地会话列表 |
| 轮次摘要 | `messageTurnMap` 改读 v3 `getTurn`（与子会话映射同一份权威），不再读 `session.turns` |
| 发送后的本地消息 | **删除乐观插入**：回执确认后用户行由后端提交并经 v3 推送（`MESSAGE_COMMITTED` / 下一轮 bootstrap） |
| 失败提示 | **独立界面状态** `sendFailureNotice`（受理失败没有落库轮次，无从归属），渲染为输入框上方的可关闭横幅；发送成功即清除 |
| 切会话改气泡为完成 | **删除该推断**：abort 只关前端连接，后端执行仍在跑；切回去 v3 重连 + bootstrap 按服务端权威恢复 |

**「清空当前会话」语义核对**：它清的是本地旧消息数组（兼容残留），**不是** `resetSession()` ——
后端历史仍在，换成 `resetSession` 只会制造「清了又回来」的错觉（下次 bootstrap 原样恢复）。
真正的作废走重发链路（`HISTORY_INVALIDATED`）。已在代码注释里写明，避免后续被「顺手改对」。

### 操作入口回归

`frontend/tests/streamV3Operations.test.ts`（4 条，全部经真实 sseRouter / streamV3Sync / streamV3Store / messageProjection）：

| 用例 | 断言 |
|------|------|
| 导出读派生视图 | 顺序「提问 → 回答」；追加一轮后导出内容随之增长且顺序稳定 |
| 编辑定位 | 落库行 id 能在派生视图定位到（用户行保留落库 id；回答组气泡是 `msg-{session}-turn-{turn}` 稳定 id） |
| 分页前置插入不跳动 | 旧 id 全部保留、顺序仍为旧→新 |
| 切走会话不误判结束 | 运行中气泡 `isComplete === false`（被删除的推断不再存在） |

> **边界**：发送失败横幅的**组件点击**与**横幅渲染**未经真实 UI 验证（与 PLAN 卡同一边界）。

### 随 4B 一并删除的 6 条旧用例

`crossPageTurn.test.ts` 中测**已删除兼容合并**的用例（`mergeAuthoritativeMessages` / `mergeTurns` /
`truncateHistoryForResend`）：「5. 流结束权威对账」「12. 对账」「完整刷新」「完整空快照」「分页合并」「重发截断」。
其意图已由 v3 的版本合并（`shouldApply`）与 `streamV3Resend` / `streamV3Concurrency` 用例承接。

### 独立缺口（记录，不阻塞）

`setContextUsage` 已无外部写入方 —— 用量目前只靠 tree/detail 历史快照种入，
**不能继续称为实时指标**。实时口径本应来自 `CONTEXT_UPDATE` 事件；该链路是否恢复属于后续验收清单。

## 4d. 4B 验收问题修复（评审第二轮）

### ① 已有连接上的新提问被丢弃（P0）

`applyMessageCommitted` 原先**要求所有提交都带 `streamKey`**，并把历史行类型写死为 `'AI'`。
后端 USER 行本来就没有 streamKey → 用户在已有连接上发新提问，`MESSAGE_COMMITTED` 被整条忽略
（`缺 streamKey，已忽略`），而乐观插入又已在第 3 组删除 → **提问不显示**。

修复：按**消息类型**分两路 —— USER（及一切无 streamKey 的类型）按 `messageId` 入历史槽；
AI 用 streamKey 绑定实时响应；历史行**保留真实 type**，不为通过校验给 USER 编造响应身份。

回归：`streamV3Operations.test.ts#会话同步完成后，再收到 USER 提交立即入视图`。

### ② 普通详情与对账可能覆盖实时新行

`useChatView` 的详情响应、`useChatHistory` 的终态对账原先**无条件 `replaceHistory`**（无代次保护）。
迟到的快照会把实时事件刚写入的新行抹掉。

修复：
- `ingestHistoryPage` / `replaceHistory` 返回**是否已应用**；
- 详情与对账改为**同代际合并**（`ingestHistoryPage`，不再替换）并带代际守卫；过期代际**整体丢弃 —— 包括分页游标更新**（`applied === false` 时不推进 `hasMoreMessages` / `nextMessageCursor`）；
- 首页基准只由受同步屏障保护的 bootstrap 建立；`replaceHistory` 的 javadoc 已写明「普通详情与对账不要走这里」。

回归：`streamV3Operations.test.ts#过期代际的详情/对账快照不抹掉实时写入的新行`。

### ③ 操作回归改为调用**生产入口**

| 操作 | 生产入口 | 断言 |
|------|---------|------|
| 加载更多历史 | `useChatHistory#handleLoadMoreHistory`（真实调用） | 顺序 `写入 v3 → beforePrepend → nextTick → afterPrepend`；同代际推进游标；过期代际**不写、不补偿、不推进** |
| 导出 | `buildSessionMarkdown`（从 `handleExportSession` 抽出的唯一内容构造点，入口仍调用它） | 标题回落、提问在前回答在后 |
| 编辑定位 | 保留派生视图按落库行 id 定位 |  |
| 重发请求身份 | 保留派生视图按落库行 id 定位（id 原样作为 `resendMessageId`） |  |
| 发送失败归属 | `sendFailureNotice` 归属本流条目，未知则挂当前活跃会话 |  |

> 重发**请求体**与失败横幅的**组件点击**仍需组合函数级 / 真实 UI 验证（`useChatView` 体量大，
> 无法在无 DOM 的测试环境直接调用）—— 这是本组唯一未闭合的验证边界。

### ④ 「清空当前会话」已禁用

两条实现路线都不是顺手改一行：① 本地隐藏需要「本会话隐藏集合」这类独立界面状态，刷新 / 切回即失效；
② 后端清空是破坏性删除，必须走确认链路 + 后端接口（`HISTORY_INVALIDATED` 同源），不能由快捷指令静默触发。
语义确定前保持**禁用**（调用只打告警），避免按钮无效或制造「已清空」假象。

### 独立缺口（记录，不阻塞）

`setContextUsage` 已无外部写入方 —— 用量目前只靠 tree/detail 历史快照种入，**不能继续称为实时指标**
（实时口径本应来自 `CONTEXT_UPDATE` 事件）。是否恢复该链路属于后续验收清单。

## 4e. 4B 验收问题修复（评审第三轮）

### ① 迟到的提交复活作废回答（已修）

`applyMessageCommitted` 原先只在**响应绑定**处判墓碑，随后仍无条件 `appendCommittedRow` ——
实测：旧响应作废 → 旧 `MESSAGE_COMMITTED` 到达 → 旧回答重新显示。

根因有两层：
1. 提交入口对墓碑只跳过绑定、不阻断写入；
2. `invalidateGeneration` 对**已提交**的响应槽直接跳过（「属持久化历史」）—— 但它同时清空了历史槽，
   这些提交槽成了孤儿，正好给迟到提交当跳板。

修复：
- 提交入口：`current.discarded` → **整条丢弃**（`return`），不写历史行；
- `invalidateGeneration`：本根会话树的响应（**含已提交的**）一律立墓碑 —— 其历史行随代际一并清空，
  槽位成了孤儿，不立墓碑就会被迟到提交借走。

回归：`streamV3Operations.test.ts#已作废响应的迟到提交必须整条丢弃，不得复活旧回答`。

### ② 终态对账仍会清掉实时新行（已修）

`reconcileSessionAfterStream` 的首页原先仍走**无代次守卫的 `replaceHistory`** —— 与报告描述不符。

修复：对账全部改为**同代际合并**（`ingestHistoryPage` + 代次守卫），首页不再整体替换；
守卫不过即整体丢弃并终止对账。`useChatHistory` 已无任何 `replaceHistory` 调用。

回归：`streamV3Operations.test.ts#终态对账（真实入口）在途时收到新提交，不得被旧快照清掉` ——
调用**真实 `reconcileSessionAfterStream`**，在 stub 的 `fetchSessionMessages` 里先推一条新提交、
再返回不含该行的旧快照，断言三行俱全。

### ③ 游标更新与历史写入一起隔离（已修）

| 位置 | 问题 | 修复 |
|------|------|------|
| `useChatView` 详情 | 对象展开里**无条件**写 `nextMessageCursor`（在 `applied` 判定之外） | 从展开中移除，只在 `applied` 时写入 |
| `useChatView` 子会话加载更多 | `ingestHistoryPage` **不带代次守卫** | 捕获代际 + 守卫；不过即丢弃且不更新 `subSessionPaginationMap` |
| `useChatHistory` 终态对账 | 同上（见 ②） | 已带守卫 |

### ④ `/clear` 已从界面移除

`ChatInputArea` 的快捷指令表里仍展示可执行的 `/clear`（点击只打控制台告警）。
已**移除该命令项** —— 在「本地隐藏 vs 后端清空」语义确定前，不暴露一个点了没反应的入口。

### 验证方式修正（评审指出）

此前「详情/对账回归」直接调 store，测不出真实入口的问题。本轮两条时序回归分别走
**SSE ingress**（`attachStreamV3` + 帧推送）与**真实 `reconcileSessionAfterStream`**
（stub `fetchSessionTree` / `fetchSessionMessages`，并在 stub 里模拟「在途时到达的新提交」）。

仍未闭合：失败横幅的**组件渲染与点击**（需真实 UI 验证）。重发请求体已由组合函数级用例覆盖。

### 独立缺口（记录，不阻塞）

`setContextUsage` 已无外部写入方 —— 用量只靠 tree/detail 历史快照种入，**不能继续称为实时指标**
（实时口径本应来自 `CONTEXT_UPDATE` 事件）。

## 4f. 4B 验收问题修复（评审第四轮）

### ① 子会话代次守卫整体失效（已修）

`useChatView` 的子会话详情 / 加载更多用**子会话 id** 读 `historyRevision`，但 bootstrap 与
`HISTORY_INVALIDATED` 只把代际记在**根会话**键下 → 读到 `undefined`，而 `revisionMatches` 把
`undefined` 解释成「不检查」→ 子会话的代次守卫**整体失效**（实测：旧页 `applied=true`，
旧行与旧游标均写入）。

修复：把**历史写入位置（会话自身）**与**代际校验范围（根会话）**分开 —— store 新增
`resolveRevisionOwner`（经 `sessions` 槽的 `rootSessionId` 归根，根会话返回自身）与
`currentHistoryRevision(sessionId)`（归根后读取，未建立基线时返回**空串**）；
`revisionMatches` 改用它。空串是**合法基线**而非「不检查」：在途期间代际被推进时照样丢弃。
`replaceHistory` 的 javadoc 同步注明这一口径；详情路径（含 bootstrap 未建基线时捕获空串）同规则覆盖。

回归：`streamV3Operations.test.ts#子会话代次守卫按根会话校验` —— 子会话代际必须归根读到 `'1'`；
同代际首屏写入；根代际推进后旧子会话页整体丢弃；用当前代际捕获后才能写入。

### ② 对账回归的时序没有保证（已加强）

原用例在 stub 里推完 SSE 帧就**立即**返回快照，直到对账结束才 `flush` —— 没保证「新行先应用、
旧快照后返回」。现已改为：推帧后**先排空 SSE 并断言新行已进入 store**，再放行旧快照。

### 独立缺口（记录，不阻塞）

`setContextUsage` 已无外部写入方 —— 用量只靠 tree/detail 历史快照种入，**不能继续称为实时指标**
（实时口径本应来自 `CONTEXT_UPDATE` 事件）。

## 4g. 4B 验收问题修复（评审第五轮）

### ① 新会话详情分支绕过守卫（已修）

`useChatView` 的 `idx === -1` 分支调用 `ingestHistoryPage` 时**没传已捕获的 `expectedRevision`**，
随后 `unshift({ ...detail })` 把带旧游标的 detail 原样塞进本地会话列表。

修复：该分支同样传守卫；分页状态（`hasMoreMessages` / `nextMessageCursor`）只在 `applied` 时接受，
过期代际置 `undefined`（不接受旧快照的游标）。

### ② 对账时序断言被生产代码吞掉（已修）

原用例把关键断言放在 `fetchSessionMessages` 桩内 —— 异常会被 `reconcileSessionAfterStream` 的
try/catch 捕获只打日志，用例照样绿（评审以 `assert.fail` 验证过）。

修复：改用**可控 Promise** —— 测试先挂起历史请求 → 推 SSE 帧 → `flush` → **在测试主体断言新行
已写入 store** → 放行旧快照 → 等待对账并断言最终结果。断言失败即用例失败。

### 独立缺口（记录，不阻塞）

`setContextUsage` 已无外部写入方 —— 用量只靠 tree/detail 历史快照种入，**不能继续称为实时指标**
（实时口径本应来自 `CONTEXT_UPDATE` 事件）。

## 4h. 重发请求体 / 失败归属 / 关闭交互的操作验收（评审第六轮）

新增 `frontend/tests/chatViewOperations.test.ts`（4 条）—— **直接调用 `useChatView` 这个生产组合函数**。
之所以可行：它依赖的 .vue 组件全是 `import type`（编译期擦除），`onMounted` / `provide` 在无组件实例时
仅告警不抛错。 thus 这些验收不再止步于派生数组。

| # | 操作 | 生产入口 | 断言 |
|---|------|---------|------|
| 1 | 重发请求体 | `handleResendMessage` → `chatApi.sendCommand`（真实服务方法，桩捕获实参） | `resendMessageId = 落库行 id`、`content` 取自定位到的原消息、`sessionId` 为已入库会话、带 `commandId` |
| 2 | 失败提示归属 | `handleSendMessage`（受理抛错）→ `sendFailureNotice` | `sessionId = 发起会话`、`message` 带原因；**`dismissSendFailure()` 后置空** |
| 3 | 关闭交互 | 同上（横幅「知道了」按钮绑定的就是 `dismissSendFailure`） | 关闭后提示消失 |
| 4 | 「清空当前会话」 | `handleClearCurrentSession`（已禁用） | 不抛错、不清 v3 历史、界面不变成空会话 |

**测试环境补充**：harness 需要桩 `requestAnimationFrame` / `cancelAnimationFrame`（滚动路径用）；
`useChatView` 的发送守卫要求 reasoning-effort 就绪 —— 通过**真实入口** `handleModelUpdated`
（stub `fetchModels` / `fetchUserConfigs`）触发，与真实 UI 同源。

## 5. 验收矩阵（全部为可执行证据）

| # | 场景 | 判定 | 证据 |
|---|------|------|------|
| 1 | 卡片先于消息到达 | ✅ | `messageProjection.test.ts` 1 / 7 / 8 |
| 2 | 子响应先于会话信息到达 | ✅ | `messageProjection.test.ts` 4 / 10；`streamV3Concurrency.test.ts` 3-3 |
| 3 | 根与子执行并发 | ✅ | `streamV3Concurrency.test.ts` 3-1 / 3-2 / 3-4 |
| 4 | 子卡片在根界面审批 | ✅ | `streamV3Concurrency.test.ts` 3-4 |
| 5 | 断线恢复（含复用 / 旧请求迟到） | ✅ | `streamV3Recovery.test.ts` 5-1 / 5-2 / 5-3 |
| 6 | 重发与作废隔离 | ✅ | `streamV3Resend.test.ts` 6-1 … 6-6 |
| 7 | 切会话不串数据 | ✅ | `messageProjection.test.ts` 5 / 10；`streamV3Resend.test.ts` 6-2 |
| 8 | PLAN 卡不依赖旧事件 / 无逐卡 GET（真实接线） | ✅ | `streamV3PlanCard.test.ts` |
| 9 | 子会话提交投到根连接 | ✅ | `CommittedStateV3DeliveryTest#subSessionMessageAndTurnAreDeliveredOnRootConnection` |
| 10 | 缺根身份跳过而非回落 | ✅ | `CommittedStateV3DeliveryTest#messageWithoutRootIdentityIsSkippedInsteadOfFallingBackToOwnSession` |
| 11 | 暂停→恢复沿用回答组 | ✅ | `streamV3Concurrency.test.ts` 3-5；`ChatTurnLifecycleListenerTest#threadsRootSessionFromExecutionMetadata` |
| 12 | 导出 / 编辑定位 / 分页不跳动 / 切走不误判结束 | ✅ | `streamV3Operations.test.ts` 4 条 |
| 13 | transcript 入口缺根身份原样透传（不猜） | ✅ | `DatabaseConversationTranscriptSinkMetadataTest`（期望根为 null） |
| 14 | 迟到提交不复活作废回答 | ✅ | `streamV3Operations.test.ts` 时序回归 1 |
| 15 | 终态对账（真实入口）不清掉在途新行 | ✅ | `streamV3Operations.test.ts` 时序回归 2 |
| 16 | 子会话代次守卫归根校验 | ✅ | `streamV3Operations.test.ts` 子会话代次守卫回归 |
| 17 | 重发请求体携带落库消息身份 | ✅ | `chatViewOperations.test.ts` 操作验收 1 |
| 18 | 失败提示归属 + 关闭交互 | ✅ | `chatViewOperations.test.ts` 操作验收 2 / 3 |
| 19 | 「清空当前会话」禁用语义 | ✅ | `chatViewOperations.test.ts` 操作验收 3 |

---

## ✅ 行动清单

| # | 行动 | 负责方 | 紧急度 |
|---|------|--------|--------|
| 1 | **第 4 组清理**：`chatSessionStore` 的 `sessionRootMap` 与 `sessionStatusMap` 删除后已无外部读取方（0 引用）；连同 useChatView 里仍引用 `session.messages` 的展示路径一并复核后删除 | 前端 | P1 |
| 2 | PLAN 卡的**组件点击**与**回执合并到组件**补真实 UI 验证（当前只到服务入口） | 前端 | P2 |
| 3 | `messageProjection` 的 `baseCache` 模块级无上限；墓碑槽位随代际累积（`resetSession` 会清） | 前端 | P2 |
| 4 | `CARD_PENDING`（v2 通道）在后端仍在下发但无消费者；确认是否随之退役 | 后端 | P2 |

---

## ⚠️ 待完善 / 已知局限

- 集成测试**不是**浏览器端到端：无真实 DOM、无真实后端帧时序、未覆盖 Electron。
- PLAN 专项覆盖到**决策服务入口**；组件点击链路未经真实 UI 验证。
- 「已决断的子卡片不再冒泡到根界面」是**设计语义**（根只冒泡待审批的子卡）。
- 根身份透传覆盖全部已知提交调用方；新增调用方若漏传，观察者会**告警并跳过**（不再静默投错桶）。

---

## 📚 产出索引

**本轮改动**
- 根身份透传：`CommittedStateChange`、`MessageRepository`/`SessionMessageRepositoryImpl`、`ChatTurnRepository`/`ChatTurnRepositoryImpl`、`ConversationTranscriptService`、`ChatTurnService`/`ChatTurnServiceImpl`、`ExecutionLifecycleListener`、`LocalExecutionRepository`、`ChatTurnRuntimeListener`、`ChatTurnLifecycleListener`、`DelegationRecorder`、`RequestPreparer`、`DatabaseConversationTranscriptSink`、`PreparedChatExecutor`、`CommittedStateV3Observer`
- 渲染：`frontend/src/views/chat/messageProjection.ts`（同轮次追加语义）
- 用例：`CommittedStateV3DeliveryTest`、`ChatTurnLifecycleListenerTest`、`DatabaseConversationTranscriptSinkMetadataTest`、`frontend/tests/streamV3PlanCard.test.ts`、`frontend/tests/streamV3Concurrency.test.ts`、`frontend/tests/messageProjection.test.ts`
- 删除：`frontend/src/views/chat/messageRouter.ts`、`frontend/src/views/chat/useSubSessionRouting.ts`、`src/main/java/com/summit/dp/agent/infrastructure/event/SubAgentSessionEventPublisher.java`、`SubAgentSessionPayload.java`
- 第 3 组删除：`frontend/src/utils/toolCallState.ts`、`frontend/tests/toolCallState.test.ts`；改写 `frontend/src/stores/chatSessionStore.ts`（移除消息子系统）、`frontend/src/views/chat/useChatView.ts`（移除旧同步写入与三张子会话重复表）

**验收门槛实测**

| 门槛 | 要求 | 实测 |
|------|------|------|
| `vue-tsc -b --force` | 0 错 | ✅ |
| `npm test` | 全绿 | **81 + 4** ✅（构成有变：toolCallState 2 例删除、crossPageTurn 6 条兼容合并用例删除，契约归位到 streamV3 / messageProjection / streamV3Operations） |
| `vite build` | 通过 | ✅ |
| `mvn -o test` | 全绿 | **484 / 0** ✅ |

---

> 本报告由 AI 协作生成，关键决策请由工程负责人复核。
