# LingXi 项目长期笔记

## 代码库坐标
- 业务应用：`D:/Code/LingXi`（Java 21 / Spring Boot 3.5.6 / MyBatis-Plus 3.5.9，DDD 分层）
- **框架（harness）**：`D:/code/starter/lingxi-harness-agent`（8 模块：harness-core / harness-runtime / harness-memory / harness-sandbox-docker / harness-adapter-langchain4j / harness-spring-boot-autoconfigure / lingxi-harness-spring-boot-starter / migration）
  - ⚠️ 用户口述的 `D:\code\starter\lingxi-harness-starter` **不存在**，勿再按该路径查找。

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

## 框架仓库操作须知
- 分支 `develop`；构建：`export TMPDIR="D:/Code/LingXi/.run/tmp" && ./mvnw -o -q -DskipTests compile`（离线可构建，~53s）；测试 `./mvnw -o test -Dmaven.test.failure.ignore=true`。
- 全量测试当前 **61 通过 / 1 失败**；唯一失败 `LoopRegressionTest:144`（compaction 转录）为**基线既存真实缺陷**，与任何改动无关——不要把「基线就这样」当作不修的理由。
- 关键提交：`0b7d6b6`（loop 收敛基线 + 移除 harness-example）、`3d43a5f`（冗余与职责边界收敛保守档）。
- `.tmp-build/`、`.workbuddy/` 已在 `.gitignore`。

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
