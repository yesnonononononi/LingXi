# LingXi 项目长期记忆

> 只记 **AGENTS.md 之外**、读代码推不出来的。规范/命名/DDD 分层已在 `AGENTS.md`，不重复。
> 分支 `feature/agent`。事件渲染系统（streamV3/v2）**已整体物理删除，别去仓库找**。

## 前端：配置与结构

- 🔴 配置唯一真源 `stores/userConfigStore.ts`：组件/composable **一律不直调 `UserConfigAPI`**。
  - `patch` 的 key 是 **store 字段名**（`envType`），不是后端字段名（`type`）→ 用 `PatchableField` 联合 + `readField/writeField` 两个 switch，**别用 `const fields={…}` 对象记录法**（TS2322）。
  - `reasoningEffort` 在 `patch` 内转交 `setReasoningEffort`（有「连续拖动串行合并」语义）。
  - 禁 `as` 解析枚举 → 一律 `utils/enum.ts` 的 `normalize*Enum(raw, fallback)`。
  - `load()` 是幂等初始化唯一入口。
  - 后端 `agentId` 曾漏落库（`UserConfigServiceImpl.update()` 未调 `changeAgent`）：修法三层留痕 `@JsonSetter` → `agentIdPresent` record 分量 → Service 判存在性（显式 null=解绑、不传=保持，光判值会把解绑当没传）。
- 🔴 `ChatView.vue` 是路由首页（`path:'/'`），无父层 → **无 props/emits，别往上加**。
- 🔴 `ChatView.vue` 解构消费的键 = `useChatView` 返回键，**必须一个不差**；模板引用的函数必须在返回对象里真实存在（幽灵函数 Vite 不报、`vue-tsc` 才炸）。
- 🔴 删 UI 时顺带 grep 同名数据变量（曾漏 `activeBranchIdx`/`totalBranches`，隔轮被 TS6133 报出）。
- 🔴 TDZ：`useChatSending` 依赖 `displayedMessages`，该 computed 必须提前定义。
- 🔴 `isPersistedSessionId`（`/^\d+$/`）≠ `!isTempSessionId`（仅排除 `temp-`）。
- 消息渲染：思考步骤按轮次聚合（`step-${sid}-${normalizeTurnId}`，内容按行序 `\n\n`）；只有**该轮无工具调用**的 AI 行文本是正文。

## 前端：流式链路

`services/sse.ts`（切块+解析）+ `services/agent.ts`（发请求）+ `views/chat/useChatSending.ts`（编排）。

- 🔴 走**原生 fetch 不用 axios**（要 `response.body` 的 ReadableStream），且**不手写 Content-Type**（boundary 由浏览器生成）。
- 🔴 abort 必须 `signal.addEventListener('abort', () => reader.cancel())`（响应头已返回后 abort 不会让 fetch reject）。
- 🔴 **前端 abort ≠ 停后端**：还需 `POST /a/completion/{sid}/stop`。`activeStreamCount` = 「请求在途计数」。
- 重发链路前端已整体删除（后端 `/a/completion/resend` 端点仍在、无调用方）。

## 后端：接口与语义

- 端点前缀**无 `/api`**（`/a`、`/session`、`/config` 平级）。`SseEventPublisher` 按根会话归档。
- wire 事件名 = `RuntimeEventType` 常量名；execution 状态 0-5 见 `ExecutionStatusCodes`（终态 ≥3）。
- 🔴 `session_message.text` 存**序列化 JSON 实体**，下发展示层必须 `objectMapper.readValue(stored, Message.class).text()`；解析不出返 `null`，**禁 `return stored` 降级**。
  - `UserMessageEntity.text()` 遍历 `content` 数组取 `TextContent`（不是顶层 `text`）→ 别用 Python/JS 模拟验证。
- 🔴 **子会话挂起语义（勿当 bug 修）**：委派在子执行挂起点定稿、根会话立即收尾不等待、审批恢复带外续跑、**子会话结果不回流根会话**。
- 🔴 **「执行终结时关 SSE 流」必须排在终态事件广播之后**（落点 `AgentEventListener.finishExecution`：先 publish 再 disconnectRoot，且只认 `sessionId == rootSessionId`）；否则终态事件推进已关闭的空桶、静默丢弃。
- 🔴 **轮次终态只能由「执行行落终态并提交」驱动，业务 catch 里排序无效**：框架 `ChatAgent.execute(Execution)` 在 rethrow 之前就 `executionControl.fail(execution, e).run()`（:106），而 `DefaultExecutionController.fail` 是**先 `save` 再返回发布任务**（:84-95）。初始化失败要在事件之前收口轮次，唯一合法落点是 `LocalExecutionRepository.save` 里补第三个广播点：**首次落 FAILED 且 `active` 无控制槽位 → `afterCommit(notifyFinished)`**（活跃循环仍走 `unregister`，两者互斥）。且 SUSPENDED / 其他终态**既不 fail 也不写轮次** —— 轮次状态只由 `ChatTurnLifecycleListener` 依执行状态推导，业务侧不得再手工 `markTerminal`。
- 🔴 **四个执行入口共用一个受理点** `ChatServiceImpl#commitUserMessage`（`chat`/`chatStream`/`acceptCommand`/`resend` 全经它，后者经 `commitAndSubmit`+`submitAsync`）；改受理流程只改这一处。
- 🔴 `SseEventPublisher` 同一 root 桶内**可并存多条 emitter**：请求级流与会话级流同键会**双投**（正文增量→双写），二者必须互斥。
- 会话级流订阅条件：`已落库 && runStatus==='SUSPENDED' && activeStreamCount===0`；前端乐观写 `runStatus` 后失败不回滚会让它永久不成立。
- 框架 `SseEmitter` 从不 `.id(...)`、也不读 `Last-Event-ID` ⇒ **当前没有回放能力**；`heartbeat()` 发的是注释行，浏览器侧不可观测。

## 数据与持久化

- 纯 H2 `jdbc:h2:file:./data/lingxi;MODE=MySQL`，`init.sql` 唯一 DDL 真源，业务 SQL 一律 MySQL 方言。⚠️ 加列/改类型不自动升级存量库（缺表才整库重建，数据丢）。
- 新 PO 要登记 `InitSqlPoConsistencyTest.PO_CLASSES`；雪花 id 用 IdUtil。禁引用：auth/UserContext/interaction 全族/Redis/JJWT/Kafka。
- ⚠️ **`SessionMessagePO` 是唯一没有 `@TableField` 的 PO**（`ChatTurnPO` 16 个、`ExecutionPO` 8 个都有），它靠 MyBatis-Plus 的驼峰转下划线开关做列名映射。因此**写 H2 集成测试时不要照抄既有测试的 `setMapUnderscoreToCamelCase(false)`** —— 会让 `session_message` 的 INSERT 用上 `sessionId/turnId/createTime` 这类驼峰列名，直接报 `Column "SESSIONID" not found`。
- MCP：Windows stdio `command` 必须 `npx.cmd`；必须关 `subscribeTo*ListChanges`。工具名 = `mcp_` + 服务端原名（动态集合，不入 `AgentToolName`）。
- execution 表**禁存业务事实**；模型与 token 权威在 `chat_turn`。
- 🔴 **框架 `LocalExecutionRepository.save` 只在「状态 CREATED 且行不存在」时 insert，其余走条件 update**；`findById` 对 `snapshot IS NULL` 的行返回空 ⇒ 往 execution 表写行必须写**完整 snapshot**，否则恢复路径读不到。

## 构建 / 环境

- 备份 tag 禁删（4 个：`backup/remote-feature-agent-before-force` 等）。框架源码 `D:\code\starter\lingxi-harness-agent` **只读**。提交/推送需用户明确要求。
- `./mvnw` 已坏（缺 jar），用 Launcher：
  `java -classpath 'D:\languages\mvn\boot\plexus-classworlds-2.11.0.jar' '-Dclassworlds.conf=D:\languages\mvn\bin\m2.conf' '-Dmaven.home=D:\languages\mvn' '-Dmaven.multiModuleProjectDirectory=D:\Code\LingXi' org.codehaus.plexus.classworlds.launcher.Launcher -o -DskipTests compile`
- 🔴 本地仓库真源 = `D:/languages/mvn/repository`（settings.xml:7）；**`~/.m2/repository` 是另一份陈旧副本**，核对「框架改动是否生效」必须看前者。
- 前端门禁：`node node_modules/vue-tsc/bin/vue-tsc.js -b --force`（EXIT=0）+ `node --test tests/*.cjs`；`vite build` 有时挂死 → **vue-tsc 过了就别死等 build**。
- 本机坑：`npm test`/`npx` 被安全策略拦（用缓存 tsx）；`powershell -Command` 从 Bash 调被拦、PowerShell 工具不回 stdout（查进程用 `jps -lv`）；`cmd //c` 在 Git Bash 下不执行；`timeout` 撞 Windows `TIMEOUT.EXE`；`/tmp`→`D:\tmp` 重定向常静默失败（写项目内相对路径）；禁 `cat >> file <<EOF`（GBK 写坏）；JSDoc `<pre>` 里禁块注释 `/* */`。
- 🔴 **涉及跨模块链路的判断先跑真实数据**：仅靠「读代码推演」得出的结论已多次被实测推翻。⚠️ tsx 缓存键不含文件内容，单跑可能命中旧结果。
- 起第二后端实例会被 `mcpManager` SSL 握手挡住 → 改后端代码需重启 8088 才能端到端验证。

## 未决 / 已知缺口

- 框架仓红测试 `harness-kernel-tools/SearchToolExecutorTest.noMatchCarriesHint` 未修（补 hint 属产品决定）。
- `LocalExecutionRepository.requireCancel` 不发事件 → 该轮 token 用量为 null。
- `SessionMessageViewAssembler:58` AI 解析失败退回 `stored.getText()`（未改）。
- `ExecutionRegistrationService`（登记服务）**已消除**（2026-10-07 00:05 施工完毕，**未提交**）：受理事务改为在 `PreparedChatExecutor#admit` 内由框架创建**完整 Execution**（带 snapshot）；接口/实现、`markFailedIfUnfinished` 三层（Mapper/RepoImpl/domain）、`ExecutionStartupFailureClosureTest` 一并删除。设计文档 v2 见 `deliverables/execution-registration/eliminate-execution-registration-service-2026-10-06.md`（含实施记录与两处非显然约束）。
