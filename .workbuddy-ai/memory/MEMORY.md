# LingXi 项目长期笔记

## 代码库坐标
- 业务应用 `D:/Code/LingXi`：Java 21 / Spring Boot 3.5.6 / MyBatis-Plus 3.5.9，DDD 分层。
- 框架 `D:/code/starter/lingxi-harness-agent`，**7 个模块**（以根 pom `<modules>` 为准）：`harness-core` / `harness-adapter-langchain4j` / `harness-runtime` / `harness-kernel-tools` / `harness-spring-boot-autoconfigure` / `lingxi-harness-spring-boot-starter` / `harness-sandbox-docker`。
  - ⚠️ `D:\code\starter\lingxi-harness-starter` **不存在**；`harness-memory` 已不在模块列表（本地仓库还留着旧制品）。
- 依赖方向：`harness-core` ← `harness-runtime` ← `harness-kernel-tools`；`harness-spring-boot-autoconfigure` **不**依赖 kernel-tools（否则成环），由 starter 聚合。kernel-tools 的 `@AutoConfiguration` 需要顺序时只能用 `afterName` 字符串。

## 构建 / 安装（框架仓库）
- 分支 `develop`；`export TMPDIR="D:/Code/LingXi/.run/tmp" && ./mvnw -o -q -DskipTests compile`（离线可构建）。
- ⚠️ Maven 本地仓库在 `D:/languages/mvn/repository`（**不是** `~/.m2/repository`）。
- ⚠️ install 必须加 skip：`./mvnw -o -DskipTests -Dgpg.skip=true -Dmaven.javadoc.skip=true install`（根 pom 面向 Central，gpg:sign / javadoc:jar 绑在 verify，install 会先跑 verify）。不加会长时间卡住/失败。
- 应用要吃到框架改动**必须先 install**；应用侧验证 `./mvnw -o -DskipTests compile` / `./mvnw -o test -Dmaven.test.failure.ignore=true`。
- ⚠️ 单模块测试**必须带 `-am`**，否则从本地仓库取旧版依赖模块（症状像「改动被回滚」）。
- 基线：框架 101 通过 / 0 失败；应用 188 通过 / 0 失败。
- 本地仓库里 `harness-base-tools` / `harness-memory` / `harness-example` 是已删模块遗留制品，别据此推断结构。

## 配置策略（2026-09-29 定案）
- 系统提示词唯一真相源是 `AgentRequest.systemPrompt`；框架**不读任何 yaml 提示词**。应用在 `lingxi.system-prompt` 写人设，`RequestPreparer.mergeSystemPrompt` 拼接。
- 业务侧工具**无** yaml `enabled` 开关（`EditFileProperties` / `ReadFileProperties` / `TerminalToolProperties` 已删）。停用工具 = 从 Agent 工具清单移除。
- `lingxi.agent.runtime.tool.common.*` 是死配置，已删。
- 可配置项：`lingxi.agent.model.conf.chat.max-consecutive-compactions`(3)、`...usage-report-interval`(5)、`lingxi.agent.runtime.tool.search-tool.{max-matches(30),timeout(10s)}`。
- 压缩阈值统一在 `lingxi.agent.runtime.tool.context-compact.{truncate-threshold:0.7, model-threshold:0.85, truncate-rounds:5}`；kernel-tools 提供 `AgentConfig.ProgressiveSqueezePolicy` bean，autoconfigure 用 `ObjectProvider` 消费。

## 框架挂起/恢复模型
- 挂起原语只有 `ToolExecuteResult.promise()`；runner 提交整批工具结果后返回 `LoopResult.SUSPENDED`。协作式、不阻塞线程、无内存决策队列。
- ADR `harness-core/docs/adr/loop-suspension-boundary.md`：PROMISE 只表达 loop 控制，框架故意不提供提问/审批/超时/人工输入编排。
- SPI：`ExecutionControl` + `ActiveExecutionRegistry` + `ExecutionControlSignal`(NONE/REQUIRE_SUSPEND/REQUIRE_CANCEL) + `ExecutionRepository extends ActiveExecutionRegistry`。
- `RuntimeLifeStyleManager`(onStart/onSuspend/onCancel/onComplete/onError/onResume) 与 `RuntimeListener` 均 `@ConditionalOnMissingBean` → 业务可顶替，框架零改动。
- 陷阱：框架 finally 用 `List.copyOf` 冻结 `execution.messages`；恢复必须用 `resume(Execution)`，`resume(String)` 是禁用副本。

## 框架扩展点
- ~40 SPI、19 个 `@ConditionalOnMissingBean` 覆盖点、8 个 `List<T>` 收集点。MCP 是唯一开箱即用扩展（`McpProvider` + `McpToolRegistrar` + `lingxi.mcp.*`，仅 streamable-http）。Skill / 协作编排无预留。
- 注册工具：声明 `ToolDefinition<? extends ToolExecutor>` bean，`CommonToolAutoConfiguration.toolRegistry(List<...>)` 收集；策略 / 拦截器 / 监听同理。
- ⚠️ 应用 bean 不可把默认实现作为注入依赖，必须在 `@Bean` 方法内 `new`。
- `ArchitectureBoundaryTest` 每次构建扫描框架生产源码，禁止 `com.summit.dp.` 等业务标识。

## 框架分布式能力
- 不原生支持多节点：计算内核无状态（✅），但控制信号 / 事件 / 准入 / 后台任务均为进程内（❌）。纯库无 HTTP 层，无 Redis/JDBC/Kafka/ShedLock。
- 生产代码零 static 可变字段、零 ThreadLocal。
- 改造原则：新增接缝默认实现保持单机行为。⚠️ steering（跨节点 suspend/cancel）与 admission（防重复执行）是两个不同原语。

## 框架已知缺口
- `harness-memory` 零个类却已发布；`ArchitectureBoundaryTest.java:74-77` 因「无 src 跳过」漏检。
- `ExecutionRepository extends ActiveExecutionRegistry` 混合「进程内信号路由」与「共享快照存储」。
- `RuntimeProcessorTemplate.java:81` 用 `List.copyOf` 冻结 messages。

## SSE 语义（改 SseEventPublisher / 前端订阅前必读）
- 流是**会话级**的：`GET /a/completion/{sessionId}/events`（`ChatController.subscribe` → `ChatService.subscribeSession`），只订阅不执行、可重复调用。sessionId 必须按 `ExecutionIdentity.rootSessionIdOfSession` 归到根会话（用子会话 ID 会挂到另一个桶，连上收不到事件）。
- ⚠️ `ChatServiceImpl.resume` **不建流** → 恢复后整轮事件无订阅者。新增「触发执行」入口必问：这条执行的事件谁在听？
- **服务端不做回放、不发 gap**（序号+回放+缺口告警曾实现后删除）：实时通道只投递此刻之后的事件，切走期间的缺口由前端回查历史对齐。别再往 SSE 加序号 / 日志 / 回放。
- ⚠️ **写失败不是告警**：终态事件先于 `RuntimeProcessorTemplate#clear` 的收尾用量推送发出 → 「最后那条用量推送写不出去」每轮都会发生。`AsyncRequestNotUsableException` 继承 `IOException`（`ClientAbortException` 也是），`catch (IOException)` 会把它当故障打 WARN+堆栈。现行：DEBUG（只打最内层 cause 类名+消息）+ 摘掉该 emitter。
- 推送失败与 MCP 无关（`McpToolScope.close()` 不走 SSE），别往 MCP 猜。

## 前端 SSE 路由管理中心
- `frontend/src/stores/sseRouter.ts`（pinia，已在 `main.ts` 注册）：连接按根会话保管，组件订阅 / 退订不影响流存在；只做建 / 复用 / 关连接 + 分发事件，不解释语义 / 不缓存 / 不回放。订阅表与连接表分开；键一律根会话 ID；`openStream` 同会话复用；`finish` 只摘自己那条连接。
- `utils/sse.ts#readSseResponse` 的 `stopOnTerminal` 缺省 true，**会话级订阅必须传 false**。
- ⚠️ 尚未迁移：`useChatView.ts` 仍自持 `AbortController`（切会话 686-689、卸载 1324-1326 abort），`chatStreamService.sendMessageStream` 仍自建流。前端无测试框架，只能 `npm run build`（含 `vue-tsc -b`）兜类型。

## 业务约定
- **邮箱**：`email` 表 = 一次协作轮次里一个收件 Agent 的**角色邮箱**；业务键 `(workflow_execution_id, recipient_agent_id)`，唯一索引 `uk_email_workflow_recipient`。`workflow_execution_id` 恒为协作根执行 ID。统一入口 `ExecutionAttributes.readLong` / `.workflowExecutionId`，收发两侧必须同一函数。同轮次同名 Agent 会竞争消费。客户端不得写路由字段（`/email/add|update` 已删），投递只走 `EmailService.sendMail`。并发首次建箱靠 `DuplicateKeyException`（依赖 MySQL 唯一键冲突不中止事务）。
- SQL 三处必须同步：`init.sql`、`db/manual/*.sql`（迁移）、`src/test/resources/*-schema.sql`（H2）。`InitSqlPoConsistencyTest` 校验 init.sql 与 PO 一致。
- **执行身份属性**：新建执行走 `RequestPreparer.attributes()`；**恢复执行不经过 RequestPreparer**（`ChatServiceImpl#resume`、`ToolCallServiceImpl#decideDecision`、`CommandApprovalExecutor#finish`），必须调 `SessionAttributeRestorer.restore(execution, sessionId)`。`CallSubAgentTool#childAttributes` 会把 `TEAM_ID` 下行 → 防二次委派只剩 `memberTools` 剔除 `call_sub_agent` 这一道。`TeamPromptComposer` 是话术唯一来源。
- **工具暴露面**：`RequestPreparer.toolListOf` 在「未配清单 + 可写档位」时返回 null = 不加限制 = 全部已注册工具。任何有身份前置条件的工具必须在 `RequestPreparer#withoutUnusableCollaborationTools` 登记收口（`call_sub_agent` 需 TEAM_ID，`send_mail_to_agent` 需 AGENT_ID）。协作工具按角色显式授予：指挥者在 `AgentWorkflowOrchestratorImpl#commanderTools`，成员在 `CallSubAgentTool#memberTools`（成员只发信、绝不给委派）。默认 Agent 授 `ToolCatalog.DEFAULT_AGENT_TOOLS` = execute_command + read_file + edit_file + web_search。
- **MCP 渐进式披露**：`ChatRequestBuilder` 把工具转成真 `ToolSpecification` → 标准函数调用下模型只能调已声明工具，故「MCP 工具永不进 tools 数组」不可行。三层：① 提示词 `## MCP Tools` 只放 name+description；② `SearchToolExecutor` 命中后 `scope.disclose(name)`；③ 下一轮 `ModelRequestFactory.availableTools` 并入 `disclosedTools()`。账本挂在 `McpToolScope`。两个闸门故意不一致：`ModelRequestFactory`（给模型看什么）vs `DefaultToolExecutionManager.admissible`（scope 内一律放行）。
- 三条人工在环链路：命令审批（`CommandPolicyConfig`）/ plan（`CreatePlanTool`）/ choice（`RequireChoiceToolExecutor`）。
- 重构进行中：`tool_call` 表 + `ToolCall` 充血模型 + `ToolCallRegistrar` 替换 `interaction_status`；旧链路在 `interaction/application/service/impl/deprecated/`。
- 本地联调：MySQL 3306 root/root 库 `LingXi`；`user_configs.workspace_type=sandbox`、`model_config.id=4` 是真 DeepSeek key。`.run/` 是 gitignore 的本地目录。

## 工程教训（已实际踩过）
1. 写「守卫 / 断言类」测试后必须模拟干净环境（`git archive HEAD` 或 `git worktree`）再跑 —— git 不跟踪空目录，依赖「空目录存在」的判据在 fresh clone 会翻转。
2. 同批同模式的改动必须全部检查，不能抽查一处。
3. 改并发代码时「移除锁条目」类方案要先想清竞态（用固定条带锁）。
4. 纯 clean-slate 评审在证据缺失处会过于宽容 → 必须共享证据。
5. 提交信息里的验证声明必须是干净环境的结果。
6. **在脏工作树上叠加改动前，先固化一份「改动前快照」再动手**：`git diff HEAD > .run/wip-backup-<日期>.patch` + `git ls-files --others --exclude-standard` 打包未跟踪文件。事后用 `git worktree add --detach <dir> HEAD` + `git apply <patch>` 建出「HEAD+WIP、不含本次改动」的基线，**在基线上复跑同一批测试**，才能证明失败是既有的而非本次引入的。已实际用到（2026-09-30：证明 6 个既有失败与本次无关）。
7. ⚠️ `diff -rq` 比对两个工作树会被**行尾符**噪声污染（`git apply` 后的 worktree 是 LF、工作区是 CRLF），几乎每个文件都报 differ。要界定「本次到底改了哪些文件」，用 `find <dir> -newermt "<时间>"` 更可靠。
