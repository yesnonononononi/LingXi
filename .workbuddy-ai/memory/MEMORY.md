# LingXi 项目长期笔记

## 代码库坐标
- 业务应用：`D:/Code/LingXi`（Java 21 / Spring Boot 3.5.6 / MyBatis-Plus 3.5.9，DDD 分层）
- **框架（harness）**：`D:/code/starter/lingxi-harness-agent`。当前 **7 个模块**（以根 pom `<modules>` 为准）：`harness-core` / `harness-adapter-langchain4j` / `harness-runtime` / `harness-kernel-tools` / `harness-spring-boot-autoconfigure` / `lingxi-harness-spring-boot-starter` / `harness-sandbox-docker`。
  - ⚠️ 用户口述的 `D:\code\starter\lingxi-harness-starter` **不存在**，勿再按该路径查找。
  - ⚠️ `harness-memory` 已不在模块列表里（本地仓库还留着它的旧制品）；别再按「8 模块」的记忆找它。
- **模块依赖方向**：`harness-core` ← `harness-runtime` ← `harness-kernel-tools`；`harness-spring-boot-autoconfigure` **不**依赖 kernel-tools（否则成环）；由 `lingxi-harness-spring-boot-starter` 同时依赖两者做聚合。所以 kernel-tools 里的 `@AutoConfiguration` **不能**写 `after = CommonToolAutoConfiguration.class`（会引入对 autoconfigure 的编译依赖）——需要顺序时用 `afterName` 字符串形式。

## 框架内核工具 harness-kernel-tools（2026-09-29 新增）
- 承载框架自带的两个工具：`compact_context`（`ContextCompactToolAutoConfiguration` + `ContextCompactToolProperties`）与 `search_tool`（`SearchToolAutoConfiguration` + `SearchToolProperties` + `SearchToolExecutor`）。包名 `com.summit.kernel.tools.{compact,search}`。
- 两者都 `@ConditionalOnProperty(..., matchIfMissing = true)` + `@ConditionalOnMissingBean(name = "...Definition")`：**默认开启**（字段默认值也是 true，此前 compact 的条件与字段默认值不一致，导致不写 key 就没法压缩），且应用可声明同名 bean 顶替实现。
- 工具名常量唯一来源是 `SearchToolExecutor.NAME`，应用的 `ToolCatalog.SEARCH_TOOL` 转发它。
- **多段压缩阈值也归这里**（2026-09-29 二次定案）：`lingxi.agent.runtime.tool.context-compact.{truncate-threshold:0.7, model-threshold:0.85, truncate-rounds:5}`。原键 `lingxi.agent.model.conf.chat.{truncate-squeeze-threshold, model-squeeze-threshold, expect-truncate-turn}` **已删除**（改键名是破坏性变更）；原 `ContextCompactToolProperties.threshold` 是与 `model-squeeze-threshold` 重复的死配置，已并入 `model-threshold`。
- 装配方式：kernel-tools 声明 `AgentConfig.ProgressiveSqueezePolicy` bean（**不受 `enabled` 条件约束**——两档 squeeze 是 loop 行为，与模型有没有拿到 `compact_context` 工具无关），`AgentConfiguration.agentConfig` 用 `ObjectProvider<AgentConfig.ProgressiveSqueezePolicy>` 消费它。这样 autoconfigure 不需要依赖 kernel-tools（否则成环），缺这个模块时 policy 为 null，`BoundaryChecker` 回落自己的默认档。


## 配置策略（2026-09-29 定案，改动前必读）
- **系统提示词唯一真相源是 `AgentRequest.systemPrompt`**。框架**不读任何 yaml 提示词**：`AgentChatProperties.systemPrompt`、`AgentConfig.systemPrompt`（本来就是死字段，零读取方）、`PromptAssembler.withSystemPrompt`、`SystemPromptAssembler` 的 `## System Prompt` 段与占位符填充全部删除。业务侧自行定义（应用在 `lingxi.system-prompt` 里写人设，由 `RequestPreparer.mergeSystemPrompt` 拼进 `AgentRequest.systemPrompt`）。
- **业务侧工具不再有 yaml `enabled` 开关**。已删除 `EditFileProperties` / `ReadFileProperties` / `TerminalToolProperties`，`WebSearchToolProperties` 只留 baseUrl/apiKey/maxResult；`FileToolConfiguration`、`CommonToolConfiguration` 里的 `@ConditionalOnProperty(enabled)` 全去掉。要停用某工具，从 Agent 的工具清单里去掉（框架侧名单即授权）。
- **`lingxi.agent.runtime.tool.common.*`（max-output / requireAsync）从来没有任何绑定**，属死配置，已从 yaml 删除。
- 新增三个可配置项（原来都是硬编码常量）：
  - `lingxi.agent.model.conf.chat.max-consecutive-compactions`（默认 3）→ `AgentChatProperties` → `AgentConfig` → `RuntimeContext.maxConsecutiveCompactions`（可空，`AgentLoopStepRunner` 回落 `AgentConfig.DEFAULT_MAX_CONSECUTIVE_COMPACTIONS`）。原常量是 `AgentLoopStepRunner.MAX_CONSECUTIVE_COMPACTIONS`，管的是 `compact_context` 工具触发的连续压缩轮次。
  - `lingxi.agent.runtime.tool.search-tool.{max-matches,timeout}`（默认 30 / 10s）→ `SearchToolProperties`。`max-matches` 传进 `SearchToolExecutor`；`timeout` 是 `Duration`，**亚秒值会被收敛到 1 秒**（工具运行时把 `timeout <= 0` 读作「不设超时」，与意图相反）。
  - `lingxi.agent.model.conf.chat.usage-report-interval`（默认 5）→ `ContextUsageReporter` 的第 4 个构造参数（原来硬编码 `REPORT_THRESHOLD = 5`）；传 ≤0 会收敛到 1（每轮上报），避免静默。
- **阈值统一收在 `context-compact` 命名空间下**（见「框架内核工具」一节）。`AgentChatProperties` 不再有 squeeze 字段，`AgentConfig.squeezeThreshold` 由 kernel-tools 的 bean 提供。



## 框架挂起/恢复模型（改动前必读）
- 挂起原语只有 `ToolExecuteResult.promise()`；runner 提交整批工具结果后返回 `LoopResult.SUSPENDED`。协作式、不阻塞线程、无内存决策队列、无可恢复程序计数器。
- 框架 ADR `harness-core/docs/adr/loop-suspension-boundary.md`：**PROMISE 只表达 loop 控制，不代表提问/审批/人工输入**；框架故意不提供「列待决问题 / 批准命令 / 设业务超时 / 把响应转成用户消息」。
- 关键 SPI：`ExecutionControl`(cancel/suspend/resume) + `ActiveExecutionRegistry`(register/unregister/requireSuspend/requireCancel) + `ExecutionControlSignal`(NONE/REQUIRE_SUSPEND/REQUIRE_CANCEL) + `ExecutionRepository extends ActiveExecutionRegistry`。
- `RuntimeLifeStyleManager`(onStart/onSuspend/onCancel/onComplete/onError/onResume) 与 `RuntimeListener` 均为 `@ConditionalOnMissingBean` → 业务可顶替，**框架零改动**即可承载业务挂起编排。
- 陷阱：框架 `finally` 用 `List.copyOf` 冻结 `execution.messages`（恢复必须自建可变副本）；`resume(String)` 是仓储副本（禁用），必须用 `resume(Execution)`。

## 框架扩展点速查
- 规模：~40 个 SPI、19 个 `@ConditionalOnMissingBean` 覆盖点、8 个 `List<T>` 集合型收集点。
- **MCP 是唯一开箱即用的扩展**（`McpProvider` SPI + `McpToolRegistrar` 启动发现 + `lingxi.mcp.*`；仅 streamable-http）。
- **Skill / 协作编排 无预留**；**multi-agent 通信 / memory 有缝未接**（`harness-memory` 模块在根 pom 中但 0 个类）。
- 应用注册工具的方式：声明 `ToolDefinition<? extends ToolExecutor>` bean，`CommonToolAutoConfiguration.toolRegistry(List<...>)` 自动收集。策略 `List<ToolExecutionPolicy>`、拦截器 `List<ToolInterceptor>`、监听 `List<RuntimeListener>` 同理。
- ⚠️ 装配陷阱：`@ConditionalOnMissingBean` 在默认 bean 创建前求值，应用 bean **不可把默认实现作为注入依赖**，必须在 `@Bean` 方法内部 `new`。
- `ArchitectureBoundaryTest` 每次构建扫描框架生产源码，禁止 `com.summit.dp.` 等业务标识 → 业务编排不可下沉框架。

## 框架分布式能力（结论）
- **不原生支持多节点**：无状态计算内核（✅ 可水平扩展）+ 进程内状态（控制信号/事件/准入/后台任务）+ 可替换接缝。
- ✅ 计算无状态：`AgentRequest.messages` 自带全量上下文，runtime 从不按 id 加载历史。
- ⚠️ 跨节点 resume：条件成立，需应用提供共享 `ExecutionRepository`。
- ❌ 跨节点 suspend/cancel（`ExecutionControlSignal` 进程内 volatile）、跨节点事件（`RuntimeEventPublisher` 进程内扇出）、工作区跨节点、后台任务多节点。
- 依赖面：无 Redis/JDBC/Kafka/Web/ShedLock/heartbeat/fencing；框架是**纯库无 HTTP 层**；分布式开关被 `ConfigurationMetadataTest.java:23` 断言锁死为"不存在"。
- **正面事实**：生产代码零 `static` 可变字段、零 `ThreadLocal` → 无隐藏全局状态。
- 改造原则：新增接缝（`ControlSignalChannel`/`EventTransport`/`ExecutionClaimStore`/`DistributedLock`/`LeaderElector`）**默认实现保持单机行为**，多节点由应用注入。
- ⚠️ steering（跨节点 suspend/cancel）与 admission（防重复执行）是**两个不同原语**，别只做前者。

## 框架已知缺口
- `harness-memory` 模块**零个类**却已签名发布（空头承诺）；`ArchitectureBoundaryTest.java:74-77` 因"无 src 跳过"漏检。
- `ExecutionRepository extends ActiveExecutionRegistry` 混合「进程内信号路由」与「共享快照存储」——三方独立建议拆分。
- 终态 `RuntimeProcessorTemplate.java:81` 用 `List.copyOf` 冻结 messages，业务直接改会抛异常（未文档化）。

## SSE 推送语义（2026-09-29 定案，改 SseEventPublisher 前必读）
- **终态事件先于收尾用量推送**：`RuntimeProcessorTemplate` 先调 `onComplete`/`onCancel`/`onError`（→ 前端收到终态即关流），**之后**才在 `finally` 的 `clear()` 里 `usage.publish(execution)`。因此「最后那条用量推送写到已断开的流上」是**每轮都会发生**的正常现象。
- ⚠️ **`AsyncRequestNotUsableException` 继承 `IOException`**（Spring 6），`ClientAbortException` 也是。所以 `catch (IOException)` 会把「客户端已断开」当成服务端故障 —— 曾经每轮刷一条 WARN + 完整堆栈（"Failed to send SSE event"）。**别用 WARN + 堆栈记录写失败**：SSE 是尽力而为的通道，会话状态另有快照兜底。
- 现行做法：`SseEventPublisher.send` 写失败 → DEBUG（只打最内层 cause 的类名+消息）+ **把该 emitter 从注册表摘掉**（客户端断开后容器未必立刻回调 `onError`，留着只会每轮重复失败）。`publish` 遍历的是 `CopyOnWriteArraySet`，边遍历边摘除是安全的。
- **推送失败与 MCP 无关**：`McpToolScope.close()` 不经过 SSE 通道，堆栈里也不会有 MCP 帧。遇到 SSE 报错先按上面两条判断，别往 MCP 上猜。

## SSE 模型（2026-09-29 定案，改动前必读）
- **流是会话级的，入口曾经只有请求级的**：原先只有 `chatStream` / 命令审批 / tool-call 决策三处建流，且 `chatStream` 在执行结束时主动 `emitter.complete()`；`useChatView.ts` 还在**切换会话时主动 `abort()`**（第 686-689 行）与卸载时 abort（第 1324-1326 行）。所以「切走再切回」不是流断了，是设计上就把它杀掉了。
- ⚠️ **`ChatServiceImpl.resume` 不建流**：只恢复执行并返回消息，恢复后整轮事件没有任何订阅者。任何新增的「触发执行」入口都要问一句：这条执行的事件谁在听？
- **会话级订阅入口**：`GET /a/completion/{sessionId}/events`（`ChatController.subscribe` → `ChatService.subscribeSession`）。只订阅、不执行、可重复调用；sessionId 按 `ExecutionIdentity.rootSessionIdOfSession` 归到根会话，与推送路由同口径（**用子会话 ID 建流会挂到另一个桶，连上却收不到事件**）。
- **服务端不做回放、不发 gap**（2026-09-29 二次定案，此前实现过序号+回放+缺口告警，已删除）：实时通道只投递「此刻之后」的事件，无人订阅即丢弃；**切走期间的缺口由前端回查会话历史对齐**。实时通道与历史接口各管一段，不重复承担一致性——这是刻意的职责划分，别再往 SSE 通道里加序号/日志/回放。
- ⚠️ **写失败不是告警**：终态事件先于 `RuntimeProcessorTemplate#clear` 的收尾用量推送发出，前端看到终态就关流，所以「最后那条用量推送写不出去」每轮都会发生。且 **`AsyncRequestNotUsableException` 继承 `IOException`**，`catch (IOException)` 会把它当故障打成 WARN+堆栈。现行做法：DEBUG（只打最内层 cause 类名+消息）+ 摘掉该 emitter（容器未必立刻回调 `onError`，留着只会每轮重试）。
- **推送失败与 MCP 无关**：`McpToolScope.close()` 不经过 SSE 通道，堆栈里也不会有 MCP 帧。遇到 SSE 报错先按上面判断，别往 MCP 上猜。

## 前端 SSE 路由管理中心（2026-09-29 新增）
- `frontend/src/stores/sseRouter.ts`（pinia，已装 `pinia` 并在 `main.ts` 注册）。**连接归属从组件收上来，按根会话保管**：组件订阅/退订只影响「谁在听」，不影响「流在不在」；切走再切回是重新订阅，不是重新建流。
- **职责边界**：只做建/复用/关连接 + 按会话分发事件 + 暴露状态；**不解释事件语义、不缓存、不回放**。重新订阅时若连接早已在跑且已投递过事件，会回调 `onReattached`，提示消费方回查历史。
- 关键设计：**订阅表与连接表分开**（连接断了不丢订阅）；键一律是**根会话 ID**；`openStream` 对同会话复用连接（两条流会让每个事件投递两遍）；`finish` 只摘自己那条连接（旧连接迟到的结束回调不能误删新连接）；`AbortController`/订阅者集合刻意不放 reactive，只有状态用 `statuses` 暴露。
- `utils/sse.ts` 的 `readSseResponse` 新增 `stopOnTerminal`（缺省 `true`）：**会话级订阅必须传 `false`**，否则第一次执行结束就静默失效，表现又是「切回来收不到更新」。
- ⚠️ **尚未迁移**：`useChatView.ts`（1424 行）仍在自己持有 `AbortController` 并在切会话/卸载时 abort，`chatStreamService.sendMessageStream`（1045 行）仍自己建流并内联解释事件。迁移点是：发送路径（615-660）、切会话 abort（686-689）、卸载 abort（1324-1326）。前端无测试框架（package.json 只有 dev/build/preview），改动只能靠 `npm run build`（含 `vue-tsc -b`）兜类型。



## 框架仓库操作须知
- 分支 `develop`；构建：`export TMPDIR="D:/Code/LingXi/.run/tmp" && ./mvnw -o -q -DskipTests compile`（离线可构建，~53s）；测试 `./mvnw -o test -Dmaven.test.failure.ignore=true`。
- ⚠️ **Maven 本地仓库在 `D:/languages/mvn/repository`**（`~/.m2/settings.xml` 里 `<localRepository>` 指定的），不是 `~/.m2/repository`。查制品/判断 install 是否生效要看前者。
- ⚠️ **install 必须加两个 skip**：`./mvnw -o -DskipTests -Dgpg.skip=true -Dmaven.javadoc.skip=true install`。根 pom 面向 Central 发布，把 `maven-gpg-plugin:sign` 和 `maven-javadoc-plugin:jar` 都绑在 `verify` 阶段，而 `install` 会先跑 `verify` → 不加 skip 会分别报 GPG 签名失败、以及 starter 模块「No public or protected classes found to document」。**不加 skip 的 install 会长时间卡住/失败，别以为是在下载依赖。**
- 应用侧（`D:/Code/LingXi`）要吃到框架改动，**必须先在框架仓库 install**；否则应用编译用的是旧 jar。应用侧验证：`./mvnw -o -DskipTests compile` / `./mvnw -o test -Dmaven.test.failure.ignore=true`。
- 全量测试（框架）**101 通过 / 0 失败**（2026-09-29 起，7 个模块）；应用侧 **188 通过 / 0 失败**。
- ⚠️ **单模块测试必须带 `-am`**：`./mvnw -o test -pl <module>`（无 `-am`）会从本地仓库取**旧版依赖模块**，测试编译看到的仍是旧 API，症状酷似「改动被回滚」。跨模块改动要么 `-am`，要么跑全量 reactor。
- 关键提交：`0b7d6b6`（loop 收敛基线 + 移除 harness-example）、`3d43a5f`（冗余与职责边界收敛保守档）。
- `.tmp-build/`、`.workbuddy/` 已在 `.gitignore`。
- 本地仓库里 `harness-base-tools` / `harness-memory` / `harness-example` 目录是**已删除模块的遗留制品**，当前源码树没有这些模块，别据此推断结构。

## 工程教训（本项目已实际踩过，务必遵守）
1. **写「守卫/断言类」测试后，必须模拟目标环境（`git archive HEAD` 导出到临时目录、或 `git worktree`）再跑一遍**。开发机上跑通过不代表 CI 通过 —— **git 不跟踪空目录**，任何依赖「空目录存在」的判据在 fresh clone 下都会翻转。已实际踩雷：`ArchitectureBoundaryTest.everyDeclaredModuleHasProductionSources` 因依赖 `lingxi-harness-spring-boot-starter/src/main/java`（未被跟踪的空目录）而本机通过、CI 必红。
2. **同批同模式的改动必须全部检查，不能抽查一处通过就放过整批**。已实际漏检：只查了 `AgentRequest.task` 的 javadoc，漏掉 `TypedEvent` 同类的失实表述。
3. **改并发代码时，「移除锁条目」类直觉方案要先想清楚竞态**。`destroy` 时删锁会让「已拿到旧锁对象并阻塞等待」的线程与新线程创建的新锁对象并发进入同一临界区。正确做法是固定条带锁。
4. **独立评审需要证据共享**：纯 clean-slate 评审在证据缺失处会给出过于宽容的判断（已实际发生）。
5. **提交信息里的验证声明必须是干净环境的结果**，脏工作树上的数字写进 commit message 等于失实。

## 项目约定补充
- 三条人工在环链路：命令审批（`CommandPolicyConfig`，policy 短路）/ plan（`CreatePlanTool`）/ choice（`RequireChoiceToolExecutor`）。
- 重构进行中：`tool_call` 表 + `ToolCall` 充血模型 + `ToolCallRegistrar` 替换 `interaction_status`；旧链路在 `interaction/application/service/impl/deprecated/`。
- 编译验证命令：`export TMPDIR="D:/Code/LingXi/.run/tmp" && ./mvnw.cmd -q -o compile -DskipTests`（离线依赖可命中本地 `~/.m2`）。

## Agent 邮箱语义（2026-09-28 定案，改动前必读）
- `email` 表 = **一次协作轮次里、一个收件 Agent 的角色邮箱**，不是一封消息，也不是某个执行实例的邮箱。业务键 `(workflow_execution_id, recipient_agent_id)`，DB 有唯一索引 `uk_email_workflow_recipient`。
- `workflow_execution_id` 恒为**协作根执行 ID**：根执行取自身 ID，子执行继承根执行 ID（`CallSubAgentTool.buildRequest` 写入 `ROOT_EXECUTION_ID` 属性）。仅用于隔离不同协作轮次。`target_execution_id` 已删除；`team_id` 只是创建时快照，不参与路由。
- 统一解析入口：`ExecutionAttributes.readLong(attrs, key)` / `ExecutionAttributes.workflowExecutionId(attrs, currentExecutionId)`（根执行没有 ROOT_EXECUTION_ID 属性时回落自身 executionId）。**发信侧与消费侧必须用同一函数**，否则业务键对不上。
- 角色邮箱 ⇒ 同轮次两个同名 Agent 执行会**竞争消费**，单条消息只交给其中一个，接收实例不保证固定。若要指定某个子执行，必须另设计显式 `recipient_execution_id` 消息路由，**不能塞进角色邮箱的查询条件**。
- 客户端不得写路由字段：`/email/add`、`/email/update` 已删除，`EmailCommand`/`EmailRequest` 已删除；投递只走 `EmailService.sendMail(toAgentId, content, MailSendContext)`。
- 并发首次建箱：`EmailServiceImpl.obtainMailbox` = 查 → 插 → 捕 `DuplicateKeyException` → 回查。该写法依赖 **MySQL 唯一键冲突不中止当前事务**（PostgreSQL 下会失败）。
- SQL 脚本三处必须同步：`init.sql`、`db/manual/20260928_create_email_tables.sql`（新建）、`db/manual/20260928_migrate_email_routing.sql`（旧库迁移）、`src/test/resources/email-schema.sql`（H2）。`InitSqlPoConsistencyTest` 会校验 init.sql 与 PO 一致。

## 执行身份属性：新建 vs 恢复（2026-09-28 踩坑）
- **新建执行**走 `RequestPreparer.attributes()`，会话级业务属性（`TEAM_ID`）随请求写进 `AgentRequest.attributes` 并落进执行快照。
- **恢复执行不经过 `RequestPreparer`**，三条入口都是「读快照 → 直接交给 loop」：`ChatServiceImpl#resume`、`ToolCallServiceImpl#decideDecision`（plan/choice）、`CommandApprovalExecutor#finish`（命令审批）。快照缺属性就会「挂起前能委派、恢复后不能」。
- 已引入 `com.summit.dp.execution.SessionAttributeRestorer`：**任何新增的恢复入口都必须调用 `restore(execution, sessionId)`**，否则又会漏。
- `CallSubAgentTool#childAttributes` **现在会把 `TEAM_ID` 随委派下行**（2026-09-29 起，成员要发信就需要团队快照）。⚠️ 因此「靠属性缺失阻止二次委派」这层保险**已不存在**，防二次委派只剩 `memberTools` 把 `call_sub_agent` 从子执行清单剔除这一道 —— 改这块时务必同时验证「成员清单里没有 call_sub_agent」。
- `TeamPromptComposer`（`agent.infrastructure.workflow`）是指挥者/成员话术的**唯一来源**：`roster(...)` 两边共用同一份名单渲染，改名单格式只改这里。新增角色视角时加一个 `xxxPrompt`，不要另起一份名单拼装。
- 教训：`CallSubAgentTeamResolutionTest` 的 javadoc 声称「resume 后同样解析正确」，但它只单测 `resolveTeamId`，从未跑过恢复链路 —— **守卫注释不能当验证**，涉及跨链路的断言必须真的把链路跑起来。

## 工具暴露面：能力必须与身份前置条件一致（2026-09-29 踩坑）
- **症状**：真实运行里 `call_sub_agent` 报「未确定当前协作团队」、`send_mail_to_agent` 报「当前执行未绑定 Agent」。**不是工具坏了，是模型被给了它用不了的能力。**
- **机制**：`RequestPreparer.toolListOf` 在「未配工具清单 + 可写档位」时返回 `null` = 不加限制 = 全部已注册工具。裸模型会话既无 `AGENT_ID` 也无 `TEAM_ID`，却因此拿到两个协作工具。
- **规则（新增工具时必查）**：任何**有身份前置条件**的工具都必须在 `RequestPreparer#withoutUnusableCollaborationTools` 里登记收口条件；否则它会泄漏到所有「未配清单」的执行里。当前：`call_sub_agent` 需 `TEAM_ID`，`send_mail_to_agent` 需 `AGENT_ID`。
- **协作工具的授予位置**：`call_sub_agent` / `send_mail_to_agent` 都不写进 Agent 配置，而是按角色显式授予 —— 指挥者在 `AgentWorkflowOrchestratorImpl#commanderTools`，成员在 `CallSubAgentTool#memberTools`（成员只给发信、绝不给委派）。新增协作工具要同时改这两处（授予 + 收口），只改一处会出现「要么发不出、要么一调就错」。
- **本地调试口径**：`user_configs.workspace_type=sandbox`、`model_config.id=4` 是真实 DeepSeek key（可跑真模型）；本地 MySQL 在 3306，凭据 root/root，库 `LingXi`。`.run/` 是 gitignore 的本地联调目录。
- **默认 Agent（裸模型档）的基础工具集**（2026-09-29 定案）：`AgentWorkflowOrchestratorImpl.executeDefaultAgent` 授 `ToolCatalog.DEFAULT_AGENT_TOOLS` = `execute_command + read_file + edit_file + web_search`。此前传 `null`（= 不授权任何静态工具），默认档位除了 MCP 检索入口什么都干不了。这四项都不带身份前置条件；协作工具**刻意不在列**（需要团队/Agent 身份）。**只读档不必分叉**：`RequestPreparer.toolListOf` 的只读滤网按注册表 `readOnly` 标记剔除写工具，该清单自动收敛成 `read_file + web_search`。


## MCP 工具渐进式披露（2026-09-29 定案，改动前必读）
- **硬约束**：`ChatRequestBuilder` 把工具转成真正的 `ToolSpecification` 下发 → 标准函数调用下模型**只能**为**已声明**的工具产生结构化 `tool_calls`。任何「MCP 工具永不进 tools 数组、只靠系统提示描述」的方案都会让 MCP 工具彻底调不动。
- **三层披露**：① 提示词 `## MCP Tools` 段只放 **name+description**（`McpToolScope.resumes()`，schema 绝不进提示词）并说明「调 `search_tool` 取 schema，取到后下一轮可调」；② `SearchToolExecutor` 命中后 `scope.disclose(命中名字)`；③ 下一轮 `ModelRequestFactory.availableTools` 才把 `disclosedTools()` 并进 tools 数组。
- **披露账本挂在 `McpToolScope` 上**，不是新组件：它本就同时被 `ToolExecution`（写）与 `ModelRequestFactory`（读）持有，零新管道、不跨请求泄漏、`close()` 一并释放。`disclose` 只认 scope 真正持有的名字 → 调用方把「注册表 ∪ scope」的命中集整个传进来即可，无需区分来源。
- **两个闸门故意不一致**：`ModelRequestFactory` 决定「给模型看什么」（白名单 ∪ 已披露），`DefaultToolExecutionManager.admissible` 决定「调用能到哪」（**scope 内一律放行**，未改）。所以模型在检索同一批里直接调该工具也能成功；改其一必须同时想清楚另一处。
- **`search_tool` 归框架**：实现在 `harness-runtime/.../tool/SearchToolExecutor`（**harness-runtime 无 Spring**，注册表用 `Supplier<ToolRegistry>` 而非 `ObjectProvider`），由 `SearchToolAutoConfiguration` 注册（`matchIfMissing=true` 默认开、`@ConditionalOnMissingBean(name="searchToolDefinition")` 留替换口）。工具名常量唯一来源是 `SearchToolExecutor.NAME`，应用的 `ToolCatalog.SEARCH_TOOL` 转发它。
- **可见性仍由应用授予**：框架 `AgentRequest.toolList` javadoc 明确「应用对模型可见能力保留最终权力」，所以框架**不**擅自放行静态工具；`search_tool` 的「默认可见」由 `RequestPreparer` 在 MCP 在场时兜底授予实现。
- **系统提示词装配**：`ConversationManager.startConversation(execution, workspace, McpToolScope)` 带 scope（`DefaultConversationManager` 是单例，拿不到执行级 scope，只能随调用传入）。段序：`Execution environment → Business Prompt → System Prompt → MCP Tools → Task Manifest`（任务清单最后，离用户回合最近）。空输入一律跳过整段，不留空标题。
- **已修的既有缺陷**：`SystemPromptAssembler.withTaskPrompt(null)` NPE（根请求从不设 `task`，**每个根执行都在 `startConversation` 崩**）；`startWithWorkspace` append 写到 `this` 却返回新实例 → `## Execution environment` 从来没进过提示词；`withSystemPrompt` 从不填默认提示词里的 `%s` 占位符；`complete()` 现 `strip()` 首尾空行。
- **文本块陷阱**：`"""` 后第一个空行只贡献**一个**换行（`## 标题` 会贴上一段），而闭合 `"""` 独占一行时**会**保留末尾换行。写段间分隔必须显式 `"\n\n## X\n"`。

