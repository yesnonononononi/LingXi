# 流式回答 → 渲染链路技术债审计

- **日期**：2026-10-06
- **范围**：`D:\Code\LingXi` 全链路（前端 `frontend/src` + 后端 `src/main/java`），重点是流式回答到渲染的整条数据通路
- **方法**：只读静态审计（未改任何文件、未启动服务、未执行构建）
- **团队**：架构师（链路测绘）、工程师（前端 62 条深挖）、QA 工程师（后端契约）
- **用户诉求**：找出「看似有用」「为功能性缺陷兜底」「重复出现」「过度降级」的代码

---

## 一、结论（TL;DR）

链路有**三处用户可见功能性缺陷**，以及大量「不该在那里的代码」。前端 62 条 + 后端 33 条：

| 类别 | 前端 | 后端 | 处置方向 |
|---|---|---|---|
| A 看似有用（死代码） | 14 | 6 | 可直接删，17 处机器确认零引用 |
| B 为缺陷兜底 | 18 | 13 | **多数需上报后端**，不能固化 |
| C 重复实现 | 22 | 8 | 需先定唯一真源，再合并 |
| D 过度降级 | 8 | 4 | 需改错误处理语义 |

**五个最值得处理的发现**：

1. **【P0】上下文百分比的分母用错了字段**（BE-7）。唯一「数字直接错」而非「数字缺失」的问题：`application.yaml:133` 的上下文窗口真源是 **393200**，但 `useChatView.ts:401` 的第三级兜底取 `UserConfig.DEFAULT_MAX_TOKENS = 102400`（那是**单次输出上限**）→ 百分比偏大约 3.8 倍、进度条误导用户。且 `ChatInputArea.vue:45` 注释把它当设计意图，说明是**语义误解**。测试用例 `streamRendering.test.ts:394` 用的 393200 正是真值，反证 102400 是错的。
2. **【P0】否决的计划显示为「状态未知」**（BE-5）。唯一一处从后端枚举塌缩一路追到前端文案的完整缺陷树，五个环节全部验证：`ToolCallOutcome:49` 把 `REJECTED` 并入 `FAILED` → wire 上 `REJECTED` 永不出现 → `PlanCard.vue:57/65` 的判 `REJECTED` 分支与「✕ 计划已被否决」文案**永不命中** → 落到 `:60/:70` 灰色 + 「状态未知」。同一张卡的「已批准」显示正常，所以用户看到的是「批准对了、否决不知道」。代码注释自认「待确认前端是否消费该字段后再改」—— 前端不但消费了，还专门为它写了文案。
3. **【P0】后端两处把 `List.toString()` 当业务返回值下发**（BE-8）。`ChatServiceImpl:75`（同步 `chat`）与 `:259`（`resume`）都返回 `executePrepared(context).getMessages().toString()`，下发形如 `[AiMessageEntity(text=你好, thinking=null, toolCalls=[])]` 的 Java 对象字符串。**全仓确认仅此 2 处**。其中 `:75` 是同步非流式接口，比 `resume` 更可能被外部调用方使用。
4. **【P0】实时失败原因无出口 + 终态后 token 用量每轮都丢**。`sendError` 只有写入点（`turnStreamReducer:482`）没有读取点，`ChatMessageItem.vue:9` 注释说「失败由回答组统一渲染」，但那条路径读的是 `turn.errorReason`（历史装配的 `turns` 侧），实时链路的 `bubble` 上没有 `turn` 对象 → **用户执行失败时看不到任何原因**。**且用量也每轮丢**：`SseEventPublisher.java:151-153` 的注释白纸黑字写着「终态事件先于收尾用量推送发出，前端看到终态就会关流，于是『终态之后那一条用量推送写不出去』是**每轮都会发生的正常现象**」—— 后端作者自己确认了这是必然，不是边缘情况。叠加 BE-1 后更糟。
5. **【P1】阶段 1 删伪造 ID 是零影响的纯加固**。前置检查已通过：前端 4 个 `:key` 消费入口全部核查，`ChatMessageItem.vue:901-970` 的 `processTimeline` 五个分支 id 均已兜底（`tc.id || tool-${idx}`，命名空间 `step-*`/`im-*`/`tool-*`/`card-*` 互不重叠），不会触发 duplicate key。**唯一的未验证项已消除。** ⚠️ 实现约束（不是安全保障）：必须实现为「requestId 缺失 → **整条 trace 不 push**」，不能是「push 一个 id 为空的 trace」—— 后者违反 `types/chat.ts:22` 的 `id: string` 编译失败。
5. **有行为不一致的重复**（C-4）：同一个 outcome 词表存在 **5 份**独立实现，对 `ANSWERED` 判定相反、对 `CANCELLED` 判定不一致 —— 同一张已决卡片在卡本体与折叠摘要行会显示不同状态色。另有 **v3 bootstrap 协议前端整条未接线**（`SessionAPI.bootstrap` 包装器零调用）。

---

## 二、链路地图

```
POST /a/completion/stream  (ChatController:34)
  └ ChatServiceImpl.chatStream:97
      ├ requestPreparer.prepare()        建会话，sessionId 必非 null
      ├ sseEventPublisher.connect()      按 rootSessionId 归档
      └ executePrepared()                ← 异常在此被 :117 吞掉
          └ AgentEventListener.broadcast()  逐事件 publish
              └ SseEventPublisher.publish() → SseEmitter.event().name(type)

【前端】
  services/agent.ts:82   chatStream()  原生 fetch（必须拿 ReadableStream）
  services/sse.ts:55     readSseStream()  切 \n\n + JSON.parse
  services/sse.ts:121    parseSseBlock()  ':' 开头整块忽略（心跳在此丢失）
  views/chat/useChatSending.ts:91        建 AbortController → onEvent → 收尾对账
  views/chat/streamSessionRouter.ts:94   dispatch 按 metaData.sessionId 分流
  views/chat/turnStreamReducer.ts:96     consume 状态机（11 类事件）
  views/chat/streamFrameBuffer.ts:48     rAF 合并帧缓冲
  views/chat/useChatView.ts:137          displayedMessages 派生视图（只读）
  components/chat/ChatMessageList.vue:64  :key="msg.id"
  components/chat/ChatMessageItem.vue     渲染 + processTimeline computed
```

**历史装配链（与实时链完全平行、字段集不对齐 —— 这是 B/C 类多数问题的根源）**：

```
GET /session/{id}          → SessionAPI.findById     (chat.ts:290)
GET /session/list          → SessionAPI.list         (chat.ts:252)
GET /session/tree/{id}     → SessionAPI.tree         (chat.ts:376)
GET /session/{id}/messages → SessionAPI.messages     (chat.ts:325)
                              └→ utils/session.ts:242 aggregateSessionMessages
                                 （与 turnStreamReducer 并行实现同一套归约）
```

⚠️ **`GET /session/{rootId}/bootstrap` 这条链路前端整条未接线**（QA 提出，主理人复核确认）：`services/session.ts:97-99` 的 `SessionAPI.bootstrap` 包装器存在但**零调用** —— `SessionAPI` 的其余 8 个方法（`create`/`list`/`findById`/`messages`/`tree`/`del`/`update`/`bindTeam`）均有生产调用方，唯独 `.bootstrap` 没有。配套的 `utils/session.ts:104-110 mergeTurns`（注释自认「无摘要 ≠ 用量为 0」，与 C-13 铁律同源）同样**零调用**，而 `types/chat.ts:441-447` 的 `SessionBootstrapVO` 类型已定义。即：后端已实现 v3 bootstrap 协议、前端已备好类型与 API 包装，但**没有任何调用方**，历史装配仍走旧的分页 + 客户端归约。

**因此本报告不把 bootstrap 计入链路**（初版链路图曾误画，已更正）。它是「已备好未接线」的待激活路径，不是现役路径。

**归约逻辑出现 4 次**（C-9）：`obtainActiveBubble`（流式）、`getAssistantContainer`（历史）、`appendUserMessage`、`displayedMessages` 骨架合成 —— 这是全链路最大的结构性重复。

---

## 三、后端发现（BE）

### BE-1 应用层异常不产生终止事件 ★最高优先级

| 位置 | 事实 |
|---|---|
| `PreparedChatExecutor.java:62` | `throw e` 重抛，**无异常转译** |
| `PreparedChatExecutor.java:59` | `markStartupFailedQuietly` 只把执行行收口成终态（写库），**不发布 SSE 事件** |
| `ChatServiceImpl.java:117` | `catch (Exception e) { log.error(...) }` —— **只记日志，不重抛** |
| 后果 | 框架无从感知失败 → `AgentEventListener.onExecutionError:64` 不触发 → 前端**永远收不到 `EXECUTION_FAILED`** |
| `ChatServiceImpl.java:122-124` | `finally` 判定 `execution == null` → `finish()` 干净关流 |
| `RootStreamCloseListener.java:35-43` | 关流被设计为独立于事件投递的动作，坐实「流会结束，但终止原因不会以事件抵达」 |

**影响**：执行失败时，前端既收不到失败事件、也收不到失败原因，流却已正常结束。前端唯一能感知的是「流结束了但气泡没有终态」。

⚠️ **定级修正（QA 复核后）**：本条**降为 P1**。原判「最高优先级」的推理是「事件到不了前端 → 气泡永久停在思考中」，但这个前提**不成立** —— 前端气泡不设终态，**根本没有任何「转圈等终态」的渲染逻辑**。前端实际表现完全由 BE-4（`sendError` 无出口）决定，与本条只叠加不因果。**修复价值仍高**（治本、消除日志与状态不一致），但不该排在 BE-4/BE-7 之前。

### BE-2 消息载荷解析失败静默降级（违反项目铁律）

`SessionMessageViewAssembler.java` 的 `parse()`（`:74-84`）失败返回 `null`，**三个分支全部降级**：

| 行 | 分支 | 降级行为 |
|---|---|---|
| `:49` | USER | `text(stored.getText())` —— 把 JSON 原文当正文 |
| `:53` | SYSTEM | 同上 |
| `:58` | AI | 同上，**且 `:60-62` 不执行 → `thinking` 与 `toolCalls` 全部丢失** |

项目铁律是「解析不出必须返回 `null`，**禁止 `return stored` 降级**」。三处均违反。AI 分支最严重：载荷一旦解析失败，该轮的思维链与工具调用在历史里彻底消失且不可恢复。

### BE-3 三个后端端点无调用方

| 端点 | 前端调用 | 测试 |
|---|---|---|
| `POST /a/completion`（非流式，`ChatController:26`） | 零 | 无 |
| `POST /a/completion/resend`（`:47`） | 零 | 无 |
| `GET /a/completion/{sessionId}/events`（`:60`） | 零 | `ChatSubscribeSchemaVersionTest` |

⚠️ 该测试只验证 Controller→Service 的委托（mock 桩、不断言业务），**不构成端点存活理由**。

### BE-4 幽灵契约文档

`docs/frontend-backend-contract.md` **不存在**（2026-09-27 产出后已删除），但**9 处活代码注释仍以它为权威出处**：

`ids.ts:27`、`toolMeta.ts:152`、`json.ts:31`、`json.ts:46`、`chat.ts:494`、`interceptor.ts:9`、`interceptor.ts:69`、`error.ts:83`、`enum.ts:59`、`chat.ts:519`

这些契约断言（雪花 ID 恒为数字串、`resultStatus` 必填、`WorkspaceVO` 不含 `type` 等）目前**无据可查**，是契约漂移的隐性源头。

### BE-5 否决的计划显示为「状态未知」★唯一已闭环的用户可见缺陷

这是本次审计唯一一处把「后端枚举塌缩 → 前端分支永不命中 → 文案错误」全程追完的缺陷树，五个环节均已逐行验证：

| 环节 | 位置 | 事实 |
|---|---|---|
| 1. 枚举塌缩 | `ToolCallOutcome.java:49` | `case REJECTED, FAILED -> FAILED;` —— wire 上 `outcome` 只会下发 `"FAILED"`，`"REJECTED"` 永不出现 |
| 2. 塌缩理由 | 同上 `:46-48` 注释 | 自认「改成 REJECTED 会变更 wire 值，不在纯重构范围内」「待确认前端是否消费该字段后再改」 |
| 3. 落库路径 | `ToolCallExecutionListener.java:51` | 唯一调用方 → `fromFrameworkStatus(event.resultStatus())`，确认塌缩发生在落库前 |
| 4. 前端分支 | `PlanCard.vue:57` / `:65` | `if (outcome === 'REJECTED')` 与文案「✕ 计划已被否决」**永不命中** |
| 5. 兜底落点 | `PlanCard.vue:60` / `:70` | 落到 `statusTone='unknown'`（灰）+ `statusLabel='状态未知'` |

**为什么难以发现**：`APPROVED` 分支（`:56/:64`）是正常的，「计划已批准，正在实施」显示正确；只有「否决」这一侧塌陷。而 `DelegationWaitCard.vue:29` 独立判了 `CANCELLED`、`ApprovalCard.vue` 走另一套词表，使得 `REJECTED` 的缺失在别处被补位掩盖。

**修复方向（二选一，必须先定契约）**：
- 后端 `fromFrameworkStatus` 恢复 `REJECTED -> REJECTED`（改 wire 值，需同步 `raw_output.outcome` 存量数据与前端 5 处词表）；
- 或前端删掉 `REJECTED` 分支，把 `:57/:65` 改成判 `FAILED`（承认语义合并，但「被否决」与「工具报错」在 UI 上仍不可区分）。

这不是「顺手改一行」——注释里那句「待确认前端是否消费」本身就是当年没查消费方留下的坑，**它证明了「先改后查」会造出用户可见缺陷**。

### BE-6 其余后端发现（QA 提出，主理人已抽样复核）

| ID | 位置 | 内容 | 复核 |
|---|---|---|---|
| BE-6a | `AgentEventListener` 身份解析 | 每条 SSE 事件 2 次 DB 查询（`:121` sessionId + `:122` resolveRootSessionId）。`ExecutionEventMetadata:37` 已写 `ROOT_SESSION_ID`、`:60-61` 已提供 `parseRootSessionId`，`ChatTurnRuntimeListener:149-151` 注释明写「元数据随事件一起到达，根身份在这里是现成的，不需要回查」 | ✅ 已复核：现成字段不用而在热路径回查。⚠️ 但 `:120` 注释写「复用会话解析结果，避免再次查询」—— 是**有意的两段式**（先 sessionId 再 root），非遗漏。属可优化项，不属缺陷 |
| BE-6b | `COMPLETE_TEXT` 与 `AI_MESSAGE` | 两个事件下发同一语义，前端 `turnStreamReducer:151-153` 把 `AI_MESSAGE` 显式丢弃为「噪声」 | 需产品口径：保留两个事件的意图是什么 |
| BE-6c | `STREAM_KEY` | `ExecutionEventMetadata:8-13` 定义了常量但**无写入方** → `ConversationTranscriptService:58` 的幂等判重永不生效 | 需确认写入方是漏了还是已删 |
| BE-6d | `RequestPreparer:379-383` | 把 `revision == null` 兜底成 `1L` → `SessionBootstrapService:89-104` 的一致性校验永远通过 | 兜底使校验失效 |
| BE-6e | `SessionMessageQueryService:7,41` | 应用层直接注入基础设施实现 `SessionMessageRepositoryImpl` —— 违反项目 DDD 分层（应用层应依赖领域仓储接口） | 需确认是否缺领域仓储接口 |
| BE-6f | v1/v2 双决策接口 | 并存，且 v1 仍建请求级 SSE，与前端注释「不再建流」方向相反 | 需定 v1 下线时点 |
| BE-6g | `ChatController.command()` 丢弃 `workDir` | 后端不读，前端 `agent.ts:42` 仍在发 —— 契约欺骗 | 双方任一侧删 |

### BE-7 【P0】上下文百分比的分母用错了字段 —— 界面显示的数字本身就是错的

这是本次审计中**唯一「数字直接错」而非「数字缺失」**的问题，且已完整闭环：

| 环节 | 位置 | 事实 |
|---|---|---|
| 真源 | `application.yaml:133` | 主模型 `max-tokens: 393200` —— 这是**上下文窗口**真源 |
| 被误用 | `UserConfig.java:51` | `DEFAULT_MAX_TOKENS = 102400` —— 这是**单次输出上限**，与上下文窗口无关 |
| 前端兜底 | `useChatView.ts:401` | `usage?.maxTokens ?? session?.contextMaxTokens ?? userConfig.maxTokens` —— 第三级兜底取到 102400 |
| 计算 | `useChatView.ts:402` | `usedTokens / maxTokens` → 百分比按 102400 算 |
| 展示 A | `ChatInputArea.vue:482` | `usedTokens / maxTokens` 算进度条比例 |
| 展示 B | `ChatMessageItem.vue:453` | tooltip 直接显示 `tokenCount / maxTokens` |
| 反证 | `tests/streamRendering.test.ts:394` | 测试用例的 `maxTokens: 393200` 正是真实上下文窗口 |

**后果**：`CONTEXT_UPDATE` 事件未带 `maxTokens`、且会话快照也没有 `contextMaxTokens` 时（首次执行、快照未回填），界面显示的上下文占用比例**偏大约 3.8 倍**，进度条误导用户以为快满，实际远未接近上限。用户会据此做出错误的「需要压缩上下文」判断。

**双重失效**：`ChatInputArea.vue:45` 的注释把这个兜底当成设计意图（「maxTokens 优先事件自带、回落 common_config.max_tokens」），说明这不是写错，而是**误解了两个字段的语义**。`ChatMessageItem.vue:453` 同样直接展示该错值。

**修复方向**：分母必须取上下文窗口，不得取输出上限。最小改动是在 `useChatView.ts:401` 去掉第三级兜底（改为 `null`，配合已有的 `maxTokens && maxTokens > 0` 判空走「未知」态），或让后端在 `CONTEXT_UPDATE` 事件中固定下发上下文窗口。**不要简单把 102400 改成 393200** —— 那是把一个硬编码错误换成另一个硬编码错误，换模型就又错了。

#### ✅ 已修复（清理批次 1 附带落地，20:15）

采纳上述「最小改动」方案，`useChatView.ts:401` 第三级兜底 `?? userConfig.maxTokens` 已改为 `?? null`：

```ts
// 分母只认上下文窗口，第三级 userConfig.maxTokens 是「输出上限」，语义不同（详见报告 BE-7）。
const maxTokens = usage?.maxTokens ?? session?.contextMaxTokens ?? null;
```

配套加了中文注释说明**为什么**不去兜底（AGENTS.md：注释只写「为什么」）。改后无窗口数据时 `maxTokens` 为 `null` → `ratio` 走「暂无统计」分支，**不再显示错误百分比**。同处 `:400` 的 `?? 0` 未改（`usedTokens` 保持数值型语义，另立项）。

**门禁**：`vue-tsc -b --force` EXIT=0；8 组测试 52/52 全绿。

⚠️ **未闭合部分**：这修的是「算错」，没修「拿不到」。`CONTEXT_UPDATE` 事件不带 `maxTokens`、会话快照也无 `contextMaxTokens` 时，界面从「显示错的百分比」变成「不显示百分比」。**要让用户真正看到占用率，仍需后端在 `CONTEXT_UPDATE` 中固定下发上下文窗口**（或让 `ChatTurn` 落库该值）。这是后端契约变更，不在本次前端清理范围。

### BE-8 【P0】后端两处把 `List.toString()` 当业务返回值下发

全仓扫描确认**仅此 2 处**（`grep -rn "getMessages()\.toString()"`）：

```java
// ChatServiceImpl.java:75  同步 chat 接口（POST /a/completion）
return Result.success(executePrepared(context).getMessages().toString());
// ChatServiceImpl.java:259  resume 接口
return Result.success(resumed.getMessages().toString());
```

下发内容形如 `[AiMessageEntity(text=你好, thinking=null, toolCalls=[])]` —— 这是 Java 对象的 `toString()`，不是消息内容。调用方拿到后无法解析。

`:75` 是**同步非流式接口**，比 `:259` 的 `resume` 更可能被外部调用方使用。两个端点在前端均无调用方（见 BE-3），但对外暴露即为契约缺陷。

**修法**：需要业务口径 —— 返回结构化消息数组，或明确标注该端点不供外部调用并下线。不能靠前端解析这个字符串（那是「为缺陷兜底」，违反项目铁律）。

### 契约误判：8 条「为后端缺陷兜底」其实是「为不存在的缺陷兜底」★重要修订

这一轮由 QA 从框架权威源码（`harness-core-1.1.0-sources.jar` 解压）逐条核对，**推翻了审计中 8 条定性的因果前提**。这批结论有行号、有推理链，**但前提是错的** —— 记录在此以免后续重复踩坑。

| 原判 | 框架源码事实 | 结论反转 |
|---|---|---|
| 临时 ID 是「为后端缺陷兜底」 | `ToolCallStartEvent.requestId` **100% 非空**（`ToolCallDefinition` 的 `@NonNull`），恒等于 `tool_call.id` | 不是兜底，是**把恒等约束当成不可靠**。且伪造 ID 的卡片刷新后消失（历史聚合用真 id），是**可复现的功能缺陷** |
| `toolName` 可能缺失 → 兜底 `ExecuteCommand` | `ToolCallStartEvent.toolName` **100% 非空** | 伪造工具名会渲染出**错误类型的卡片**（命令执行样式）。删兜底后走 `toolMeta.ts` 的 `unknown` 分支才是诚实降级 |
| `resultStatus` 可能缺失 → `?? 'unknown'` | `ToolCallEndEvent.resultStatus` **5 个发布点穷举、必填** | `unknown` 分支不可达；且 `toolMeta.ts:162` 的 `'STARTED'` 分支同样不可达（`handleToolCall:318` 硬编码 `'calling'`，从不调 `resolveToolExecutionStatus`） |
| 事后补写 `turnId` 是「为缺陷兜底」 | `EXECUTION_STARTED` **恒带 turnId**（时序由 `ChatServiceImpl:192→197` 保证） | `turnStreamReducer.ts:170-172` 补写逻辑**永不可达**。而 `:197` 的 `turnId \|\| Date.now()` 气泡 ID 兜底会**静默把一个回答拆成两个气泡**（`ChatMessageList.vue:64` 按 `:key="msg.id"` diff） |
| 前端硬编码 `'执行异常终止'` 与后端 `'执行异常'` 不一致 | 成立，但**两处都不可见**：前端 `turnStreamReducer:388` 读 `event.usage.tokenCount`，而 `Event.ts:74` 声明 `tokenCount: number` 严格非可选 → 该分支不可达 | **重复计数**，不是两条独立问题 |
| 上下文用量缺失 → 兜底 `session.contextTokenCount` | 后端有权威 `ContextUsageMetric` 事件 | 错在**降级链设计**，不在兜底本身 |

**工程判据「后端必填」目前无处可查**：`docs/frontend-backend-contract.md` **不存在**（见 BE-4），但 9 处活代码注释以它为出处，`toolMeta.ts:154` 甚至写「`resultStatus` 为 final 必填字段」—— 这个断言本次由框架源码证成，但**当时的作者是凭直觉写的**。这正是 BE-4 的实际危害：契约靠注释维持，无处校验，于是双方各自猜测。

**框架侧确实存在的三条「只发 TOOL_COMPLETED、不发 TOOL_CALL」路径**（`DefaultToolExecutionManager.process()`：工具未注册 / 不在白名单 / `applyPolicies` 返回非 null）—— 这解释了 `turnStreamReducer.ts:354` 的 `if (target)` 静默丢弃**有真实触发场景，不是死代码**。正确修法是后端补齐 Start 事件或前端用真 `requestId` 建 trace，**不是造假 ID**。

### BE-10 【P1】被拒绝的工具调用在 UI 上完全不存在（前后端三重掩盖）

框架有三条路径只发 `TOOL_COMPLETED`、不发 `TOOL_CALL`（`DefaultToolExecutionManager.process()`：工具未注册 / 不在白名单 / `applyPolicies` 返回非 null）。这触发一条**前后端三重掩盖**的链路：

| 环节 | 位置 | 行为 |
|---|---|---|
| 1. 前端丢弃 | `turnStreamReducer.ts:354` | `if (target)` 找不到就**整块跳过**，该工具的 `result` 与 `status` 双双不写 |
| 2. 前端改状态 | `turnStreamReducer.ts:463-468` | 终态时把所有残留 `calling` 扫成 `unknown` —— **静默，无日志** |
| 3. 后端补行 | `ToolCallRegistrarImpl.java:108-128` | 无占位行时**补一条 `completed` 的 fallback 行**（注释自陈「兜底」）→ 历史路径会显示成「已完成」 |

**后果**：用户看到的不是「工具被拒绝」，而是「工具卡变成灰色 unknown」（实时）或「工具显示已完成」（刷新后）—— **两种都是错误信息，且互相矛盾**。

**关键证据（这是有前科的）**：同一份逻辑在历史路径已有正确做法 —— `utils/session.ts:350-353` 遇到 `toolCall` 缺行时 **`console.warn` + `continue`**，工具卡消失但**留了痕**。实时路径的 `:463-468` 却是静默改状态。**同一行为两套实现，且实现更差的那个在实时主路径上。**

**修复方向**：
- 实时路径对齐历史路径 —— `unknown` 时补一条 `console.warn`（成本一行，消除「静默」）
- 更根本的是后端补齐 Start 事件，或让 `TOOL_COMPLETED` 能在无 Start 时凭 `requestId` 建 trace

### BE-11 同一执行被并发推送的重复渲染风险（待查证，勿当已确认）

证据链：`SseEventPublisher.connect(rootId)` **可重入** → `emittersByRootSession` 同一 root 桶内**可能并存多个 emitter**。而 `ChatServiceImpl:270-283` 的注释白纸黑字记载了一起真实线上事故：

> 「线上事故里两条『继续推进』各跑出一份交付总结，**前端两个气泡同时收事件**」

**这条注释证明「同一会话开出第二个根执行」在生产上真实发生过**，且事故现象正是「两条 SSE 流同时向同一前端推送」。

⚠️ **但「前端无多流合并能力」这一环未经查证** —— 需确认 `useChatSending.ts` 的 `activeStreamCount` 语义（项目记忆记载它是「请求在途计数」）在两条流同时存在时会发生什么：
- 若前端按 root 维度只挂一个流 → 第二条流的帧被丢弃（对应「静默丢事件」）
- 若两条流都渲染 → 同一事件被处理两次（**重复渲染**）

**这两个方向相反的可靠性问题不能同时假设，必须实测**。列为待查项，**不要当已确认的缺陷去修**。

**「上游不完整时用默认值掩盖未知」这个模式在本项目有四处同构实例**，建议合并为一个上报条目 + 四个独立修复项，一次性推动上游修契约：
1. `SessionMessageViewAssembler:58`（AI 行回落成原始 JSON 串）
2. `ToolCallRegistrarImpl:107-129`（`completeExecute` 无占位行时补一条 `COMPLETED` 兜底行，注释自陈）
3. `turnStreamReducer.ts:465`（残留 `calling` 工具全扫 `unknown`）
4. `utils/session.ts:485-508`（AI 行 `toolCalls` push 时不带 `result`）

### BE-12 架构通则：实时路径是「猜测」，历史路径才是「权威」★可预测同类 bug

这不是又一条孤立 bug，而是**一条能预测尚未发现同类问题的架构特征**：

> 实时路径的产物是「尽力而为的猜测」，历史路径的产物才是「权威落库数据」，而前端在实时阶段**从不回读历史**。**所有「实时缺、刷新有」的现象都从这条缝隙漏出来。**

已确认的实例，**它们不是孤立 bug**（架构师补完机制取证后从 3 处扩到 **6 处**）：

| # | 实例 | 实时路径 | 历史路径 | 用户可见 |
|---|---|---|---|---|
| 1 | 失败原因 | `bubble.sendError`（1 写 0 读） | 读 `turn.errorReason` | 是 |
| 2 | `errorReason` | 实时无来源 | 后端下发 | 是 |
| 3 | 工具 trace | 3 条 REJECTED 路径下不建卡 | `session.ts:403-410` 补行 | **刷新前后 UI 突变** |
| 4 | 工具名 | `:307` 假名 `ExecuteCommand` | 框架 `:85` 占位 `"unknown tool"` | **两端各编一个假名** |
| 5 | calling→unknown | `turnStreamReducer:463-469` 只改 status | `session.ts:522-525` status+result 都改 | 是 |
| 6 | 解析失败 | — | `SessionMessageViewAssembler:58` 泄漏 JSON 原文 | **反向：历史比实时更差** |

**第 3 处的完整机制**（架构师取证，解释了「刷新后凭空出现一行卡片」）：

```
框架 DefaultToolExecutionManager.process()
  :127-133  toolDef == null          → REJECTED（Tool not found），publishEndEvent 显式传 toolDefinition = null
  :136-140  !admissible(...)         → REJECTED（审批/并发未通过）
  :145-150  result != null           → REJECTED（"tool has not been conducted"）
        ↓ 三条都 return publishEndEvent(...) → ToolExecuteResult
execute() :76/:88  result.add(process(...))        ← 结果被收进列表
        ↓
AgentLoopStepRunner:205/220 → addMessage(execution, response, toolResults)
DefaultConversationManager:80-89 → ToolMessageEntity
:100  conversationTranscriptSink.appendRound(...)
```

**关键**：REJECTED 的 `ToolExecuteResult` **100% 会进 transcript 并落库**。加上后端 `ToolCallRegistrarImpl:115-128` 补的 fallback 行，历史路径必然 push 出工具卡。实时侧 `handleToolCall` 不被调用 → 无 trace；`handleToolCompleted` 仍创建气泡但 `if (!bubble.toolCalls) return` → **气泡在、零工具痕迹**。

**第 4 处值得单独看**：前端 `:307` 编的是**误导性真名**（假装执行了命令，渲染命令样式卡片），框架 `:85` 编的是**诚实占位符**（明确承认不知）。**同一语义缺口，前端那个更糟。**

#### ✅ 第 1 处已修复（清理批次 1 附带落地，20:15）

`sendError` 1 写 0 读已改：`turnStreamReducer.handleExecutionFailed` 不再只写 `sendError`，改为**写进 `bubble.content`**（有内容则尾部追加 `\n\n`，否则直接赋值）：

```ts
// 失败原因写进 content（正文尾部），不能只写 sendError —— 该字段全仓 0 读取点，写进去等于丢弃。
// 与历史路径同形：刷新后从 turn.errorReason 看到，实时阶段从本段正文看到，两处口径一致。
if (errMsg) {
  bubble.content = bubble.content ? `${bubble.content}\n\n${errMsg}` : errMsg;
}
```

`types/chat.ts:144` 的 `sendError?: string` 类型声明**暂留未删**（避免连带影响面，需要单独确认无消费者后再清）。**门禁：`vue-tsc` EXIT=0，8 组测试 52/52。**

⚠️ **未闭合**：这条只修了「实时失败原因看不到」。**终态后 token 用量每轮必丢**（`SseEventPublisher:151-153` 注释自证）**未修** —— 那是后端推送时序问题，前端无法兜底。

**为什么值得单列**：只要这个架构特征不变，**未来每条「实时缺、刷新有」的现象都属于同一类**，不必逐条重新分析。**根治方向**（而非逐条打补丁）：让实时路径在需要权威数据时回读一次历史接口，或让后端保证 transcript 与事件在同一次投递中一致。**反证其预测力**：`useChatView.ts:401` 的 `?? userConfig.maxTokens`（BE-7）之所以错，正是因为实时阶段拿不到权威 `contextMaxTokens`（`CONTEXT_UPDATE` 只在 loop 运行期发布）—— **同一缝隙的又一例，且是在这条通则提出之前就已被独立发现。**


### 一个正面样本：降级不等于静默 ★判断标准

`utils/session.ts:350-353` 曾在审计里被归入 D 组「过度降级」，**该定性已撤回**：

```ts
if (!toolCall) {
  console.warn('[aggregateSessionMessages] TOOL 消息缺少 tool_call 行，已降级为不可用:', item.id, resolvedCallId);
  continue;
}
```

它有告警、有明确的「降级成什么」、`continue` 是**正确跳过而非兜底伪造**。**这是本项目处理得最规范的一处降级。**

⚠️ **但实时路径的同类代码 `:463-468` 是反例** —— 同样遇到残留 `calling`，它**静默**改成 `unknown`，无任何日志。同一行为两套实现，**更差的那个在主路径上**（见 BE-10）。

**由此提炼的判断标准**（建议作为后续审查的固定检查项）：

> **降级不等于静默。** 关键看三件事：① 有没有告警 ② 有没有明确说明「降级成什么」③ 是不是「跳过未知」而非「伪造已知」。
> **三者齐全 = 可接受的降级；缺任何一项 = 过度降级。**

### 阶段 1（删伪造工具调用 ID）前置检查已通过

前端 4 个 `:key` 消费入口全部核查完毕：

| 入口 | 位置 | 判定 |
|---|---|---|
| `processItems` | `ChatMessageItem.vue:84` | ✅ `processTimeline`（`:901-970`）五个分支 id 均已兜底或为常量，**恒非空**（`tc.id \|\| tool-${idx}`，命名空间 `step-*`/`im-*`/`tool-*`/`card-*` 互不重叠） |
| `subAgents` | `ChatMessageItem.vue:183` | ✅ `tc.id \|\| idx` |
| `cardItems` | `ChatMessageItem.vue:399` | ✅ 同一批已兜底值 |
| `SubSessionDetailDrawer` | `:304` | ✅ 全前端唯一一处**裸用 `tc.id`** 当 key，但**不走 SSE**（`:51-63` 走历史路径），且历史侧有三重真值守卫（`session.ts:348` 推导 `resolvedCallId`、`:351-353` 缺行不 push、`:394/:402` 空值既不 find 也不 push） |

**结论：QA 早前担心的「空 tc.id → duplicate key → 渲染错乱」不成立，可安全上线。** 这是全表最后一个未验证项，现已消除。

⚠️ **但有一条是「实现约束」而非「安全保障」** —— Stage 1 必须实现为「`requestId` 缺失 → **整条 trace 不 push**」，**不能**是「push 一个 id 为空的 trace」。后者违反 `types/chat.ts:22` 的 `id: string` 编译失败，或（若强转）产生 `SubSessionDetailDrawer:304` 那种裸 `tc.id` 当 key 的隐患。**两种写法看起来差不多，一个安全一个报错。**

**Stage 1 实际是零影响的纯加固**：它会影响缺 `requestId` 时的工具卡与 PROMISE 卡（`resolvePromptCard` 依赖 requestId 作查询键），但这些都以「requestId 缺失」为前提，而框架已证 requestId 恒发。

**建议同 PR 补一行告警**：`:354` 的 `if (target)` 静默跳过不可观测，补 `console.warn` 对齐 `session.ts:352` 既有做法。不补的话，上线后这类问题只能靠「扫成 unknown」反推。

---

## 四、A 类：看似有用（死代码）

> **状态列说明**：✅ = 已在第一批清理中删除；⏸ = 刻意留到第二批（需判断，非纯删除）；❌ = **复核推翻，原判错误**。
> 判据见「方法论」章节的 **L0**（零调用方先问「按设计谁应该调它」）。

| ID | 位置 | 内容 | 证据强度 | 状态 |
|---|---|---|---|---|
| A-1 | `messageRender.ts`（整文件 25 行） | `renderStreamEvent` 零调用；3 个 re-export 也不必要 | 机器确认 | ✅ 已删 |
| A-2 | `turnStreamReducer.ts:161` | `updateSessionId` 零调用 | 机器确认 | ✅ 已删 |
| A-3 | `types/chat.ts:134` + `turnStreamReducer.ts:210` | `processTimeline` 字段初始化为 `[]` 但**从不写入**；`ChatMessageItem.vue:901` 的同名 `processTimeline` 是另一套 computed，二者同名无关 | 机器确认 | ⏸ 需 `git log` 定性 |
| A-4 | `types/chat.ts:151-152` | `branches` / `activeBranchIndex` 零引用（多分支功能已删的残留） | 机器确认 | ✅ 已删 |
| A-5 | `types/chat.ts:148` | `imageFile` 零引用（实际走 `imageUrl`） | 机器确认 | ✅ 已删 |
| A-6 | `types/chat.ts:135` + `toolDiff.ts:137-139` | `fileEdits` 零写入 → `parseToolDiff` 的第 4 优先级分支（路径匹配）**不可达** | 机器确认 | ⏸ 删了会让该分支变不可达，属行为变更 |
| A-7 | `types/chat.ts:145` `tokens` | ~~零写入却被 6 处读取~~ → **复核推翻：4 处是活跃读取**（`ChatMessageItem.vue:1098`/`:1124`/`:1148`/`:1164`），且是 `tokenTooltip` 三级回退的末级 | 机器确认 | ❌ **保留**（原判错误） |
| A-8 | `utils/session.ts:546` | `parseSessionMessages` 是 `aggregateSessionMessages` 的纯别名转发，零生产调用 | 机器确认 | ✅ 已删（连带修 3 处注释引用） |
| A-9 | `utils/session.ts:167` | `mergeRawRecords` 仅测试使用，生产走「首页替换 + 前置合并」 | 语义推理 | ⏸ 删了要一起改测试 |
| A-10 | `utils/session.ts:558` | ~~`synthesizeFailedTurnBubbles` 完全零引用~~ → **复核推翻：零调用但不是残留，是「失败原因无出口」缺陷的修复实现（刷新路径补偿），写好了没接线** | 机器确认 | ❌ **保留**（见 L0 判据） |
| A-11 | `sse.ts:156` + `agent.ts:23` | `isAbortError` 两份逐字相同实现 | 机器确认 | ⏸ 合并属重构，需选一个导出 |
| A-12 | `streamSessionRouter.ts:125` | `resolveIsRootEvent` 的 `_meta` 首参从未使用 | 机器确认 | ✅ 已删（函数保留，`:103` 调用点同步改） |
| A-13 | `agent.ts:68` | `AgentAPI.chat`（非流式）零调用 | 机器确认 | ✅ 已删 |
| A-14 | `chat.ts:66` | `chatApi.stopGeneration` 零调用（UI 同名事件走 `handleStopGeneration`） | 机器确认 | ✅ 已删 |
| **A-16** | `utils/format.ts:23` `formatTokens` | **清理过程中新发现**：零引用，且 `if (!t) return '0 tok'` 把 `null`/`undefined`/`0` 三种语义合并，违反「缺省≠0」铁律。在用的是 `ChatMessageItem.vue:1114` 的 `formatTokenCount`（**两者字符串有差异**：`1.2K tok` vs `1.2K`，所以当初的「收敛」是假的） | 机器确认 | ✅ 已删 |
| ~~A-15~~ | `turnStreamReducer.ts:178` | ~~`if (!turnId)` 不可达回退分支~~ → **复核推翻：该行是 `if (turnId)` 正逻辑复用气泡**，删它会改变气泡复用行为 | — | ❌ **剔除**（原判错误） |

**A-3 需 `git log` 定性**（是遗留还是被移除），本次未查。

**A-16 补充了一条更深的结论**：`format.ts` 头部注释自称「展示层格式化的**唯一实现**」，并列出三个「被替换位置」—— 但那三处（`SubAgentSidePanel.vue:50-53` 等）如今 `tok` **零命中**。**文档宣称已完成、实际规格本身就违规**。这是「注释声称与实现不符」的典型，详见方法论章节的**判据 0**。

---

## 五、B 类：为功能性缺陷兜底

### 必须上报后端，不能固化

| ID | 位置 | 兜底内容 | 性质 |
|---|---|---|---|
| B-1 | `turnStreamReducer.ts:300` | `event.requestId \|\| \`call-${Date.now()}\`` | 伪造工具调用 ID |
| B-1b | `turnStreamReducer.ts:307` | `event.toolName \|\| AgentToolName.ExecuteCommand` | **伪造工具语义** ——「未知」被伪装成「执行了命令」 |
| B-1c | `turnStreamReducer.ts:170-172`、`190-192` | 事后补写 `turnId` | 掩盖时序不确定 |
| B-17 | `toolMeta.ts:164-172` | `resultStatus` 缺失 → `'unknown'` | `:154-156` 注释把「后端必填」当既定事实，而该断言出自**不存在的文档**（BE-4） |
| B-13 | `utils/error.ts` + `chat.ts:59-62` | `chatApi.fetchSessionMessages` 在 `!treeRes.ok` 时返回错误，导致后续分支不执行 | 把两类失败合成一类 |

### B 类分支决策表（等 QA 回填即可执行）

| 条目 | 依赖 | 若后端「保证」 | 若后端「不保证」 |
|---|---|---|---|
| B-1 | Q1 requestId | 删伪造，改用 `event.requestId`；`types/Event.ts:189` 去掉可选 | **带标记保留 + 上报**，要求后端给出漏发触发条件 |
| B-1b | Q2 toolName | 直接删 | 带标记保留 + 上报，要求字段改必填 |
| B-17 | Q3 resultStatus | 删该映射，解析失败改显式上报 | 保留，但**删掉 `toolMeta.ts:154-156` 甩锅注释** |
| B-1c | Q4 turnId 时序 | 删补写逻辑 | 带标记保留，要求后端给出明确时序契约 |
| B-12 | Q5 maxTokens | 改为「缺字段显示暂无统计」 | **同样改**（见下） |

> **B-1 / B-1b / B-1c 的「不保证」分支不是「保留现状」，而是「保留 + 升级为后端缺陷单」，标注复查日期。** 这三处一旦被当作合理兜底固化，等于把上游缺陷永久写进前端契约。

### B-12 独立于后端（建议单列）

`useChatView.ts:400` 的 `usage?.tokenCount ?? session?.contextTokenCount ?? 0` 把「未采集」显示为 `0` tokens。这违反项目**自己**的铁律（`types/chat.ts:348-351` 明确「未采集不算 0」），与后端无关，**不需要等任何契约确认即可修**。

对照后端 `ChatTurnRuntimeListener.java:42`：「`tokenInfo` 为 null 一律跳过 —— 那是『未采集到』，不补 0」。前端却补了 0，是**前端自行制造的假数据**。

### 其余 B 类

| ID | 位置 | 内容 | 评估 |
|---|---|---|---|
| B-2 | `turnStreamReducer.ts:166-195` | `obtainActiveBubble` 四路查找兜底 | **必需** —— 注释已说明是为兼容首个事件无 turnId |
| B-3 | `turnStreamReducer.ts:256-262/277-283/294-298/407-412/457-461/484-488` | 「收尾所有 running 思考步」代码块重复 6 次 | 重复，非兜底，可抽函数 |
| B-4 | `turnStreamReducer.ts:516-519` | `allocateOrder` 的 `×10` 编号 | 简化的时序排序，可保留 |
| B-11 | `markdown.ts` | ~~疑似 XSS~~ | **已证伪**：`html:false` + `DOMPurify.sanitize` 双重防护，无风险 |

---

## 六、C 类：重复实现

### C-4 同一 outcome 词表的 4 份独立实现 ⚠️ 行为不一致

| 位置 | 判定 | `ANSWERED` | `CANCELLED` |
|---|---|---|---|
| `utils/approvalOutcome.ts:10-13,33-40` `resolveApprovalState` | 自称「唯一定义处」 | `'unknown'` | `'rejected'` |
| `utils/cardUi.ts:14-20` `resolveCardTone` | 时间线折叠行状态点 | `'approved'` | **`'unknown'`** |
| `components/chat/PlanCard.vue:55-61` | 计划卡内联 | 不覆盖 → `'unknown'` | 不覆盖 → `'unknown'` |
| `components/chat/DelegationWaitCard.vue:26-39` | 委派卡内联 | 不覆盖 → 落 `'failed'` | `'cancelled'` → tone `'unknown'` |
| `utils/session.ts:376-382` | 历史路径内联 | `'unknown'` | `'failed'` |
| `utils/toolMeta.ts:160-172` `resolveToolExecutionStatus` | 吃 `resultStatus`（**不同字段**） | 不适用 | 不适用 |

**分歧有两个字段，不是一个**（初版报告只记了 `ANSWERED`，主理人复核时补上 `CANCELLED`）：

- **`ANSWERED`**：`approvalOutcome.ts` 判 `unknown`、`cardUi.ts` 判 `approved`。两者**同时在生产中被消费** —— `ApprovalCard.vue:57`（卡本体）与 `ChatMessageItem.vue:417`（折叠摘要行）。于是**同一张已决提问卡在同一屏内显示两种状态色**：卡本体灰、摘要行绿。
- **`CANCELLED`**：`cardUi.ts:18` 的 rejected 词表漏了它，落到 `'unknown'` 灰点；其余三处都判「已决/已取消」。

**结构性根因**：`approvalOutcome.ts:2` 的文件注释写「审批结论判定（**唯一定义处**）」，但 `cardUi.ts` / `PlanCard` / `DelegationWaitCard` 都没引用它 —— 「唯一定义处」的声明已经失效。三份硬编码里还各写了一遍 `String(x ?? '').trim().toUpperCase()` 归一化（`cardUi.ts:16`、`PlanCard.vue:53`、`DelegationWaitCard.vue:24`），连 `normalizeOutcome` 这个已导出的函数都没用上。

⚠️ 附带：`PlanCard.vue:55-61` 的判空顺序有独立缺陷 —— `if (isPending) return 'pending'` 排在 outcome 判定**之后**，若两者同时成立，已决状态会被 `pending` 覆盖。

### C-9 归约逻辑 4 处（最大结构性重复）

| 位置 | 场景 |
|---|---|
| `turnStreamReducer.ts:166-217` `obtainActiveBubble` | 流式 |
| `utils/session.ts:269-311` `getAssistantContainer` | 历史 |
| `turnStreamReducer.ts:81-93` `appendUserMessage` | 乐观气泡 |
| `useChatView.ts:143-152` | 骨架气泡合成 |

### C-1 两套 ID 判据并存

`isPersistedSessionId`（`/^\d+$/` 且非 `0`）vs `!isTempSessionId`（仅排除 `temp-`）。

**由此发现一条死分支链（C-1b）**：`createTempSessionId` 只被 `chat.ts:526` 的 `createNewSession` 调用，而 `createNewSession` 自身零调用 → **`temp-` 前缀永不产生** → 4 处 `isTempSessionId` 判断（`useChatSending.ts:141`、`useChatSessionList.ts:67/116/130`、`useChatSubSession.ts:37`、`ids.ts:43`）全是死分支，且与项目记忆记载的「必须用 `isPersistedSessionId`」矛盾。

### 其余 C 类

| ID | 内容 |
|---|---|
| C-2 | `AgentAPI.stop` 两个调用方（`chat.ts:67`、`useChatSending.ts:142`），绕过已封装的 `chatApi` |
| C-5 | `messageRender.ts:7` 再导出 3 个类 |
| C-6 | `useChatView.ts:88` `displayIsDark` 仅转发 `sharedIsDark` |
| C-7 | 工具分类映射在 `toolMeta.ts` 与 `chat.ts:447` 各一份 |
| C-8 | `buildMessageTurnMap` 双入口调用（`:422`、`:427`），逻辑同一份 |
| C-10 | 终态收尾代码块 6 次重复（同 B-3） |
| C-11 | 心跳分支：`SseEventPublisher.heartbeat` 每 30s 发 `: ping`，前端 `sse.ts:126` 静默丢弃 |
| C-12 | `contextUsage` 存储与派生双写 |

---

## 七、D 类：过度降级

| ID | 位置 | 降级行为 | 评估 |
|---|---|---|---|
| D-2 | `sse.ts:102-104` + `useChatSending.ts:91-107` | `readSseStream` 的 `onError` **未接**，短路后不 rethrow、不 console，函数以 fulfilled 返回 | **机制已证 P1，根因在后端 BE-1**；用户可见表现未验证 |
| D-2b | `sse.ts:61-64` | 空 body 时同样短路，`useChatSending.ts:109-110` 照常执行滚动与对账，`:118` 失败提示永不触发 | **无条件缺陷**，与后端无关 |
| D-1 | `sse.ts:146-151` | `JSON.parse` 失败返回 `null`，无告警 | 静默丢弃损坏事件 |
| D-3 | `useChatHistory.ts:72` | `tree.root.lastOutcome \|\| 'COMPLETED'` —— 把「从未终结」默认成「已完成」 | **反向失真**，比留空更糟 |
| D-4 | `ChatMessageItem.vue:1148` | `tokenInfo` 缺失时显示 `0` tokens | 违反项目铁律（同 B-12） |
| D-7 | `toolMeta.ts:19`、`json.ts:66` | catch 后返回空值 | 静默 |
| D-10 | `utils/session.ts:485-508` | AI 行携带的 `toolCalls` **不带 `result` 字段**，push 时不带 → 工具输出永久为空，UI 显示「无内容」 | 与 TOOL 行路径重复实现工具调用，后者有 `result`、前者没有 |

**D-2 的责任归属（重要）**：前端 `onError` 未接只对**传输层中断**（网络断、网关超时）有影响；应用层异常场景下 `done=true` 根本进不了 catch。**根因是后端 BE-1 —— 改前端无效。**

---

## 八、影响面排序（按用户可感知程度）

| # | 条目 | 用户可见后果 |
|---|---|---|
| 1 | BE-7 | 上下文占用百分比偏大 3.8 倍，进度条误导用户以为快满 |
| 2 | BE-5 | 否决的计划显示「状态未知」而非「✕ 计划已被否决」（红点变灰） |
| 3 | BE-4 | 执行失败时实时路径看不到任何失败原因 |
| 4 | B-1b | 工具名缺失时渲染成「执行命令」卡片（类型错误） |
| 5 | C-4 | 同一张卡片在不同入口显示不同状态色 |
| 6 | B-1 | 伪造 ID 的工具卡刷新后消失（流式与历史粒度不一致） |
| 7 | D-10 | 历史里工具输出永远为空 |
| 8 | BE-2 | AI 载荷解析失败 → 思维链与工具调用消失 |

> C-3 初判曾被定为「派生层与状态层互相污染」的架构级问题，**经复核不成立**：reducer 写入的是 `session.messages`（`streamSessionRouter.ts:43` 传访问器），不经过 `displayedMessages`；骨架气泡对 reducer 不可见。`ChatMessageList.vue:64` 的 key 是 `:key="msg.id"`（稳定 id 非 index），不会产生 DOM 复用错乱。

---

## 九、建议落地项（本次未执行任何修改）

**唯一建议真正落地的改动**（成本一行注释，防的正是本次审计中最容易被误判的那个坑）：

1. `useChatView.ts:134-135` 补：「本 computed 为只读派生视图，reducer 直写 `session.messages`，二者不交叉」
2. `turnStreamReducer.ts:166` `obtainActiveBubble` 补守卫条件说明（四路查找各自的触发场景）

**按类别处置**：

| 类别 | 处置 |
|---|---|
| A（14 条） | 可直接删。其中 A-9 建议先删后验 |
| B（18 条） | **B-12 / D-4 / B-3 建议尽快改**（不依赖后端）；其余 4 条等契约确认；B-1/B-1b/B-1c 无论契约如何都要**建立后端缺陷单** |
| C（22 条） | 先定唯一真源（建议以 `approvalOutcome.ts` + `toolMeta.ts` 为准），再合并 |
| D（8 条） | D-2b 立即修；D-2 待后端；D-3 / D-4 立即修 |
| **BE-7** | **最高优先级**：上下文百分比分母取错字段（`userConfig.maxTokens` 是输出上限 102400，上下文窗口真源是 `application.yaml:133` 的 393200）。**不要改成硬编码 393200** —— 换模型就又错了，正确做法是去掉兜底走「未知」态或由后端在 `CONTEXT_UPDATE` 固定下发 |
| **BE-5** | **次高优先级**：先定契约（`REJECTED` 是否恢复独立取值），再改一侧；两侧同时改会留下存量 `outcome` 数据不一致 |
| BE-1 | **次高优先级**：后端应把启动失败以 `EXECUTION_FAILED` 事件告知前端，而非 `log.error` 吞掉 |
| BE-2 | 修后端降级时**必须同步改** `SessionMessageViewAssemblerTest:50-54`（当前断言锁死了违规行为） |
| BE-6e | 补领域仓储接口，把 `SessionMessageQueryService` 对 `SessionMessageRepositoryImpl` 的依赖收回分层内 |
| BE-4 | 要么恢复 `docs/frontend-backend-contract.md`，要么改掉 9 处注释的「契约来源」表述 |

**建议的修复批次**：

1. **第一批（零风险）**：A 类 14 条 + D-3/D-4 + 两行注释（`useChatView:134`、`turnStreamReducer:166`）。全是纯删除，不改行为。
2. **第二批（先定契约）**：BE-5 与 BE-2 一起定 —— 两者本质是同一个问题的两面：**后端用「降级保住数据」换来了前端语义塌陷**。契约定了之后前端 5 处 outcome 词表与后端 1 处枚举同时对齐。
3. **第三批（收敛重复）**：以 `approvalOutcome.ts` 为唯一真源，删掉 `cardUi`/`PlanCard`/`DelegationWaitCard` 三处内联词表与三处重复归一化，把 `resolveCardTone` 改成调用 `resolveApprovalState`。C-9 的 4 处归约逻辑合并为 1 处。
4. **第四批（架构）**：BE-1 异常上报、BE-6a 去掉热路径 DB 回查、BE-6e 收回 DDD 分层。这三条都要改后端结构，建议单独排期。

---

## 十、未决项（如实标注）

| 事项 | 状态 |
|---|---|
| **BE-5 契约归属** | 后端注释把「是否恢复 `REJECTED`」标为待确认前端消费情况；现已证实**前端确实消费**（`PlanCard:57/65` 专门写了分支与文案）。但「改 wire 值」的影响面（存量 `raw_output.outcome` 数据、5 处前端词表）需产品/后端共同定，**本次只读审计不代决** |
| Q1-Q5 五条契约判定 | QA 后端审计已交付 31 条，Q1-Q5 未逐条回填。**B-1/B-1b/B-17/B-1c/B-12 的处置取决于此**，分支决策表已备好 |
| Q6-B 传输层中断 | 结论已确定（前端无心跳感知能力，零命中 `heartbeat`/`watchdog`/`timeout`），仅「后端有无补偿机制」未确认 |
| A-3 / A-10 | 需 `git log` 定性是遗留还是被移除，本次未查 |
| BE-2 触发条件 | 存量数据在什么情况下解析失败未确认（决定这条是理论缺陷还是已发生缺陷） |
| BE-6b / BE-6c / BE-6f | 需产品/架构口径：`COMPLETE_TEXT` 与 `AI_MESSAGE` 为何并存、`STREAM_KEY` 写入方是漏了还是已删、v1 决策接口下线时点 |
| 用户可见表现 | D-2 的「气泡是否永久停在 isThinking」未做端到端验证（需起后端实测，项目记忆记载起第二实例会被 `mcpManager` SSL 握手挡住）。BE-5 的用户可见表现**已由代码闭环证明**，无需实测 |

---

## 十三、清理行动记录（第一批：已落地）

用户授权后启动清理。**全程不 commit**（工作区有 195 项并发改动，提交会污染他人工作）。

### ✅ 执行结果：8 项已落地，门禁全绿

**实际删除 8 项 + 修改 1 处注释。门禁：`vue-tsc -b --force` EXIT=0，8 组测试 52/52 全通过**（sseParse 10、crossPageTurn 10、streamRendering 8、qaIndependentVerification 6、chatLiveRenderFixes 2、frontendRenderFix 5、promiseCard 8、subSessionHistoryReuse 3）。

| # | 目标 | 落地结果 |
|---|---|---|
| A-1 | `views/chat/messageRender.ts` **整文件** | ✅ 已删。barrel 文件，`renderStreamEvent` 零引用；re-export 的三个类均从原文件直接 import，删除不影响任何消费者 |
| A-2 | `turnStreamReducer.ts:161` `updateSessionId` | ✅ 已删。删后核实 `sessionId` 仍有 3 处读取（`:83`/`:192`/`:391`），无 TS6133 |
| A-4 | `types/chat.ts` `branches` / `activeBranchIndex` | ✅ 已删（含 `// 对话多分支相关` 注释行） |
| A-5 | `types/chat.ts:148` `imageFile` | ✅ 已删。ChatMessage 上的字段零写入零读取；`useChatView` 的同名形参/`ChatInputArea` 的 emit 签名未受影响 |
| A-8 | `utils/session.ts:546` `parseSessionMessages` | ✅ 已删。**连带修正 3 处注释引用**：`chat.ts:306` 的 `{@link}`（会误导维护者）、`SubSessionDetailDrawer.vue:62` 中文注释、`subSessionHistoryReuse.test.ts:19` 测试注释 |
| A-13 | `services/agent.ts:68` `AgentAPI.chat` | ✅ 已删。在用的是 `chatStream`，未动 |
| A-14 | `services/chat.ts:66` `chatApi.stopGeneration` | ✅ 已删。停流实际走 `useChatSending.ts` 的 `AgentAPI.stop`；`chatApi` 对象本身保留（内含在用方法） |
| A-12 | `streamSessionRouter.ts:125` 的 `_meta` 形参 | ✅ 已删（函数保留）。**`:103` 调用点同步去掉实参 `meta`**，否则参数数量不匹配 |
| — | `utils/format.ts:23` `formatTokens` | ✅ 已删（清理过程中新发现的死代码，见下） |
| 注释 | `ChatServiceImpl.java:266` 英文注释 | ✅ 已译为中文：「会话树里既有历史执行，也有当前活跃的执行，取消时命中已终结的执行属正常情况。」（AGENTS.md 要求业务侧全中文 doc） |

### 🔴 清单本身错了 4 项（复核推翻，非「代码与清单不符」）

这是本次清理最重要的产出 —— **原清单 11 项里有 4 项判断错误**：

| 项 | 原判 | 实测 | 结论 |
|---|---|---|---|
| A-7 `types/chat.ts:145 tokens` | 死字段 | **4 处活跃读取**（`ChatMessageItem.vue:1098`/`:1124`/`:1148`/`:1164`） | **保留**。它是 `tokenTooltip` 三级回退的末级（`execSummary` → `tokenInfo` → `tokens`）。后端 `SessionMessagePageVO.java:32-33` 注释佐证：旧消息无 `turns` 即无 `execSummary`，`msg.tokens` 可能是老消息唯一用量来源 |
| A-10 `session.ts:558 synthesizeFailedTurnBubbles` | 死代码 | 零调用，但**不是残留** | **保留**。详见下方 L0 判据 |
| A-15 `turnStreamReducer.ts:178` | `if (!turnId)` 不可达回退分支 | 该行是 `if (turnId)` **正逻辑复用气泡** | **剔除**。删它会改变气泡复用行为（已有气泡不再被复用 → 走到末尾兜底或新建），属行为变更 |
| A-3/A-6/A-9/A-11 | 死代码/待合并 | 需 `git log` 定性或改变行为 | 本批不动，留第二批 |

### 🔴 L0 判据（本次新增，最可复用的一条）

> **零调用方有两种可能：一种是残留，一种是「修复没接上线」。判死之前必须先问「按设计谁应该调它」，答不出来才能判死。**

`synthesizeFailedTurnBubbles` 是这条判据的教科书案例：

- 按 L2（数据有出口）判据，它零调用 = 死代码 ✅
- 但按 L3（用户可见），**不可达本身就是缺陷的症状，不是代码的病因**

它的注释（`session.ts:550-557`）逐字对应审计发现的「实时路径失败原因无出口」：失败轮次在 `session_message` 里常常只有 USER 行，而 FAILED 徽标只挂在 assistant 气泡（组尾）上 —— 缺行即徽标无处渲染，**用户刷新后彻底看不见失败**。这个函数就是那个修复的后半截（刷新路径补偿），**写好了，只是没人在消息解析出口调它**。

删掉它 = 删掉一个已论证清楚的修复的唯一实现，只留下注释描述的那个缺陷 —— **与「清理死代码」的方向完全相反**。已改为「接线」待办（见下方第二批）。

### 🔴 死代码 vs 在用代码：先验证哪个是活的

清理 `format.ts` 时发现一个反直觉结构，**方向与「统一到唯一真源」的直觉相反**：

| | `format.ts:23` `formatTokens` | `ChatMessageItem.vue:1114` `formatTokenCount` |
|---|---|---|
| 引用 | **零** | 在用（`displayTokens`） |
| 缺省输出 | `if (!t) return '0 tok'` —— 把 `null`/`undefined`/`0` 三种语义合并，**违反「缺省≠0」铁律** | 走 `tokenTooltip` 三级回退，缺省显示「暂无统计」 |
| 字符串 | `1.2K tok` | `1.2K`（**无 tok 后缀**） |

两者**字符串有差异**，所以当初「收敛到 `format.ts` 唯一实现」的那次重构是假的 —— 注释里列的三个「被替换位置」（`SubAgentSidePanel.vue:50-53` 等）如今 `tok` 零命中，**文档宣称已完成、实际连自己写的规格都违规**。

**结论：删掉的是违规那份，保留的是合规那份。** 教科书式的「唯一真源」反噬 —— 真源本身成了死代码。已删 `formatTokens` 并把 `format.ts` 头部注释改为如实描述现状（含为何 Token 格式化不在本模块）。

### 暂缓：删伪造 requestId 兜底（`:295`）—— 但前置条件已降为「一行守卫」

`turnStreamReducer.ts:295` 的 `event.requestId || \`call-${Date.now()}\`` 是 B 类铁律违反（前端伪造 ID），**必须删**。但需要先确认删除后下游会怎样 —— 这里的分析过程本身值得记录，因为**我先判错了，架构师纠正后才对**。

**两处下游消费点，语义完全不同**：

| | `ChatMessageItem.vue:869` 去重 Map 键 | `ChatMessageItem.vue:941` Vue `:key` |
|---|---|---|
| 用途 | 决定「是否合并为同一条」 | 仅需列表内唯一 |
| 要求 | **幂等收敛**（同一子代理多次调用折叠成一项，`:868` 注释明说有意为之） | 无 |

**我先前的判断（错）**：删掉 `:295` 的兜底后，`:869` 的 `tc.id` 会拿到 `undefined` → 全部塌成同一键 → 同一子代理的 N 次调用被合并成 1 条，UI 显示「1 成员」。**据此我判定「必须先给 `:869` 设计新去重键，是前置设计任务」。**

**架构师的反驳（对）**：这个推论假设「`toolCalls` 里会存在 `id === undefined` 的元素」。但 Stage 1 的实现形态是「**`requestId` 缺失 → 整条 trace 不 push**」—— 元素根本不会进数组。已核实全仓 `toolCalls.push` 只有 4 处：

- `turnStreamReducer.ts:326`（实时，唯一入口，Stage 1 后元素必带真实 id）
- `session.ts:403`（`id: resolvedCallId`）· `session.ts:495`（`id: callId`）（历史路径，取自后端 VO 载荷，非模型输出）

**所以 `:869` 的第 4 级 `tc-${idx}` 兜底在 Stage 1 之后确实不可达，但不可达的原因是「元素不会存在」，不是「元素存在但 id 为空」—— 没有「塌成同键」这个失效模式。**

**结论：`:869` 不需要改。** Stage 1 只需在 `:295` 之前加一个 `if (!event.requestId) return;`（配套 `console.warn`，理由是「失配不可观测」），是**一行守卫 + 一行日志**，不是设计任务。

⚠️ **实施红线**：**不得用 `as string` 强转绕过**。`types/chat.ts:22` 的 `id: string` 是编译期约束 —— 写成 `id: event.requestId` 直传会让 `vue-tsc` 报 `string | undefined` 不可赋，**这个报错是期望行为**，是类型系统在替我们拦截。强转后 `undefined` 会进 id，`:941` 的 `|| tool-${idx}` 立刻接不住。

⚠️ **本条自身的教训**：我给架构师回执时写「`:869` 与 `:946` 语义相反，所以不能同 PR 改」—— **前半句对（语义确实相反）、结论错（不构成阻断）**。「语义不同」不等于「一个改动会破坏另一个」。当时我凭「两处长得像」的直觉推断了因果，没有反向验证「元素是否真的可能不存在」。**这是「读代码推演」翻车的第四次。**

### 清理中发现的新条目（本批未动）

| ID | 位置 | 内容 |
|---|---|---|


### 双重验证机制

工作区有 195 项并发改动，**很可能已有测试是红的**。基线与事后验证由主理人主通道建立（**删除前 / 删除后两次都是当场实测，无人从旧基线推断**）：

- **基线（删除前）**：`vue-tsc` EXIT=0；7 组测试 49/49 全绿
- **事后（删除后）**：`vue-tsc` EXIT=0；8 组测试 52/52 全绿（含新增的 `subSessionHistoryReuse` 3/3）
- **零漂移确认**：删除后 grep `parseSessionMessages` / `updateSessionId` / `AgentAPI.chat` / `chatApi.stopGeneration` / `messageRender` / `activeBranchIndex` / `formatTokens` → 全部零命中（仅 `format.ts:17` 注释中作为历史说明提及）

**一个意外收获**：删除 `messageRender.ts` 后，审计阶段记录的「该文件带 3 个 TS6133」自然消失，且**没有暴露其他新报错** —— 说明当前工作区类型层是干净的，不存在隐藏的悬空引用。

### 团队执行纪律复盘（本次最值得记的教训）

清理任务派发**四次才落地**：

| 轮次 | 执行方 | 结果 |
|---|---|---|
| 1 | 工程师 | 只回分析报告，未动手 |
| 2 | 工程师（更详细 + 「请开始动手」） | 仍未动手 |
| 3 | QA | 报告 shell 输出通道失效，未动手 |
| 4 | QA（附基线 + 逐行证据 + Read 回读要求） | 仍未动手，但**核实质量最高** |
| 5 | **主理人自己动手** | ✅ 10 分钟内全部落地 |

**失败根因不是能力，是任务描述形态**：「删除 A/B/C 三处死代码」对成员是**开放式判断题**（要自己决定怎么改），成员倾向先输出分析；而「把 `chat.ts:151-152` 这两行删掉，删完 Read 回来确认」是**确定性动作**。派发纯执行任务必须写成后者。

**另一条**：成员的 shell 通道故障是真的（`echo` 都拿不到 stdout，退出码仍为 0），但**主理人通道正常**。遇到成员报「环境故障」时，先自己探一次再决定是否降级方案 —— 否则会误以为全局环境坏了并长时间空转。

### 第二批待办（需用户决策，非纯删除）

| 项 | 性质 | 建议 |
|---|---|---|
| **A-10 接线** | 修复（不是清理） | 在消息解析出口调 `synthesizeFailedTurnBubbles`，关掉「刷新后失败轮次无气泡承载」缺陷 |
| `:300` 伪造 ID | 需前置设计 | 先给 `ChatMessageItem.vue:869` 设计稳定去重键 |
| A-6 `fileEdits` | 行为变更 | 删了会让 `toolDiff.ts:137-139` 第 4 优先级分支变不可达 |
| A-9 `mergeRawRecords` | 连带改测试 | 仅测试使用 |
| A-11 `isAbortError` 双份 | 重构 | 合并需选一个导出 |
| A-3 `processTimeline` | 待定性 | 需 `git log` 判断是遗留还是被移除 |

### 清理中发现的新条目（本批未动）

| ID | 位置 | 内容 |
|---|---|---|

| BE-9 | `ChatServiceImpl.java:265-266` | `catch (IllegalStateException ignored)` 块内是**英文注释**（全仓唯一一处英文字符串注释），违反项目中文注释纪律。成本一行 |
| 待查 | `SseEventPublisher` | `connect` 可对同一 root 多次调用 → `emittersByRootSession` 桶内**可能并存多个 emitter**。`ChatServiceImpl:270-283` 注释记载的真实线上事故正是「前端两个气泡同时收事件」。**前端有无多流合并机制未查证** —— 若无，则存在真实重复渲染风险，且与「静默丢事件」构成两个方向相反的可靠性问题 |

---

## 十四、本次审计的方法论教训

工程师在自查中主动拆掉了自己一条**看起来完全合理**的错误结论（原判 C-3 为「派生层与状态层互相污染」）。错误原因值得记录：**看到派生层凭空造对象，就假设写入方会读到它** —— 跳过了引用层级追踪。

这类失误最危险，因为它产出的结论有行号、有代码引用、有因果链，**看起来完全合理**，会直接误导修复方向。

另一处方法论修正：主理人最初发问「40 条中有几条是 grep 确认零引用」，隐含了「40 条同类」的假设；实际 A/B/C/D 四类性质完全不同（A 可删、B 删了会坏、C 需先定真源、D 需改错误处理），该提法会让「17 项可安全删」被误读成「40 条里能删 17 条」，实际是 62 条目里能删 17 条。

**证据强度分档已在清单中逐条标注**：机器确认（grep 零引用，可安全直接删）/ 语义推理（读了调用方判断，建议先删后验）。

### 「可达性」的四段判据（本次审计最可复用的产出）

「某个失败/错误/事件用户能不能感知」这个问题上，**三位成员各自漏了不同的一层**。把四层拆开后，所有判断失误都能解释：

| 判据 | 含义 | 检查动作 |
|---|---|---|
| **L0 按设计谁该调它** | 零调用方是「残留」还是「修复没接线」 | 读该函数/字段的注释与设计意图，问「按设计谁应该调它」；**答不出来才能判死** |
| **L1 事件可达** | 事件能否到达前端 | 追框架事件发布链到 SSE emit |
| **L2 数据有出口** | 该数据有没有**被渲染的**读取点 | grep **读取点**（不是声明点、不是写入点） |
| **L3 用户可见** | 用户是否真能在界面上看到 | 追渲染组件，确认字段真的被用上 |

**四次失误各自对应漏掉的一层**：

- 「零调用 = 死代码，删掉」→ **漏 L0**。`synthesizeFailedTurnBubbles` 零调用但是「失败原因无出口」缺陷的修复实现，删它等于删掉修复、只留缺陷。**这条是清理阶段才发现的，代价是清单已发出 4 次。**
- 「用户可能看到两种失败文案」→ **漏 L2**。实时那条 `sendError` 根本没有读取点，用户看不到第二种文案。
- 「删掉前端兜底会产生空白气泡」→ **漏 L2**。没查 `sendError` 有没有读取点就下因果链。
- 「`EXECUTION_FAILED` 不可达」→ **误判 L1**。把 `runAsync` 那一层的局部 catch 当成了全局结论。

⚠️ **最隐蔽的是 L2**：字段有声明、有写入、有日志，看起来「完全正常」，但没有任何消费者。它既不会报错，也不会出现在界面上 —— grep `output_mode=files_with_matches` 只能告诉你「有人写」，必须专门查读取点才能定性为死字段。

⚠️ **L0 必须排在最前**：L1-L3 都在问「现在有没有人用」，L0 问的是「按设计应该有没有人用」。**跳过 L0 直接跑 L2，会把「写好但没接线」的修复误判成残留** —— 因为 L2 对它的回答确实是「没有出口」，而 L3 会反过来说「不可达本身就是缺陷的症状」。

### 判据 0：注释-实现一致性（清理阶段新增）

> **读该处注释声明的原则 → 实现是否遵守 → 注释是否与项目铁律矛盾。任一不一致，严重度 +1 档。**

| 位置 | 注释声明 | 实现 | 性质 |
|---|---|---|---|
| `session.ts:518` | 「历史里未回填结果的工具调用：标记为『状态未知』，**不伪造结论**」 | `:524` 编造用户可见文案 `[状态未知] 后端未保留该工具的执行结果` | **直接矛盾** —— 注释声明了原则，实现违反它 |
| `format.ts:21` | 「Token 数量展示：…**缺省/0 显示 `0 tok`**」 | `:24` `if (!t) return '0 tok'` | **把违规写成规格** —— 且与「缺省≠0」铁律矛盾 |
| `format.ts:2` | 「展示层格式化的**唯一实现**」+ 列出 3 个「被替换位置」 | 那 3 处（`SubAgentSidePanel.vue:50-53` 等）`tok` **零命中** | **文档宣称已完成、实际未完成** |

这比「过度降级」本身更值得警惕：**作者意图是好的，实现偏离了意图，而偏离被注释掩盖** —— 维护者读注释会相信代码是对的。第一条尤其严重：注释里的「不伪造结论」是**作者主动写下的自我约束**，而代码在同一个函数里违反了它。

**建议把这三条写进后续审计的固定检查项。** 它对判断其余结论可信度的价值，高于多列几条问题。

### 两条更贵的教训

**① 定级会随情绪走，也会随证据走 —— 要让证据决定**

同一条发现（「实时路径失败原因无出口」）先被工程师定为 P0，理由是「刚发现时的冲击」；经交叉核对后按证据降为 P1。**「定级应随证据走，不随发现时的情绪走」** —— 一次修正的代价是两条都要写进报告，因为读者会看到定级变过，这比一开始定错更让人怀疑其他定级。

**② 链条越长，外推越多，越容易错**

本次审计的失误**不是零星的**，而是系统性的：8 条「为后端缺陷兜底」的因果前提被框架源码推翻，5 条契约结论里 2 条引用了不存在的代码。共同点都是**在缺失证据的位置上补了一个假设，然后用行号和推理链把它包装成高置信度结论**。

**因此给复核者的判断依据是**：本次 Top 5 的每个锚点都经过 QA 逐行重读（见复核记录表），**凡是做过引用层级追踪、跨端追踪、框架源码核对的结论都站得住**；凡是靠「看起来合理」补前提的结论，本报告已逐条标注推翻或降级。

**一条必须分清的界线**：
- ✅ **可靠**：有 `文件:行号` + 跨层因果链 + 被独立复核过的结论（如 BE-5 五环节、BE-7 分母错位）
- ⚠️ **需自行验证**：涉及「后端会不会这样做」而无源码依据的推断（这类本次全部被框架源码验证或推翻）

### 两次「依据权威」都不等于「核对当前仓库」

架构师从**框架 jar 源码**（最高权威来源）推出 5 条契约结论，3 条中 2 条不成立 —— 因为把框架侧实现**外推**到了本项目，而本项目 `AgentEventListener` 只是 129 行的裸转发。**权威来源能证明「框架做了什么」，不能证明「本项目会收到什么」** —— 中间隔着本项目自己的投影代码，必须核对。

同理，成员从**过期工作区**推断出「`aggregateSessionMessages` 零调用」「`UsagePanel.vue` 存在」，全是虚构。

**结论：任何「某文件/某字段不存在」「某函数零调用」「后端会发 X」的断言，都必须对当前仓库重跑一遍 `Glob`/`Grep` 才可采信。** 无论它引用了多权威的来源。

---

## 十二、主理人复核记录（对成员产出逐条验证的结果）

成员结论不直接采信。以下是主理人独立读码验证的结果，**包含对成员产出的一处实质性更正**。

### 已验证成立（可放心据此行动）

| 结论 | 验证方式 |
|---|---|
| BE-5 计划否决显示「状态未知」 | 五环节逐行读码闭环：`ToolCallOutcome:49` → `ToolCallExecutionListener:51` → `PlanCard:57/60/65/70` |
| **v3 bootstrap 协议前端整条未接线** | QA 提出，主理人独立复跑：`services/session.ts:97-99 bootstrap` 零调用，而 `SessionAPI` 其余 8 个方法均有生产调用方；`utils/session.ts:104-110 mergeTurns` 同样零调用；`types/chat.ts:441-447 SessionBootstrapVO` 已定义。**据此更正了本报告的链路图**（初版误把 bootstrap 画成现役历史装配链） |
| **【P0】实时失败原因无出口** | `sendError` 全前端仅 2 处命中：`turnStreamReducer:482` 写入 + `types/chat.ts:144` 类型声明，**零处读取**。`ChatMessageItem.vue:9` 注释称「失败由回答组统一渲染（`turn.status=FAILED + errorReason`）」，但那是历史装配路径；实时链路的 `bubble` 对象上没有 `turn` —— **用户执行失败时看不到任何原因**。与 BE-1（后端吞异常 → 收不到 `EXECUTION_FAILED`）叠加后表现更糟 |
| **【P0】`mergeMessages` 按 id 合并致正文被吞** | 读 `useChatView:190-202`：TOOL 行按 `:id=Number(msg.id)` 匹配、AI 行按 `:id=msg.id` 匹配，两条匹配规则不兼容 → 工具输出挂不上正文行且正文被整段丢弃。**行号已确认，运行时表现待实测** |
| BE-6a 每条事件 2 次 DB 查询而 metadata 已现成 | 读 `ExecutionEventMetadata:37/:60-61` + `ChatTurnRuntimeListener:149-151` 注释 |
| BE-2 三处 `stored.getText()` 降级 | 读 `SessionMessageViewAssembler:49/53/58`，确认 AI 分支降级后 `:60-62` 不执行 → `thinking`+`toolCalls` 全丢。**前端零处清洗 `session_message.text`**（`toText()` 只做空值兜底、不是 JSON 清洗），故违规降级的原样文本直达渲染层 |
| **BE-2 补充：测试把违规固化成契约** | `SessionMessageViewAssemblerTest:50-54` 用断言消息「解析失败按原样降级，消息不丢」锁死降级行为 —— 修复 BE-2 **必须同步改这条测试**，否则改动会被测试挡住 |
| C-4 词表多份实现 | 读 5 处实现，**并修正分歧字段数**（初版只记 `ANSWERED`，实为 `ANSWERED` + `CANCELLED` 两个） |
| `:353` 兜底不对称 | `TOOL_CALL` 有 `requestId`/`toolName` 双兜底（`:300/:307`），`TOOL_COMPLETED` 一个都没有 → 缺 `requestId` 时工具终态永久丢失 |
| `syncSubSessionLifecycle` 漏终态 | 读 `streamSessionRouter:186-207`，确认处理了 STARTED/COMPLETED/FAILED/SUSPENDED/RESUME，**唯独没有 `EXECUTION_CANCELLED`** → 子执行被取消时根卡片永远停在「调用中」 |
| `useChatView:400` 违反项目铁律 | 铁律原文见 `chatSessionStore.ts:30`「快照缺 tokenCount（尚未采集）时同样跳过，**不伪造 0**」、`Session.java:79`「null=尚未采集」；而 `:400` 恰恰 `?? 0`。**存储层小心保留的 null 被视图层抹平** —— 这是自相矛盾，不是风格问题 |
| 记忆过时项 4 条 | 冗余返回键 7 个非 6 个；`retryInitialLoad` 有调用方（`SubAgentSidePanel.vue:346`）非死代码；wire 事件名是 `EXECUTION_RESUME`/`EXECUTION_COMPLETED`/`EXECUTION_FAILED`/`EXECUTION_CANCELLED` |

### 已更正的成员结论

**⓪ 工程师主动撤回「失败文案在流式与历史两条路径都双重不可达」**
初判 `execStatusMeta`（`session.ts:568-583`）与 `sendError`（`turnStreamReducer:482`）都因「历史/实时对不上」而不可见。撤回理由成立：历史路径下 `errorReason` 由 turn 侧（`chatTurnRepo` 摘要层）承载，**并不经过 `bubble`**。可见性只剩「实时失败时无出口」这一条 —— 见上表 P0。**主动撤回比勉强圆场更有价值**，这条自查使结论从「两个都不可达」收敛到「一个不可达」，避免了在错误位置做修复。

**① 工程师 C-3 误判（已由工程师自行重写）**
初判「派生层与状态层互相污染」的架构级问题。错误原因：看到 `displayedMessages` 凭空合成骨架气泡，就假设 reducer 会读到它。实际 reducer 写入的是 `session.messages`（`streamSessionRouter:43` 传访问器 `() => this.currentRootSession?.messages ?? []`），不经过 `displayedMessages`；`ChatMessageList.vue:64` 的 key 是 `:key="msg.id"`（稳定 id 非 index）。**定性降为「展示层短时重复气泡」**，自愈条件：真源末条 role 不再是 user 即消失；上界：窗口内只多 1 个。

**② 工程师「`aggregateSessionMessages` 生产零引用 / `UsagePanel` 上下文用量组件」——不成立，已删除该条**

主理人复核时 grep 全 `frontend/src`：
- `aggregateSessionMessages` 在 **`src/services/chat.ts:328`（`fetchSessionMessages` 分页解析）生产在调**，另有多处测试调用。它是历史消息的真实装配入口，不是死代码。
- `frontend/src/components/chat/UsagePanel.vue` **文件不存在**（`Glob` 零命中）；`lastOutput` 字段在前端源码中**零命中**。上下文用量的真实链路是 `useChatView:393 contextUsageIndicator` → `ChatView.vue:189` → `ChatInputArea` 的 `:contextUsage`。

该条目基于不存在的文件与字段得出，已从报告中移除。**保留其成立部分**：`useChatView:400` 的 `?? 0` 确实违反项目铁律（见上表），已单独立项 —— 并在 BE-7 中追出了更严重的下位问题（分母取错字段）。

**③ 架构师三条「契约违反」——3 条中 2 条不成立，未采纳**

架构师从框架权威源码（`harness-core-1.1.0-sources.jar`）推出 5 条契约结论，方向上有价值，但主理人逐条验证后**只采纳 1 条**：

| 架构师结论 | 核验结果 |
|---|---|
| 问题 5：上下文百分比分母语义错位 | ✅ **成立且严重** → 已立为 BE-7（P0），本报告 P0 首位 |
| 问题 1：`SseEventPublisher` 硬编码 `"DONE"` 致前端 onDone 永不触发 | ❌ **不成立**。`grep -rn "\"DONE\"" src/main/java` 与前端 `src/` **双向零命中** —— `DONE` 这个事件名在本项目中根本不存在 |
| 问题 2：`turnId` 三源不一致（`:50/:56/:71` 分别赋 executionId / "0" / uuid） | ❌ **不成立**。读 `ChatTurnRuntimeListener.java` 全文（169 行）：`markRunning(event.executionId(), event.timestamp(), resolveRootSessionId(event))` —— **没有任何 `turnId` 字符串赋值**，架构师引用的三个行号在该文件中不存在 |
| 问题 3：`ChatTurnRuntimeListener:57` 错误文案硬编码 | ⚠️ **半成立**。`FALLBACK_TEXT = "执行异常"` 确实存在（`:57`），但「与前端 `turnStreamReducer:482` 硬编码 `'执行异常终止'` 不一致」这层已由「实时失败原因无出口」覆盖 —— 前端那句**根本不会被渲染**，不存在「用户看到两副面孔」 |

**这条纠正本身的教训**：架构师引用了**权威来源**（框架 jar 源码）并给出了完整证据链，但把框架侧的实现细节**外推**到了本项目代码上 —— 而本项目 `AgentEventListener` 只是一个 129 行的裸转发（13 个 `onXxx` 全部直接 `broadcast(event)`，零加工）。**「依据权威」不能替代「核对当前仓库」**。这与工程师的「引用层级外推」是同一种失误的两种表现。

**④ 主理人自我修正：BE-6a 的表述**

初版写「现成字段不用而在热路径回查，纯浪费」。复核发现 `AgentEventListener:120` 注释写明「复用会话解析结果，避免 rootSessionId(executionId) 再次查询执行表」—— 这是**有意的两段式设计**（先查 sessionId 再由它得 rootSessionId），不是遗漏。已改为「属可优化项，不属缺陷」。

### 复核方法上的一条纪律

成员产出里凡是「某文件/某字段不存在」或「某函数零调用」的断言，**主理人必须用 `Glob`/`Grep` 独立复跑一遍再采信** —— 这类断言看起来最无争议，实际上是成员对着过期工作区推断的高发区。反过来，「某分支永不命中」这类需要跨层追踪的断言反而更可靠，因为它必须自圆其说才能写出来。

### ⚠️ 工作区并发修改与行号可信度（交付时点核验）

交付前 QA 报告「工作区正在被并发修改」。主理人随即做了全量行号复核，结论如下：

**核验时点**：`git status --short` 共 **195 项改动**，且审计涉及的核心文件全部是**未提交的新增/修改**文件 —— `turnStreamReducer.ts`、`streamSessionRouter.ts`、`useChatSending.ts`、`cardUi.ts`、`types/Event.ts` 均在 `??`（untracked）列表中。这意味着**本报告的行号绑定的是一个未提交的工作区快照**，一旦这些文件被继续编辑或提交，行号会漂移。

**已复核未漂移的关键行号**（逐条重跑 `grep -n` 确认）：

| 结论 | 行号 | 状态 |
|---|---|---|
| BE-5 枚举塌缩 | `ToolCallOutcome.java:49` | ✅ 未变 |
| BE-5 落库路径 | `ToolCallExecutionListener.java:51` | ✅ 未变 |
| BE-5 前端分支 | `PlanCard.vue:57` / `:65` / `:70` | ✅ 未变 |
| BE-2 三处降级 | `SessionMessageViewAssembler.java:49/53/58` | ✅ 未变 |
| 实时失败无出口 | `turnStreamReducer.ts:482`、`types/chat.ts:144` | ✅ 未变 |
| 临时 ID 兜底不对称 | `turnStreamReducer.ts:300` / `:307` / `:353` | ✅ 未变 |
| C-4 `CANCELLED` 分歧 | `cardUi.ts:18` 词表缺 `CANCELLED` | ✅ 未变 |
| C-4 `ANSWERED` 分歧 | `approvalOutcome.ts:10` vs `cardUi.ts:17` | ✅ 未变 |

**已知失效的引用**：QA 报告中的 `shared/vo/ChatTurnVO.java` 已迁移至 `turn/application/vo/ChatTurnVO.java`（行号不变）。**本报告未引用该文件**，故不受影响；但这说明后端包结构正在重构，后续若要复核本报告，请以 `turn/application/vo/` 为准。

**给复核者的提醒**：本报告的**结论**（因果链、层级追踪、行为分歧）不依赖行号，行号仅用于定位。若发现行号漂移，请沿因果链重新定位，不要因为行号变了就认为结论失效 —— 反之也不要因为结论成立就跳过核对当前代码是否已被修掉。
