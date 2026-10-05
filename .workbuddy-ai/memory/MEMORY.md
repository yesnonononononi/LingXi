## 架构现状：纯 H2 单库（2026-10-03 迁移）
- MySQL 已退役：mysql-connector-j、docker-compose 的 mysql 服务/卷、.env 的 MYSQL_*、application-dev/product/h2.yaml 三个 profile 全删。`application.yaml` 写 `jdbc:h2:file:${lingxi.data.dir:${user.home}/.lingxi/data}/lingxi;MODE=MySQL`（sa/空密码，org.h2.Driver），无 spring.profiles.active。
- **数据存储目录 = 普通配置项 `lingxi.data.dir`**（缺省 `${user.home}/.lingxi/data`，可用 `-Dlingxi.data.dir=` 或环境变量 `LINGXI_DATA_DIR` 覆盖 —— relaxed binding 生效）。H2 接受 Windows 混合分隔符（`C:\Users\x/.lingxi/data`）。库文件不再随 cwd 漂移。`/config/current` 的 `dataStorage` 由 `UserConfigServiceImpl` 用 `@Value` **直接回显该属性**（只读：Request/Command/controller 里都已移除）。2026-10-03 初版曾用 EnvironmentPostProcessor 两段式「从库内读回」，因配置全面 YAML 化而**已删除**。
- ⚠️ **配置已全面 YAML 化**（2026-10-03 用户改造）：mcp / model / user_configs 改走 `AbstractYamlRepository` + `YamlListStore`（`shared/infrastructure/yaml`），文件落在 `~/.lingxi/config/{mcp,models,user-configs}.yaml`（路径由 `lingxi.config.*.path` 配）；数据库表仅作**首次迁移来源**（`mapper.selectList(null)`）。**别再往这几张表加列**。
- **文件落点全景**：`~/.lingxi/config/*.yaml`（3 份配置）+ `~/.lingxi/data/lingxi.mv.db`（其余 11 张表仍走 H2）；Electron `app.getPath('userData')` 放 `logs/backend.log`、并作为后端 cwd（解析 `optional:file:.env`）；用户工作空间 = `workspace.host_dir`（任意路径）。YAML 落盘走框架 `AtomicFileWriter`（同目录 `.ddd-*.tmp` → `ATOMIC_MOVE` 替换）；事务内改动暂存内存、`afterCommit` 才写，回滚即丢弃；无事务则立即写。
- **MODE=MySQL 刻意保留**（用户要求 SQL 体验与 MySQL 无缝）：init.sql 仍 MySQL 方言，业务 SQL 按 MySQL 习惯写；`ON UPDATE CURRENT_TIMESTAMP` 继续生效（业务零处显式 setUpdateTime）。
- `H2SchemaInitializer` 无 @Profile，全环境生效（零 @SpringBootTest）；`electron/backend.cjs` 仅在 LX_SPRING_PROFILE 有值时传 profile。`MybatisPlusConfig` 硬编码 DbType.H2（`lingxi.mybatis.db-type` 已删）。
- ⚠️ **未决**：无迁移机制 —— 缺表即整库重建、存量数据丢失；桌面端支持版本升级必须补迁移脚本。
- **init.sql 是唯一 DDL 真源**（MySQL 方言，14 张表）。`InitSqlPoConsistencyTest` 校验 init.sql 与 PO 一致 —— 它红就是真库有列而 init.sql 缺，必须补 init.sql。单测另有 src/test/resources/*-schema.sql。

## 框架（D:\code\starter，只读参考）
- 挂起原语只有 `ToolExecuteResult.promise()`；runner 提交整批工具结果后返回 `LoopResult.SUSPENDED`（协作式、不阻塞线程）。ADR `harness-core/docs/adr/loop-suspension-boundary.md`：PROMISE 只表达 loop 控制，框架故意不提供提问/审批/超时编排。
- SPI：`ExecutionControl` + `ActiveExecutionRegistry` + `ExecutionControlSignal`(NONE/REQUIRE_SUSPEND/REQUIRE_CANCEL) + `ExecutionRepository extends ActiveExecutionRegistry`。
- `RuntimeLifeStyleManager`(onStart/onSuspend/onCancel/onComplete/onError/onResume) 与 `RuntimeListener` 均 `@ConditionalOnMissingBean` → 业务可顶替。
- 陷阱：框架 finally 用 `List.copyOf` 冻结 execution.messages（`RuntimeProcessorTemplate:81`）；恢复必须用 `resume(Execution)`，`resume(String)` 是禁用副本。
- 扩展点：~40 SPI、19 个 `@ConditionalOnMissingBean`、8 个 `List<T>` 收集点。MCP 是唯一开箱即用扩展（`McpProvider`+`McpToolRegistrar`+`lingxi.mcp.*`，仅 streamable-http）。注册工具：声明 `ToolDefinition<? extends ToolExecutor>` bean，`CommonToolAutoConfiguration.toolRegistry(List<...>)` 收集；策略/拦截器/监听同理。
- ⚠️ 应用 bean 不可把默认实现作为注入依赖，必须在 `@Bean` 方法内 `new`。
- 不原生支持多节点：计算内核无状态，但控制信号/事件/准入/后台任务均进程内。生产代码零 static 可变字段、零 ThreadLocal。steering（跨节点 suspend/cancel）与 admission（防重复执行）是两个原语。
- `ArchitectureBoundaryTest` 每次构建扫描框架生产源码禁止业务标识；因「无 src 跳过」漏检 harness-memory 零类问题。

## SSE 语义（改 SseEventPublisher / 前端订阅前必读）
- ⚠️ **`./mvnw` 在本机坏了**（试图写 `D:\languages/mvn/wrapper`，Permission denied）。跑后端测试用系统 `mvn`（`D:\languages\mvn`，3.9.16 + JDK 21），例：`mvn -o test -DfailIfNoTests=false`。前端 `cd frontend && npm test`。
- ⚠️ **v3 迁移当前处于断链状态（2026-10-04 核查）**：`sseRouter.sessionStreamUrl` 已固定 `?schemaVersion=3`，但 v3 前端入口 `streamV3Sync.ts#attachStreamV3` **零调用方**（`useStreamV3Store` 也只被它自己 import）；实时消费仍是 `useChatView → messageRouter.routeToSession`（词表 `COMPLETE_TEXT`/`AI_MESSAGE`/`CARD_PENDING`）→ **v3 帧被静默丢弃**。第 5 步「删 v2/v1」前置未满足，别删。推进路线（用户已定**路线 1**）：先补后端 v3 生产链（**已完成，见下**），再切前端批次 A（接 `attachStreamV3` 到实时入口），验证后批次 B。
- **后端 v3 实体提交链已补齐（2026-10-04，474 用例全绿）**：`CommittedStateChange` 增不可变 `payload`（`of(kind, sessionId, id, payload)`）；三个仓储（session_message / chat_turn / session）在写库后随通知带**落库终值快照**；新增 `CommittedStateV3Observer`（`stream/infrastructure/listener/`）把 MESSAGE/TURN/SESSION/HISTORY 四类**零查询**直投 v3（走 `EventStreamPublisher`，不经 `SessionStreamHub`）。四类事件生产端覆盖已从 7/11 → **11/11**。测试 `CommittedStateV3DeliveryTest`（8 用例）从**真实仓储+真实事务**驱动。⚠️ `Session\ChatTurn\SessionMessage` 直接作 payload 下发（无 VO 转换层），生产 `JsonConfig` 的 Long→字符串序列化保证 id 是字符串。
- ✅ **`DatabaseConversationTranscriptSink` 已改**（2026-10-04）：优先读元数据 `sessionId`（`ExecutionEventMetadata.sessionId`），缺才回落 `executionIdentity.sessionId` 查 execution 表。对应 `DatabaseConversationTranscriptSinkMetadataTest` 已重写为 4 用例（含 `verifyNoInteractions(identity)`）。
- ✅ **`SubAgentRequestFactoryTest` 既有红已修**（2026-10-04）：同步 `TeamPromptComposer` 的多行块 + `### 成员名单(TEAM ROSTER)` 新格式，**未回退生产**。
- 压缩（§3.3）：本仓**无独立内部摘要调用路径** —— 压缩是主模型工具调用（`ToolResultType.CONTEXT_COMPACT`，`AgentLoopStepRunner:103/231` 把**原始 response** 追加 transcript）→ 行为天然符合 §3.3，只是缺测试。

- 流是**会话级**：`GET /a/completion/{sessionId}/events`，只订阅不执行、可重复调用。sessionId 必须按 `ExecutionIdentity.rootSessionIdOfSession` 归到根会话。
- ⚠️ `ChatServiceImpl.resume` **不建流** → 恢复后整轮事件无订阅者。新增「触发执行」入口必问：这条执行的事件谁在听？
- **服务端不做回放、不发 gap**。别再加序号/日志/回放。
- ⚠️ **写失败不是告警**：终态事件先于 clear 的收尾用量推送发出 →「最后那条用量推送写不出去」每轮都发生。`AsyncRequestNotUsableException` 继承 IOException，`catch (IOException)` 会误当故障打 WARN+堆栈。现行：DEBUG（只打最内层 cause）+ 摘掉该 emitter。

## 前端 SSE 路由管理中心
- `stores/sseRouter.ts`（pinia，已注册）：连接按根会话保管，组件订阅/退订不影响流存在；只做建/复用/关连接 + 分发，不解释语义/不缓存/不回放。订阅表与连接表分开；键一律根会话 ID。
- `utils/sse.ts#readSseResponse` 的 `stopOnTerminal` 缺省 true，**会话级订阅必须传 false**。
- ⚠️ 尚未迁移：`useChatView.ts` 仍自持 AbortController，`chatStreamService.sendMessageStream` 仍自建流。前端无测试框架，只能 `npm run build` 兜类型。
- ⚠️ **同一轮次只允许一条 assistant 气泡**：`applyStreamMessage` 按 id 合并，审批恢复流气泡钉本地 id（`msg-bot-resume-*`），`chatSessionStore#initTurn` 复用的却是该轮既有气泡 → 必须再按 **turnId** 兜底归并（`mergeAuthoritativeMessages` 无条件保留 `isComplete===false`）。2026-10-02 修。`chatSessionStore` 里没有 `initExecution`，只有 `initTurn`。

## 业务约定
- **邮箱**：`email` 表 = 一轮协作里一个收件 Agent 的**角色邮箱**；业务键 `(workflow_execution_id, recipient_agent_id)`，唯一索引 `uk_email_workflow_recipient`；`workflow_execution_id` 恒为协作根执行 ID。统一入口 `ExecutionAttributes.readLong`/`.workflowExecutionId`。客户端不得写路由字段，投递只走 `EmailService.sendMail`。并发首建靠 `DuplicateKeyException`。
- **执行身份属性**：新建走 `RequestPreparer.attributes()`；**恢复不经过 RequestPreparer**（`ChatServiceImpl#resume`、`ToolCallServiceImpl#decideDecision`、`CommandApprovalExecutor#finish`），必须调 `SessionAttributeRestorer.restore(execution, sessionId)`。`CallSubAgentTool#childAttributes` 下行 `TEAM_ID`。`TeamPromptComposer` 是话术唯一来源。
- **工具暴露面**：`RequestPreparer.toolListOf` 在「未配清单 + 可写档位」时返回 null = 全部已注册工具。有身份前置条件的工具必须在 `#withoutUnusableCollaborationTools` 登记（`call_sub_agent` 需 TEAM_ID，`send_mail_to_agent` 需 AGENT_ID）。协作工具按角色显式授予：指挥者 `AgentWorkflowOrchestratorImpl#commanderTools`，成员 `CallSubAgentTool#memberTools`（只发信、绝不给委派）。默认 Agent = `ToolCatalog.DEFAULT_AGENT_TOOLS`。
- **MCP 渐进式披露**：`ChatRequestBuilder` 把工具转成真 ToolSpecification，故「MCP 工具永不进 tools 数组」不可行。三层：① 提示词 `## MCP Tools` 只放 name+description；② `SearchToolExecutor` 命中后 `scope.disclose(name)`；③ 下一轮 `ModelRequestFactory.availableTools` 并入 `disclosedTools()`。两闸门故意不一致：`ModelRequestFactory`（给模型看）vs `DefaultToolExecutionManager.admissible`（scope 内一律放行）。
- 三条人工在环链路：命令审批（`CommandPolicyConfig`）/ plan（`CreatePlanTool`）/ choice（`RequireChoiceToolExecutor`）。
- **挂起沿委派链传播**：子执行 SUSPENDED → `CallSubAgentTool:222-226` 转父执行 `DELEGATION` PROMISE（载荷带 subSessionId）→ 父同步挂起 → 传到根。`kind=DELEGATION` 卡片不是人工审批卡（`ToolCallServiceImpl#decide` 对它抛错）。回填由 `DelegationBackfillListener` 做（异步 + 每父执行一把锁），`resumeIfReady` 收口「停止 vs 审批」竞态。
- **会话不继续执行的三道闸门**（请求线程、用户消息落库前）：① `ChatServiceImpl#guardNotSuspended`；② `SessionExecutionRegistry#beginRoot` 进程内单飞；③ `registerChild` 的 cancelled 检查。`stop` 四层覆盖：会话树 + `liveChildren` + `activeExecutionIds` + `Thread.interrupt()`。
  - ⚠️ 薄弱点：`guardNotSuspended` 与 `ExecutionIdentity#latestSuspendedExecutionId`(67-74) **只查单个会话**，多层委派的**孙会话挂起会漏判**。`root_execution_id` 是执行归属不是会话归属。
  - `execution.snapshot` 反解**全项目唯一一处**：`LocalExecutionRepository:190`（`findById`）。只读场景一律不反解。
- 重构进行中：`tool_call` 表 + `ToolCall` 充血模型 + `ToolCallRegistrar` 替换 `interaction_status`；旧链路在 `interaction/application/service/impl/deprecated/`。
- 本地联调：`.run/` 是 gitignore 的本地目录；`user_configs.workspace_type=sandbox`、`model_config.id=4` 是真 DeepSeek key。
- **前端无「任务清单」**（2026-10-02 整体删除）：后端无 `create_task_manifest`/`update_task` 等工具，**别再引入**；与「计划模式 / `create_plan` / `PlanCard` 主体」区分（后者保留）。`UserConfigVO.planMaxReminders` 与任务清单无关。

## 持久化 / 可移植性
- **零 XML mapper**：全部 `BaseMapper` + LambdaQueryWrapper。零 MySQL 专有函数。
- **JSON 列不依赖 DB JSON 类型**：`McpRepositoryImpl` 把 `headers`/`env` 当 JSON 字符串存取。H2 下 6 个 JSON 列（`mcp.headers/env`、`tool_call.content/raw_input/raw_output/meta_data`）必须写 `TEXT` —— 否则 `setString` 后 `getString` 多一层引号、Java 侧解析失败。
- 主键：`IdType.AUTO`（DB 自增，7 个 PO，含 team）；`IdType.INPUT`（雪花，session_message / session_context / email）。
- `update_time` 双写：DDL 有 `ON UPDATE CURRENT_TIMESTAMP`，代码另有 8 处显式 `.updateTime(...)`。
- `docker-compose.yml` 的 `redis:8` 是死配置（pom 无 redis 依赖）。

## 前端过程时间线的 order 契约（2026-10-03 修）
- `order` 是**前端自造的跨集合排序键**：`aggregateSessionMessages` 把扁平行按类型分桶进 `thoughtSteps`/`toolCalls`/`aiMessages`，跨类型先后丢失 → 用 `order` 编码回「原始行位置」，`ChatMessageItem#processTimeline` 按它排序还原时序。
- ⚠️ **三条集合必须同基准**：历史回放统一 `rowIndex * TIMELINE_SLOT_STRIDE`（`utils/session.ts`，行内 +0 思考 / +1 中间文本 / +2+tIdx 工具；stride=100 以容纳单行并行工具）。实时流另一套编码 `getNextOrder = max+1`，两者不可混进同一气泡。
- 「终结轮次 = 该轮无工具调用」的文本才是正文，其余 AI 文本进过程区；`call_sub_agent` 会被折叠成一条「团队协作」banner（钉在首个委派 order）。
- 前端**有**测试：`cd frontend && npm test`（`npx tsx --test tests/crossPageTurn.test.ts`）。改 session.ts 的聚合逻辑必须跑它。

## 工程教训
1. 守卫/断言类测试必须模拟干净环境（`git archive HEAD` / `git worktree`）再跑 —— git 不跟踪空目录。
2. 同批同模式改动必须全部检查，不能抽查一处。
3. 改并发代码时「移除锁条目」类方案要先想清竞态。
4. 在脏工作树上叠加改动前，先固化「改动前快照」（`git diff HEAD > .run/wip-backup-<日期>.patch` + 打包未跟踪文件），事后用 worktree 建基线复跑同一批测试，才能证明失败是既有的。
5. ⚠️ `diff -rq` 比对两个工作树会被**行尾符**噪声污染；界定「本次改了哪些文件」用 `find <dir> -newermt "<时间>"`。
6. ⚠️ 前端 `vue-tsc -b` 报出与改动面无关的类型错误时，先怀疑**陈旧增量缓存**：`rm -f frontend/node_modules/.tmp/*.tsbuildinfo` 再 `vue-tsc -b --force`。
