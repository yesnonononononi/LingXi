
## v3 同步与失效语义（10-05 交付复核后定案，勿回退）
- 🔴 `applyHistoryInvalidated` **必须先比 revision**：同值=幂等重放（跳过）、更旧=迟到帧（忽略）、仅更高才推进代际。曾无条件作废 → 回放暂存的同代际失效帧会清掉刚装入的 bootstrap 快照，连接停在 live 永不恢复
- 🔴 `HistoryInvalidated` 载荷**必须带 `turnIds`/`executionIds` 范围**。`ConversationRollbackService` 早已把范围塞进 `CommittedStateChange`，观察者曾经没搬运 → 前端只能整树清空 → 重发丢有效前缀
- 范围删除**只有一套实现** `discardRowsByRange`，供「代际作废」与「重发回执」共用
- 无范围换代（纯 rollover）→ `discardRowsByTombstonedStreams`：按**已被立墓碑的 streamKey** 摘孤儿行，不整树清空
- `tools` 槽是工具版本比较基线：**历史 TOOL 行的 `record.toolCall` 必须并入**（`applyHistoryPage`）。不并入则回放旧 pending v1 会因无边线被当新实体接纳 → 审批按钮复活。顺序：**先历史(3f) 再对账(3g)**
- `reconcilePendingTools` 只清 `pending === true` 且不在未决集合里的实体 —— 已决断 v2 不在集合里是正常的，不能删
- `stage` 溢出**必须走 `abortSync`**（作废 token）；只 `setPhase(idle)` 会让旧 bootstrap 被接纳为 live
- bootstrap 失败/溢出统一出口 → `streamV3Sync` 有界退避（1s/2s/4s，成功清零）。**用 `window.setTimeout`**（裸 `setTimeout` ≠ `window.setTimeout`，测试补丁拦不到）
- 界面业务运行态**只认 v3 `sessions` 实体**（按根取）；本地 `activeStreamCount` 只是「请求尚未受理」的乐观占位
- 终态对账 watch 返回 **`根:终态执行id集合`**（无终态返回空串）。返回标量/布尔会让第二次执行收尾不触发
- ⚠️ 已知生产缺口（审查 §5，无失败反例）：①TOOL 提交后无 v3 广播（决断只覆盖 ready，其余走 v2 `ToolCallPendingEvent`）；②普通工具结果不在 `MESSAGE_COMMITTED`；③`setContextUsage` 无生产写入方；④v2 观察者仍在提交链查库
- ⚠️ 能力边界：**切走期间未落库的 token 不会被 bootstrap 重建**（无事件回放）

## 交付复核测试入口
- `frontend/tests/streamV3DeliveryAudit.test.ts`：8 条真实链路反例（D1–D6），已纳入默认 `npm test`
- harness `tests/harness/streamV3Harness.ts`：只替换网络边界（fetch/bootstrap/分页），其余走真实 `sseRouter`/`streamV3Sync`/`streamV3Store`/`messageProjection`
- execution 状态编码 0创建/1运行/2暂停/3完成/4失败/5取消（权威 `LocalExecutionRepository.statusOf`）
- `SessionExecutionRegistry.beginRoot` 单飞，已在跑抛 ClientException；`unregister` 的生命周期通知必须在 `synchronized` 之外（锁序）
- `ExecutionStartupReaper`：status IN(0,1)→FAILED
- 子会话复用键 `(root_session_id, agent_id)`，`SessionRepository.findByRootAndAgent` 唯一入口
- **子会话挂起语义（10-01 定案，勿当 bug 修）**：委派在子执行挂起点定稿，根会话立即收尾不等待、审批恢复带外续跑、**子会话结果不回流根会话**
- execution 禁存业务事实（只 id/session/status/snapshot/root/时间）；模型与 token 权威在 `chat_turn`

## SSE 消息模型（前端 v1）
- `AI_MESSAGE` = 一个模型轮次结束。工具轮 text 常非 null，禁 `event.text ?? currentTurnText` 兜底
- 🔴 **正文只许来自「终结轮次」（该轮无工具调用）**，工具轮文本都是过程叙述；禁按"整轮用过工具"判
- `finalizeLastAiMessage` 已 10-02 删除，**禁复活**。`intermediateAiMessages` = 文本 ≠ content 且去重的其余条目
- 连接拓扑：1 会话级 + 在飞请求级；`publish` 空桶直接 return → 切走的会话事件丢失、无兜底轮询
- 阶段 D 待退休但仍在（旧实现）：`activeStreamCount` 闸门（13 处）、`botMessage` 闭包、`botMsgId` 钉住、`latestAssistant` 回落、`promptCard`/`promptCards` 双结构、卡片异步 IIFE 写闭包、按正文相等防重、Vue key 兜底。已退休 `settleComplete`

## 重发（10-02 定案）
- 只有一个语义：按 checkpoint（`messageId`）编辑当时输入后重发；只一个端点 `POST /a/completion/resend`
- 作废 = 目标轮次及其后 `session_message`/`tool_call`/`chat_turn` 三处物理删除（单事务）
- 顺序不可动：校验→定位（消息/轮次/会话三重归属）→`prepareForResend`（取快照基线，不读 session_context）→`guardNotSuspended`→`beginRoot`→回滚→`connect`→异步 `executePrepared`。回滚必须在 beginRoot 之后
- 前端遗留未动：`handleResendMessage` 仍是纯前端就地重试

## MCP
- Windows stdio `command` 必须 `npx.cmd`；必须关 `subscribeTo*ListChanges`（禁复活）
- 渐进披露三级：提示词服务级一行；`list_mcp_tools` 不列 schema；`search_tool` 返并揭露 schema
- `McpConfig.MCP` = `name/description/transport/conf/maxOutput`，工具名前缀已退役；工具名 = `mcp_` + 服务端原名（跨服务同名会被 `McpToolScope.adopt` 首个静默遮蔽）
- 服务描述由业务用户填（VARCHAR(200)），不取服务端 instructions
- 排查前先确认运行时挂的是框架 1.1.0

## git 与构建
- 分支 `feature/agent`；**备份 tag 禁删**（本地+远程）：`backup/remote-feature-agent-before-force`(f6b18bd)、`backup/remote-develop-before-force`(8546686)、`backup/remote-main-before-force`(ca7a423)
- 框架源码 `D:\code\starter\lingxi-harness-agent` **只读**
- 提交/推送需用户明确要求（不主动 commit、不跑 mvn install）
- `./mvnw` 已坏（缺 jar），Git Bash 下 `mvn` 会把 POSIX 路径喂给 Windows java。用 Launcher：
  `java -classpath 'D:\languages\mvn\boot\plexus-classworlds-2.11.0.jar' '-Dclassworlds.conf=D:\languages\mvn\bin\m2.conf' '-Dmaven.home=D:\languages\mvn' '-Dmaven.multiModuleProjectDirectory=D:\Code\LingXi' org.codehaus.plexus.classworlds.launcher.Launcher -o -DskipTests compile`
- 本地仓库 `D:/languages/mvn/repository`；**改 record 组件后必须跑 test-compile**
- 幽灵 blob：`git commit` 报 `invalid object` → `git hash-object -w <file>`
- email：两聚合 Email/EmailMessage；consume-batch 条件 UPDATE 按 affected 判定；@Builder PO 禁单列投影（会 IndexOutOfBounds）

## 未决 / 已知缺口
- 框架仓红测试 `harness-kernel-tools/SearchToolExecutorTest.noMatchCarriesHint` 未修（要补 hint 字段属产品决定）
- `LocalExecutionRepository.requireCancel` 不发事件 → 该轮 token 用量为 null
- `SessionMessageViewAssembler:58` AI 解析失败退回 `stored.getText()`（同类 JSON 泄漏隐患，仅解析异常时触发，未改）
- 起第二实例验证会被 `mcpManager` SSL 握手失败挡住（远端 MCP 连不上）→ 无法并行起验证实例；改代码后需重启 8088 才能端到端验证

## session_message.text 是「序列化 JSON 实体」，下发展示前必须解析（10-05 定案）
- `session_message.text` 存的是**序列化后的 JSON 实体**（`TranscriptRecordAssembler` 写入），不是纯文本。
  任何把它下发到展示层的路径都必须先反序列化，否则前端渲染出一坨 JSON。
- **统一用 `Message` 接口多态解析**：实体以 `type` 为判别字段（`@JsonTypeInfo(use=NAME, property="type")`），
  `objectMapper.readValue(stored, Message.class).text()` 一次覆盖 USER/AI/SYSTEM/TOOL。
  **不要按 `SessionMessageType` 分支各写一套** —— 曾经只处理 AI 行，USER 行原样下发 JSON。
- ⚠️ **解析不出必须返回 `null`，禁止 `return stored` 降级**：`stored` 是 JSON，退回等于把机器格式灌进展示层。
  正文缺失可接受，展示 JSON 不可接受。
- ⚠️ `UserMessageEntity.text()` 是**遍历 `content` 数组取 `TextContent`**，不是取顶层 `text` 字段
  （顶层 `text` 在多态 JSON 里是类型鉴别用途）。**别用 Python/JS 模拟这个行为** —— 会得出错误结论。
- `CommittedStateV3Observer.plainText` 是 v3 `MESSAGE_COMMITTED` 的唯一正文取值点。

## v3 提交环节会丢「活响应独有字段」（10-05 定案）
- `MESSAGE_COMMITTED` 载荷**只有 `text`/`type`/身份 id**，**不含 `thinking`**（`StreamV3Payloads.MessageCommitted`）。
- `streamV3Store.applyMessageCommitted` 一旦给活响应绑上 `messageId`，`projectSessionMessages` 的
  `live` 过滤（`slot.messageId == null`）就把它排除，改由 history 行承载 —— **所以活响应里独有的字段
  必须在提交时搬进 history 行**，否则提交那一刻整段消失（已实测：thinking 归零 → `thoughtSteps` 空）。
- 已修：AI 分支取 `current.thinking` 写进 `appendCommittedRow`。**加新字段（如 purpose）时同理。**
- 历史/bootstrap 路径不受影响（后端解析 `session_message.text` 的 JSON 实体时能取到 thinking）。

## 「正在探索中」的判据（10-05 定案）
- 全仓 `isExploring` 只在 `messageProjection.markExploring` 一处按**派生**设置：
  `assistant && !isComplete && !toolCalls.length && !content.trim()`。任一产出出现即退出。
- **不用 `session.runStatus`**：`SESSION_UPDATED` 是唯一更新它的帧，且**晚于** USER 提交
  （真实帧序 `… → MESSAGE_COMMITTED(USER) → … → RESPONSE_STARTED`），判据会漏掉整个窗口。
- **不补临时骨架**：骨架气泡 id 与派生气泡（`msg-live-{turnId}`）不同 → 双气泡闪烁。
  `markExploring` 已覆盖 RESPONSE_STARTED 之后全部时段，之前仅毫秒空窗，不值得换风险。

## 验证前端 v3 的正确姿势：真实帧重放，不要读代码推演（10-05 定案）
- **接口前缀无 `/api` 外层**：`vite.config.ts` 的代理清单里 `/a`、`/session`、`/config` 是**平级**前缀。
  真实端点：`GET /session/list?page&pageSize`、`GET /session/{rootId}/bootstrap`、
  `POST /a/completion/commands?commandId=`（multipart）、`GET /a/completion/{rootId}/events?schemaVersion=3`。
- **复现手法**：`npx.cmd tsx` 跑一个临时探针 → `setActivePinia(createPinia())` → 取真实 `useStreamV3Store()`
  → `applyFrame(rootId, <逐字复刻的真实帧>)` → 每帧 `projectSessionMessages(rootId)` 打印。
  **帧字段必须与抓包逐字一致**（USER 帧的 `streamKey` 顶层与 `data` 里**都是 null**；我一度填了值，
  导致 USER 提交污染了 AI 的响应槽，得出错误结论）。
- 抓帧脚本：`http.get` 订阅 SSE + 定时 `http.request` 发 multipart，按 `\n\n` 切帧、解析 `event:`/`data:`。
- ⚠️ 本会话两次"读代码推演"翻车（Python 模拟误报过度修复、探针字段写错误报竞态）。
  **涉及跨模块链路的判断，一律先跑真实数据再下结论。**

## 前端 v3 流式：状态源派生与连接代次（10-04 定案）
- 派生回答气泡用 `msg-live-{turnId}` 前缀 + 锚在本轮 USER 行后；AI 落库后自然归并，**禁**建第二份消息表
- bootstrap 同步判据必须是**连接身份**（READY 的 `readyConnectionId` → `bootstrappedConnectionId`），不是「成功过几次」；`bootstrapInFlight` 布尔**已不存在**，替代为 `inFlightGeneration: number | null`（按代次记，只防同代次重入）
- 换代次一律用 `beginResync`（换 token + 屏障 + 直接 bootstrapping），**禁**用 `beginSync`（会置 awaiting-ready 而 READY 已过 → 帧无限暂存）
- 重发作废走 `discardByInvalidation(turnIds, executionIds)`（范围化 + 幂等），**禁**用 `resetSession`（那是切会话语义，会抹掉新代际）
- 未决卡片对账 `reconcilePendingTools`：按**根会话树** + 快照未决集合，缺席即已决断；跨根不误删
- ✅ 门禁已并入 `npm test`：18 个 tsx 文件 134 条 + cjs 4 条（`streamV3SwitchAudit` 7 + `streamV3FixProbe` 19 + 4 个 probe 共 38 条边界）
- ⚠️ 写文件禁用 `cat >> file <<EOF`：本机 Git Bash 会把内容插到文件开头并按 GBK 写坏，追加中文前先确认工具写入方式（用 Edit 工具或 Python）
- ⚠️ 前端 `vite build` 走 `npx.cmd vite build` 可能 SIGTERM/挂死（卡 minify）→ 后台跑 + `--minify false`；`node node_modules/vite/bin/vite.js build` 更稳
- ⚠️ **tsx 有缓存（`%TEMP%\tsx-summit`），缓存键不含文件内容**：改完文件单跑可能命中旧结果（假绿/假红），且 mtime 不更新。两种表现：①报旧结果；②esbuild transform 失败被挂到**文件名**上（`not ok 13`），伪装成断言失败。
  - **判别方法**：单跑出现「同一份代码两个结果」时，**先打印调用栈行号 + `stat` mtime**，再下结论。行号不可能被缓存记住，行号变了 = 文件被改过，不是竞态。否则很容易把「人为改动」误报成「实现有竞态」。
  - **门禁健康度**：只能**合并跑全量文件列表**判定（带完整 `--test` 列表，不只跑改动的那几个）。tsx 缓存按文件粒度，单文件绿不保证与它文件同跑时绿（全局 pinia、模块级 `baseCache` 这类跨文件共享状态会互相影响）。
- 持久化：PO+BaseMapper+RepositoryImpl(Lambda Wrapper)，禁 JDBC；新 PO 登记 `InitSqlPoConsistencyTest.PO_CLASSES`；新模块先 DddCodeGenerator；雪花 id 用 IdUtil；禁 var；方法体禁全类名；仓储接口 RepositoryTemplate / 实现 AbstractRepository
- 禁引用：auth/UserContext/interaction 全族/Redis/JJWT/Kafka
- 前端铁律：`node node_modules/vue-tsc/bin/vue-tsc.js -b --force`（零输出）+ `vite build`；SUCCESS_CODES=[1]；工具名一律走 `utils/toolNames.ts` 的 `AgentToolName`（`as const`，禁 enum）

## 实时通道帧事实（10-05 抓包坐实）
- 🔴 **实时通道不发 `TOOL_CALL_UPDATED` 帧**：一轮实测 `MESSAGE_COMMITTED 6` / `THINKING_DELTA 143` / **`TOOL_CALL_UPDATED 0`**。工具事实**只存在于落库行**
- 推论：任何「工具痕迹」都**必须在 `MESSAGE_COMMITTED` 落行时带上**，不能指望独立工具帧
- `MESSAGE_COMMITTED` 载荷已补 `thinking` + `List<ModelToolCallVO> toolCalls`（后端 `CommittedStateV3Observer.resolveContent` 用 Jackson 多态解析落库 JSON 实体）
- ⚠️ 落库 JSON 解析出的 `AiMessageEntity` 是 **Lombok `@Getter` class 不是 record** → 取值 `ai.getThinking()` / `ai.getToolCalls()`，不是 `ai.thinking()`
- 前端接收侧**优先取载荷、活响应槽兜底**（兼容未升级后端）

## 思考步骤聚合（10-05 定案）
- 同一轮次 thinking **合并成一个**「深度思考」step（`step-${sid}-${normalizeTurnId(turnId)}`），内容按行序 `\n\n` 拼接，order 取首段位置
- 原因：每条 AI 行各建一个 step 时，一轮实测 **10 个同名下拉框**（模型「思考→调工具→再思考」多轮）
- **取舍**：牺牲「思考与工具逐段交错」，换可读性（用户明确要求）。`crossPageTurn.test.ts` 测试 9 契约 = 1 个合并步骤
- ⚠️ 「终结轮次」规则：只有**该轮无工具调用**的 AI 行文本才是正文；有工具调用的行文本进 `aiMessages`（`content=""` 是正确行为）

## 本机执行环境坑（10-05）
- ⚠️ **`npm test` 被安全策略拦**（走 `wsl.exe`，Program Blacklist）→ 改用 `npx.cmd tsx --test <完整文件列表>` + `node --test tests/filePreview.native.test.cjs`
- ⚠️ 探针运行用 `npx.cmd tsx tests/xxx.ts`（`node node_modules/tsx/dist/cli.mjs` 路径不存在）
- ⚠️ `powershell -Command "..."` 从 Bash 调被拦；PowerShell 工具在本环境**不回 stdout** → 查进程信息用 `jps -lv`
- ⚠️ `cmd //c "..."` 在 Git Bash 下会开交互 shell 不执行 → 别用

## 执行状态谓词：两个判据必须分开（10-05 第三轮 QA 定案，**勿再合并**）
- `resolveExecutionTerminal` = COMPLETED/FAILED/CANCELLED ——「**执行收尾**了没」，只给终态对账 watch 用（挂起还会恢复，对账是白花查询）
- `resolveResponseClosed` = 三终态 + **SUSPENDED** ——「**这段响应还能不能收增量**」，给 `finalizeByExecution` 用（§8.1 路径 2）
- 🔴 **依据是 `docs/stream-protocol-v3-design.md` §8.1**：execution 的终态**或 SUSPENDED**，实时与 bootstrap 二者等价，都定格响应；路径 4 要求定格后迟到 STARTED/DELTA 不得复活
- 🔴 后端 `ExecutionStatusCodes.TERMINAL_THRESHOLD = COMPLETED(3)` 只说明「SUSPENDED 不是执行终态」，**推不出**「挂起不定格响应」—— 曾经据此删掉 SUSPENDED 并改旧测试迎合，是双重错误
- 谓词命名出现 Terminal/Closed/Finished 混用时：**先问它答的是哪个问题**，再定集合；测试与新判断冲突时先查设计文档谁是权威
- 实体只有新旧没有代际：`SESSION_UPDATED`/`TURN_UPDATED` 的**信封 `historyRevision` 是实体自身字段**（`Session.historyRevision` 默认 1L，子会话不继承根代际），**不得**拿它比根代际 —— 否则根 revision=2 时新建子会话(revision=1)的合法更新被误丢，子面板/卡片冒泡全失灵。代际判据只对「信封 revision 真表示根代际」的帧生效；身份判据(turnId/executionId)对所有帧保留
- 🔴 「切回同一根会重放一次对账」是**当前已知语义**（身份串由空变回 `根:集合`），属恢复显示、不是新执行收尾；用例必须用**精确次数**断言，禁用 `>=` 之类宽松不等式冒充「不重复」
