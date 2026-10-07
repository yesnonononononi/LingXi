# LingXi 项目长期记忆（2026-10-07 重整）

## 一、架构：纯 H2 单库 + 配置 YAML 化
- MySQL 已退役。`application.yaml`：`jdbc:h2:file:${lingxi.data.dir:${user.home}/.lingxi/data}/lingxi;MODE=MySQL`（sa/空密码）。数据目录 = `lingxi.data.dir`（`-D` / `LINGXI_DATA_DIR` 可覆盖）；`/config/current` 的 `dataStorage` 由 `UserConfigServiceImpl` 用 `@Value` 只读回显。
- `MODE=MySQL` 刻意保留：init.sql 仍 MySQL 方言，`ON UPDATE CURRENT_TIMESTAMP` 生效（业务零处显式 setUpdateTime）；`MybatisPlusConfig` 硬编码 DbType.H2。
- 配置 YAML 化：mcp / model / user_configs 走 `AbstractYamlRepository` + `YamlListStore`（`shared/infrastructure/yaml`），落 `~/.lingxi/config/{mcp,models,user-configs}.yaml`；DB 表**仅作首次迁移来源**，**别再往这几张表加列**。落盘走 `AtomicFileWriter`（`.ddd-*.tmp` → `ATOMIC_MOVE`）；事务内暂存内存、`afterCommit` 才写，回滚即丢。
- 文件落点：`~/.lingxi/config/*.yaml`（3）+ `~/.lingxi/data/lingxi.mv.db`；Electron `userData` 放 `logs/backend.log` 并作后端 cwd；用户工作空间 = `workspace.host_dir`。
- `init.sql` 是唯一 DDL 真源；`InitSqlPoConsistencyTest` 校验它与 PO 一致 —— 红就补 init.sql。`H2SchemaInitializer`（ApplicationRunner + HIGHEST_PRECEDENCE）全环境生效，早于 `ExecutionStartupReaper`。
- ⚠️ 无通用迁移机制 —— 缺表即整库重建、存量数据丢失。已有个案迁移（`db/migration/V3_*`：用 `hasColumn` 判旧形状 → 执行含 DROP 的重建脚本；含 DROP 的脚本**绝不能无条件执行**，否则每次启动抹掉刚写入的崩溃标记）。

## 二、框架（D:\code\starter，只读）
- 挂起原语只有 `ToolExecuteResult.promise()`；runner 提交整批工具结果后返回 `LoopResult.SUSPENDED`（协作式、不阻塞线程）。ADR `loop-suspension-boundary.md`：PROMISE 只表达 loop 控制，框架不提供提问/审批/超时编排。
- SPI：`ExecutionControl` + `ActiveExecutionRegistry` + `ExecutionControlSignal` + `ExecutionRepository extends ActiveExecutionRegistry`。失败收尾一律走 `ExecutionControl.fail(execution, cause).run()` 一条链（落终态 → 提交后通知轮次收口 + 清未决工具 → 发终态事件），**业务侧不要手写轮次收口**。`Execution#failChecked` = `requireNotTerminal()`（只拦终态，SUSPENDED→FAILED 合法）。
- 陷阱：框架 finally 用 `List.copyOf` 冻结 `execution.messages`（`RuntimeProcessorTemplate:81`）；恢复必须 `resume(Execution)`，`resume(String)` 是禁用副本。
- 扩展点：~40 SPI、19 个 `@ConditionalOnMissingBean`、8 个 `List<T>` 收集点。注册工具：声明 `ToolDefinition<? extends ToolExecutor>` bean，`CommonToolAutoConfiguration.toolRegistry(List<...>)` 收集。⚠️ 应用 bean 不可把默认实现作为注入依赖，必须在 `@Bean` 方法内 `new`。
- `LoopInterceptor` 按 `order()` 升序串链；异常默认被吃掉（`catchErr()` 默认 true，改变业务语义的动作要显式返回 false 上抛）；每个模块写自己的实现类，业务侧从 -900 起分段，框架占 `Integer.MIN_VALUE`。`LoopContext.execution()` 拿执行身份，不要绕 attributes。
- MCP 是唯一开箱即用扩展（`lingxi.mcp.*`，仅 streamable-http）。不原生支持多节点：内核无状态，但控制信号/事件/准入/后台任务均进程内；生产代码零 static 可变字段、零 ThreadLocal。

## 三、SSE：单一会话级流（现行）
- ⚠️ `./mvnw` 本机坏了（wrapper Permission denied）。后端测试用系统 `mvn -o test -DfailIfNoTests=false`（`D:\languages\mvn`，3.9.16 + JDK 21）。前端 `cd frontend && npm test`（脚本 `&&` 串联会跳过末尾原生测试）；`npm run build` 需 `CODEBUDDY_SAFE_DELETE_ENABLED=0`。
- **拓扑**：发送 = `POST /a/completion/commands` 同步受理（返回权威 sessionId/turnId），**不建流**；实时事件唯一出口 = `GET /a/completion/{rootSessionId}/events`。旧请求级流 / `stores/sseRouter.ts` / `utils/sse.ts` / v3 投影链（`streamV3*`、`CommittedState*`、`StreamSubscription`）**已整体删除**（commit 16582a7）。`POST /tool-call/decisions` 是 JSON 回执、不建流。
- 后端 `SseEventPublisher`：按 rootSessionId 分桶；`connect` **先入桶再发 READY**（顺序不可反，客户端「等 READY 再提交」建立在此之上）；`publish` 无订阅者时静默丢弃；**业务事件绝不关流**（流跟页面挂载/卸载走）。摘流只有 4 个触发点：`onCompletion` / `onTimeout` / `onError` / `send`|`sendSignal` 写失败。心跳 30s 一帧命名事件（不是注释行），心跳本身就是死连接探测器。一次性短命流（审批/恢复）才用 `finish(emitter)`。
- ⚠️ `ChatServiceImpl#resume` **不建流** → 恢复后整轮事件无订阅者。新增「触发执行」入口必问：这条执行的事件谁在听？
- ⚠️ **写失败不是告警**：`send` 失败只记 DEBUG（只打最内层 cause）+ 摘流。但 `SseEventPublisher:97-100` 的 `onError` 回调仍是 **WARN**，且它由**容器异步错误路径**触发（Tomcat 探测到客户端断开 → `AsyncListener.onError` → `DeferredResult.LifecycleInterceptor.handleError` → `errorCallback.accept(t)`），**不是**我们自己的 send 失败（`completeWithError` 走 `setErrorResult`，不回调 errorCallback）。所以「每次断连刷 WARN」的真实来源是客户端断连被容器探测到。
- ⚠️ **为何日志里是中文原文**：Spring `DisconnectedClientHelper.EXCEPTION_PHRASES` 只认英文 `"broken pipe"` / `"connection reset by peer"`；Windows + JDK 中文环境给的是「你的主机中的软件中止了一个已建立的连接。」→ 不被识别 → 不包装成 `AsyncRequestNotUsableException` → 原始消息直达 `onError`。Spring 本意就是这类异常只打一行 DEBUG。
- ⚠️ **会话实体上的 `rootSessionId` 有「哨兵 0」**：`Session.ROOT_SESSION_ID=0L` + `SessionVO.rootSessionId` 走 `ToStringSerializer` → 根会话下发字符串 `"0"`（非 null）。解析订阅键一律走 `frontend/src/utils/session.ts#resolveRootSessionId(session)`（temp→null；`declared && declared !== '0' ? declared : id`）；写成 `rootSessionId != null ? ... : id` 会拼出 `/a/completion/0/events` → 后端 `resolveRootSessionId(0)` 抛 `IllegalStateException` → 兜底 500。守卫 `singleSessionStream.test.ts#1c`。注意 `SessionTreeVO.rootSessionId` 是真根 id，永不为 0。
- `ChatServiceImpl#subscribeSession` 入口校验 `throwIf(sessionId == null || sessionId <= 0, "会话标识不合法")`。⚠️ 合法但不存在的会话 id 仍会 500（未决）。
- ★ **前端流生命周期（2026-10-07 已修，两条不变量）**：① **「使用前提」与「新增使用者」必须分开** —— `acquire` 计数（必须配对 `release`），只给真正的使用者（主视图/抽屉挂载）；发送链路的前置走 **`ensure`（不计数）**。把发送也写成 `acquire` 会让计数随发送次数单调增长，切走会话时归不了零、连接永远释放不掉。② **连接查找必须按显式根会话 id** —— `waitUntilReady(rootSessionId, timeoutMs)` / `isReady(id)` / `getHealthState(id)`；曾按「Map 里最后插入的键」解析（`currentRootId()`），多会话并存时会等到别的会话上 → 误判超时就绪 → `submitCommand` 触发 `reconnectStream()` → `reconnect()` abort 全部连接。守卫 `singleSessionStream.test.ts#1d`（变异：`ensure`→`acquire` 则 `实际=4` 红）、`#1e`（变异：改回「最后插入」则红）。前端只在「refCount 归零 / `reconnect()` / 页面卸载」关流，**没有任何业务事件关流**（已 grep 确认）。
- ⚠️ 同族未修：`useChatView` 的 `onHealthChange: (_rootSessionId, state) => streamHealthState.value = state` 忽略会话维度（多连接时互相覆盖）；`reconnect()` 仍是「abort 全部连接」而非只重挂当前会话。

## 四、前端渲染层
- ⚠️ 同一轮次只允许一条 assistant 气泡：`applyStreamMessage` 按 id 合并，审批恢复流气泡钉本地 id（`msg-bot-resume-*`），`chatSessionStore#initTurn` 复用该轮既有气泡 → 必须再按 **turnId** 兜底归并（`mergeAuthoritativeMessages` 无条件保留 `isComplete===false`）。
- ⚠️ reducer 绝不能捕获 `session.messages` 裸数组引用：`useChatHistory#reconcileSessionAfterStream`/`handleLoadMoreHistory` 整体替换 `cur.messages`/`cur.subSessions`。故 `TurnStreamReducer` 入参是 `ChatMessage[] | (() => ChatMessage[])`，一律走 `getMessages()`；`streamSessionRouter#bindRootSession` 同 id 也必须先更新 `currentRootSession` 再复用 reducer。违反即复现「第二条用户气泡要等 AI 完成才出现」。
- 回答气泡工具条权威源 = `session.turns`（`Record<turnId, ChatTurn>`），绑定走 `utils/session#buildMessageTurnMap`；分组唯一规则 `groupMessagesByTurn`；历史接口每页返回 `turns`，**必须 `mergeTurns` union 进 `session.turns`**。null=未采集→「暂无统计」，绝不显示 0。
- 三个对齐入口都走 `reconcileSessionAfterStream`：进入会话、重连成功、本轮终结/挂起。终态与挂起都由 `useChatView#onEvent` 登记 `terminalTurnIds` 后回查。
- `order` 是前端自造的跨集合排序键（`aggregateSessionMessages` 分桶进 `thoughtSteps`/`toolCalls`/`aiMessages` 后按它排序）。三条集合必须同基准：历史回放 `rowIndex * TIMELINE_SLOT_STRIDE`（stride=100，行内 +0 思考 / +1 中间文本 / +2+tIdx 工具）；实时流另一套 `getNextOrder = max+1`，不可混进同一气泡。
- **中间叙述落点（实时与历史同源）**：判据 =「工具调用即断句」——`turnStreamReducer#handleToolCall` 把已累计 `content` 移进 `aiMessages`（历史侧 `aggregateSessionMessages` 同规则）；正文只剩「最后一个无工具调用的轮次」。⚠️ `allocateOrder` **必须计入 `aiMessages`**。渲染上时间线**常显**（文本项永不可折叠），一键收起只通过各过程项 `:class="hidden"` 控制（thought / tool / sub_agent）——**不要用 `v-show`**（那些分支已在 `v-if`/`v-else-if` 链上），也不要「简化」回一个包住整条时间线的折叠容器。终结靠 `watch(isMessageCompleted)` 的 **false→true 跳变**收起。`call_sub_agent` 折叠成「团队协作」banner（钉首个委派 order）。
- 回归面：`frontend/tests/{streamRendering,crossPageTurn,frontendRenderFix,promiseCard,chatLiveRenderFixes,qaIndependentVerification,singleSessionStream}.test.ts`。既有失败：`reasoningEffort.test.ts` 调未导出的 `syncReasoningEffort`。

## 五、人工在环卡片（PROMISE）
- 后端 `com.summit.dp.toolcall` 权威：`content.kind` = PLAN`{title,text}` / CHOICE`{question,options[]}` / COMMAND`{command,workDir,shell,intention?}`；`allowedActions` PLAN/COMMAND→APPROVE|REJECT、CHOICE→ANSWER；★唯一可审批判定 **`type==='PROMISE' && status==='pending'`**。决策 `POST /tool-call/decisions`（`commandId` 幂等 + `expectedVersion` 冲突），权威查询 `GET /tool-call/{toolCallId}`。
- 前端唯一映射点 `utils/toolCallCard.ts`：`resolveCardKind` 对缺失/非法/EXECUTE **恒降级 UNAVAILABLE，绝不回落 COMMAND**；`canDecideCard(card,action)` 是按钮门控（`pending===true && allowedActions.includes(action)`）。
- 双路径建卡：历史 `utils/session.ts` 对 `type==='PROMISE'` 把权威 `ToolCallVO` 存进 `asst.promptCards`；实时 `turnStreamReducer#resolvePromptCard` 经 `onResolveCard`（=`chatApi.fetchToolCall`）拉 VO，有 `type!=='PROMISE'` 守卫。**改任一路必须同步另一路**。
- 渲染在过程折叠区之外（`ChatMessageItem.vue` 约 397-446）；待决卡整卡展开、折叠/关闭 `v-if="isResolved"`（待决态不可移除）；已决卡收成摘要行。外壳 `utils/cardUi.ts`，header `CardHeader.vue`，按钮 `CardActionButton.vue`。⚠️ `scrollbar-thin` 是有效类（`src/style.css:78-86`）；`bg-zinc-850` 不存在（Tailwind v4 无此档），用 `zinc-800`。

## 六、业务约定
- ★ **Skill（2026-10-07 接入）**：框架侧契约 = `AgentRequest.skillConfig`（`SkillConfig{Path path}`）→ `DefaultConversationManager.loadSkill` → `skillLoader.load(config)` → `SystemPromptAssembler.withSkillPrompt` 渲染 `## Skill Prompt`（只给 name/description/入口路径），正文与引用资源靠内核工具 **`read_skill`** 读。业务侧落点：①配置 `lingxi.skill.dir`（默认 `${user.home}/.lingxi/skill`，置空即关闭）；②`SkillRootResolver` 启动时**把目录建出来**（框架 `FileSystemSkillLoader` 把「配了目录却不存在」判为**错误**而非空目录）；③`RequestPreparer.buildRequest` 与 `SubAgentRequestFactory` 各自下发 `skillConfig`；④`toolListOf`/`memberTools` 补 `ToolCatalog.READ_SKILL`（**名单即授权**，不补则提示词说了模型也调不动；必须在只读滤网**之前**补）。⚠️ 两个坑：`DefaultSkillResolver` 依赖 **commonmark**（经 `harness-runtime` 传递进来，compile scope，**不能移除**，否则没有 `SkillResolver` bean → 每次执行抛 `IllegalStateException`）；`read_skill` 默认开启（`matchIfMissing=true`，`lingxi.agent.runtime.tool.read-skill.enabled`）。`SkillConfig{Path}` 随执行快照往返安全（Jackson `NioPathSerializer`，守卫 `ExecutionJsonTest#skillRootSurvivesSnapshotRoundTrip`）。前端工具名已加 `AgentToolName.ReadSkill`。
- 邮箱：`email` 表 = 一轮协作里一个收件 Agent 的**角色邮箱**；业务键 `(workflow_execution_id, recipient_agent_id)`，唯一索引 `uk_email_workflow_recipient`。统一入口 `ExecutionAttributes.readLong`/`.workflowExecutionId`。投递只走 `EmailService.sendMail`。并发首建靠 `DuplicateKeyException`。
- 执行身份属性：新建走 `RequestPreparer.attributes()`；**恢复不经过 RequestPreparer**（`ChatServiceImpl#resume`、`ToolCallServiceImpl#decideDecision`、`CommandApprovalExecutor#finish`），必须调 `SessionAttributeRestorer.restore(execution, sessionId)`。`CallSubAgentTool#childAttributes` 下行 `TEAM_ID`。`TeamPromptComposer` 是话术唯一来源。
- 工具暴露面：`RequestPreparer.toolListOf` 在「未配清单 + 可写档位」时返回 null = 全部已注册工具。有身份前置条件的工具必须在 `#withoutUnusableCollaborationTools` 登记（`call_sub_agent` 需 TEAM_ID，`send_mail_to_agent` 需 AGENT_ID）。协作工具按角色显式授予：指挥者 `AgentWorkflowOrchestratorImpl#commanderTools`，成员 `CallSubAgentTool#memberTools`（只发信、绝不给委派）。默认 Agent = `ToolCatalog.DEFAULT_AGENT_TOOLS`。
- MCP 渐进式披露：① 提示词 `## MCP Tools` 只放 name+description；② `SearchToolExecutor` 命中后 `scope.disclose(name)`；③ 下一轮 `ModelRequestFactory.availableTools` 并入 `disclosedTools()`。两闸门故意不一致：`ModelRequestFactory`（给模型看）vs `DefaultToolExecutionManager.admissible`（scope 内一律放行）。
- **COMMAND 审批（v2 入口）**：`POST /tool-call/decisions` 按卡片类型分派，COMMAND 走 `VersionedToolCallDecisionService#decideCommand` → `CommandApprovalExecutor`。①APPROVE = T1 同事务写 {决策身份 + 摘要 + `attachOutput(commandOutcome(APPROVED,null,null))` + `markInProgress` + `beginApproval`} → 提交后异步执行命令 → T2 → 释放控制槽位 → 恢复；②REJECT = 单事务落定（槽位「用户拒绝，命令未执行」+ 结论 + checkpoint + 上下文 + `resumeCoordinator.accept`），**刻意不调 `commandRestorer.restore`**；③「执行中重发」靠**态一**（`isDecidedBy`）返回首次结论，**不需要改 schema**（结论写在 `rawOutput.outcome`，T2 才覆盖成实际输出）。⚠️ 固有窗口：T1 提交后、异步执行前崩溃 → 卡片永久 `IN_PROGRESS`、执行停 `RUNNING`，无自动恢复。⚠️ ANSWER-on-COMMAND 抛 `ClientException`(code 0) 而非机器错误码。
- ★ **恢复语义（只尝试一次）**：批准 = 「决策已落库，后端只尝试恢复一次」，启动失败即收口 FAILED，不重试 / 不退避 / 不轮询。`execution_resume_task` 退化为纯请求记录（无 attempts / next_attempt_at；状态只剩 READY/CLAIMED/SUCCEEDED/SUPERSEDED/FAILED），唯一用途是覆盖崩溃窗口。三个落点：①竞争失败判据 = `ExecutionActivity#isActive`（别匹配框架文案）；②运行阶段边界 = **落库状态是否离开 SUSPENDED**（框架 `RuntimeProcessorTemplate.process` 先 `resumeChecked()+save` 落 RUNNING 才进 loop）；③失败收尾 = `ExecutionControl.fail(...)`。⚠️ 抄 `PreparedChatExecutor#markStartupFailedQuietly` 的守卫时注意：它「SUSPENDED 一律跳过」是那个场景的口径，本场景必须允许 SUSPENDED→FAILED。`listUnfinished` 只捞 READY/CLAIMED。
- 挂起沿委派链传播：子执行 SUSPENDED → `CallSubAgentTool:222-226` 转父执行 `DELEGATION` PROMISE（载荷带 subSessionId）→ 父同步挂起 → 传到根。`kind=DELEGATION` 卡片不是人工审批卡（`ToolCallServiceImpl#decide` 对它抛错）。回填由 `DelegationBackfillListener`（异步 + 每父执行一把锁）做，`resumeIfReady` 收口「停止 vs 审批」竞态。
- 会话不继续执行的三道闸门（请求线程、用户消息落库前）：① `ChatServiceImpl#guardNotSuspended`；② `SessionExecutionRegistry#beginRoot` 单飞；③ `registerChild` 的 cancelled 检查。`stop` 四层覆盖：会话树 + `liveChildren` + `activeExecutionIds` + `Thread.interrupt()`。⚠️ `guardNotSuspended` 与 `ExecutionIdentity#latestSuspendedExecutionId`(67-74) 只查单个会话，多层委派的**孙会话挂起会漏判**；`root_execution_id` 是执行归属不是会话归属。`execution.snapshot` 反解全项目唯一一处：`LocalExecutionRepository:190`（只读场景一律不反解）。
- 本地联调：`.run/` 是 gitignore 本地目录；`user_configs.workspace_type=sandbox`、`model_config.id=4` 是真 DeepSeek key。
- 前端无「任务清单」（2026-10-02 整体删除）：后端无 `create_task_manifest`/`update_task`，**别再引入**；与「计划模式 / `create_plan` / `PlanCard`」区分。`UserConfigVO.planMaxReminders` 与任务清单无关。
- 压缩：本仓无独立内部摘要调用路径 —— 压缩是主模型工具调用（`ToolResultType.CONTEXT_COMPACT`，`AgentLoopStepRunner:103/231`）。

## 七、持久化 / 可移植性
- 零 XML mapper：全部 `BaseMapper` + LambdaQueryWrapper。零 MySQL 专有函数。
- JSON 列不依赖 DB JSON 类型：H2 下 6 个 JSON 列（`mcp.headers/env`、`tool_call.content/raw_input/raw_output/meta_data`）必须写 `TEXT`。
- 主键：`IdType.AUTO`（DB 自增，7 个 PO，含 team）；`IdType.INPUT`（雪花，session_message / session_context / email）。
- `update_time` 双写：DDL 有 `ON UPDATE CURRENT_TIMESTAMP`，代码另有 8 处显式 `.updateTime(...)`。
- `docker-compose.yml` 的 `redis:8` 是死配置（pom 无 redis 依赖）。
- ⚠️ **改列宽必须写迁移脚本，只改 init.sql 对已有库完全无效**（`CREATE TABLE IF NOT EXISTS` 不改已存在列）。`H2SchemaInitializer` 的既有能力只有「缺表 / 缺列 / 缺索引」，**加宽列是 V4 新增的 `columnSize(...)` 判定**（`hasColumn` + `COLUMN_SIZE < 目标` 才 ALTER，先判存在再判宽度：列整个缺失时不介入，否则 ALTER 会失败）。守卫 `H2SchemaMigrationTest#legacyNarrowTeamDescriptionColumnIsWidened`（fixture `team-legacy-schema.sql`，含金丝雀断言「旧列宽确实是 500」）。H2 2.3 的 `ALTER TABLE t ALTER COLUMN c VARCHAR(n)` 语法实测有效。
- ⚠️ **同一个上限写在三处**（前端 `useTeamsTab.ts` / 后端 `Team.MAX_DESCRIPTION_LENGTH` / `init.sql` 列宽）—— 团队描述曾漂成 500/1000/500，表现为「前端放行、后端也放行、最后在 DB 列宽上炸」。改任一处必须三处同步（代码里三处都留了互相指向的注释）。同类重复：团队名 100、成员数 10。

## 八、工程教训 / 本机环境
1. 守卫/断言类测试必须模拟干净环境（`git archive HEAD` / `git worktree`）再跑 —— git 不跟踪空目录。
2. 同批同模式改动必须全部检查，不能抽查一处。改并发代码时「移除锁条目」类方案要先想清竞态。
3. 在脏工作树上叠加改动前，先固化「改动前快照」（`git diff HEAD > .run/wip-backup-<日期>.patch` + 打包未跟踪文件），事后用 worktree 建基线复跑同一批测试，才能证明失败是既有的。
4. ⚠️ 界定「本次改了哪些文件」用 `find <dir> -newermt "<时间>"`，不要用 `diff -rq`（行尾符噪声污染）。
5. ⚠️ **grep 假阴性**：`grep`/`rg` 遇含 `NUL` 的文件判定为二进制并**静默跳过、且不报错**；且「扫一遍确认没有 X」的模式要覆盖**所有等价写法**（实例：`fail(.*retryAt` 匹配不到 `fail(reason, null)`）。凡结论是「不存在」，先用**故意包含该特征**的样本做金丝雀正对照，并确认扫描覆盖完整（递归子目录、路径写对）。
6. ⚠️ **验证纪律**：测试标题不是证据，只有变异是证据 —— 每修一处缺陷补一条能因回退变红的用例；等价变异不算验证。
7. ⚠️ 前端 `vue-tsc -b` 报出与改动面无关的类型错误时，先怀疑陈旧增量缓存：`rm -f frontend/node_modules/.tmp/*.tsbuildinfo` 再 `vue-tsc -b --force`。
8. ⚠️ **本机 `git push` 会卡死**：仓库 `credential.helper` 指向 PortableGit 的 `git-credential-manager.exe`，push 时实际拉起 `git-credential-helper-selector.exe` 等交互选择（`GIT_TERMINAL_PROMPT=0` 拦不住）。`git ls-remote` 不受影响（公开仓匿名可读），故「能 ls-remote 不能 push」正是这个症状。解法：`git -c credential.helper= -c credential.helper='!gh auth git-credential' push origin <branch>`（先 `gh auth status` 确认已登录且带 `repo` scope）。别用 `gh auth setup-git` 改全局配置。
9. ⚠️ 长耗时命令（`git push`、`mvn test`）用后台跑并让通知回报；前台超时会被 SIGTERM 打断，表现为「无输出 + Signal: SIGTERM」，容易被误判成网络问题。
10. ⚠️ **本机环境事实**：`uv`/`uvx` 装在 `C:\Users\summit\.local\bin`（uv 0.12.19），**已追加进用户级 PATH**（MCP 的 stdio 服务用 `uvx <pkg> serve` 启动，PATH 缺这条就报 `Cannot run process "uvx"`）。改 PATH 用 `[Environment]::SetEnvironmentVariable(...,'User')`，**别用 `setx`**（1024 字符截断）。⚠️ 本机排查环境：`reg.exe` 被沙箱黑名单拦截；**PowerShell 工具不回显 stdout**，要它输出就写文件再读。
