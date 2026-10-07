# LingXi 项目长期记忆（2026-10-06 重整）

## 一、架构：纯 H2 单库 + 配置 YAML 化
- MySQL 已退役。`application.yaml`：`jdbc:h2:file:${lingxi.data.dir:${user.home}/.lingxi/data}/lingxi;MODE=MySQL`（sa/空密码），无 `spring.profiles.active`。数据目录 = 配置项 `lingxi.data.dir`（`-D` / `LINGXI_DATA_DIR` 可覆盖）；`/config/current` 的 `dataStorage` 由 `UserConfigServiceImpl` 用 `@Value` 只读回显。
- 配置 YAML 化：mcp / model / user_configs 走 `AbstractYamlRepository` + `YamlListStore`（`shared/infrastructure/yaml`），落 `~/.lingxi/config/{mcp,models,user-configs}.yaml`；DB 表**仅作首次迁移来源**，**别再往这几张表加列**。落盘走 `AtomicFileWriter`（`.ddd-*.tmp` → `ATOMIC_MOVE`）；事务内暂存内存、`afterCommit` 才写，回滚即丢。
- 文件落点：`~/.lingxi/config/*.yaml`（3）+ `~/.lingxi/data/lingxi.mv.db`（11 表）；Electron `userData` 放 `logs/backend.log` 并作后端 cwd；用户工作空间 = `workspace.host_dir`。
- `MODE=MySQL` 刻意保留：init.sql 仍 MySQL 方言，`ON UPDATE CURRENT_TIMESTAMP` 生效（业务零处显式 setUpdateTime）；`MybatisPlusConfig` 硬编码 DbType.H2。
- `init.sql` 是唯一 DDL 真源（14 表）；`InitSqlPoConsistencyTest` 校验它与 PO 一致 —— 红就补 init.sql。`H2SchemaInitializer` 全环境生效。
- ⚠️ 未决：无迁移机制 —— 缺表即整库重建、存量数据丢失；桌面端升级必须补迁移脚本。

## 二、框架（D:\code\starter，只读）
- 挂起原语只有 `ToolExecuteResult.promise()`；runner 提交整批工具结果后返回 `LoopResult.SUSPENDED`（协作式、不阻塞线程）。ADR `loop-suspension-boundary.md`：PROMISE 只表达 loop 控制，框架不提供提问/审批/超时编排。
- SPI：`ExecutionControl` + `ActiveExecutionRegistry` + `ExecutionControlSignal`(NONE/REQUIRE_SUSPEND/REQUIRE_CANCEL) + `ExecutionRepository extends ActiveExecutionRegistry`。
- 陷阱：框架 finally 用 `List.copyOf` 冻结 `execution.messages`（`RuntimeProcessorTemplate:81`）；恢复必须 `resume(Execution)`，`resume(String)` 是禁用副本。
- 扩展点：~40 SPI、19 个 `@ConditionalOnMissingBean`、8 个 `List<T>` 收集点。MCP 是唯一开箱即用扩展（`lingxi.mcp.*`，仅 streamable-http）。注册工具：声明 `ToolDefinition<? extends ToolExecutor>` bean，`CommonToolAutoConfiguration.toolRegistry(List<...>)` 收集。
- ⚠️ 应用 bean 不可把默认实现作为注入依赖，必须在 `@Bean` 方法内 `new`。
- 不原生支持多节点：内核无状态，但控制信号/事件/准入/后台任务均进程内；生产代码零 static 可变字段、零 ThreadLocal。

## 三、SSE 语义与 v3 迁移（改 SseEventPublisher / 前端订阅前必读）
- ⚠️ `./mvnw` 本机坏了（wrapper Permission denied）。后端测试用系统 `mvn -o test -DfailIfNoTests=false`（`D:\languages\mvn`，3.9.16 + JDK 21）。前端 `cd frontend && npm test`。
- ⚠️ **2026-10-06 更正（前端架构已变，先核实再动手）**：前端**已无会话级订阅** —— `stores/sseRouter.ts`、`utils/sse.ts`、`streamV3*` 在工作树里已 **deleted**；现网唯一 SSE 消费者是 `useChatSending.ts:89` 的**请求级** `POST /a/completion/stream`。后端 `GET /a/completion/{sessionId}/events`（`ChatServiceImpl#subscribeSession`，只订阅不执行、可重复调用）仍在，但**前端零调用**。v2 决策 `POST /tool-call/decisions` 是 **JSON 回执、不建流**。以下会话级 / v3 描述为 2026-10-04 快照，可能已失效。
- 流是**会话级**（历史描述）：sessionId 须按 `ExecutionIdentity.rootSessionIdOfSession` 归到根会话；服务端**不做回放、不发 gap**，别再加序号/日志/回放。
- ⚠️ `ChatServiceImpl.resume` **不建流** → 恢复后整轮事件无订阅者。新增「触发执行」入口必问：这条执行的事件谁在听？
- ⚠️ 写失败不是告警：终态事件先于 clear 的收尾用量推送发出 →「最后那条用量推送写不出去」每轮都发生。`AsyncRequestNotUsableException` 继承 IOException，`catch (IOException)` 会误当故障打 WARN+堆栈。现行：DEBUG（只打最内层 cause）+ 摘掉该 emitter。
- ⚠️ v3 迁移仍断链（2026-10-04 核查）：`sseRouter.sessionStreamUrl` 已固定 `?schemaVersion=3`，但 v3 前端入口 `streamV3Sync.ts#attachStreamV3` **零调用方**；实时消费仍是 `useChatView → messageRouter.routeToSession`（词表 `COMPLETE_TEXT`/`AI_MESSAGE`/`CARD_PENDING`）→ v3 帧被静默丢弃。别删 v2/v1。
- 后端 v3 生产链已补齐（2026-10-04）：`CommittedStateChange` 带不可变 `payload`；三个仓储写库后带落库终值快照；`CommittedStateV3Observer`（`stream/infrastructure/listener/`）零查询直投 v3（MESSAGE/TURN/SESSION/HISTORY 四类，覆盖 11/11）。测试 `CommittedStateV3DeliveryTest`。⚠️ 实体直接作 payload（无 VO 层），靠 `JsonConfig` 的 Long→字符串序列化。
- 压缩：本仓无独立内部摘要调用路径 —— 压缩是主模型工具调用（`ToolResultType.CONTEXT_COMPACT`，`AgentLoopStepRunner:103/231`）。

## 四、前端 SSE 路由与实时渲染层
- ⚠️ `stores/sseRouter.ts` **已在工作树删除**（以下为其历史职责：连接按根会话保管、组件订阅/退订不影响流存在、只做建/复用/关连接 + 分发、订阅表与连接表分开、键一律根会话 ID）。当前前端只消费请求级流。
- `utils/sse.ts#readSseResponse` 的 `stopOnTerminal` 缺省 true，**会话级订阅必须传 false**。
- ⚠️ **会话实体上的 `rootSessionId` 有「哨兵 0」**：`Session.ROOT_SESSION_ID=0L` + `SessionVO.rootSessionId` 走 `ToStringSerializer` → 根会话下发的是**字符串 `"0"`**（非 null）。解析订阅键一律走 `utils/session.ts#resolveRootSessionId(session)`（temp→null；`declared && declared !== '0' ? declared : id`），**不得再写 `rootSessionId != null ? ... : id`** —— `"0"` 非 null，会拼出 `GET /a/completion/0/events` → 后端 `resolveRootSessionId(0)` 抛 `IllegalStateException: Unknown session: 0` → 兜底 handler 报 **HTTP 500**。该规则曾在三处重复、两处写错；守卫 `singleSessionStream.test.ts#1c`。注意 `SessionTreeVO.rootSessionId` 是**真根 id**，永不为 0，别混用。
- `ChatServiceImpl#subscribeSession` 已加入口校验 `throwIf(sessionId == null || sessionId <= 0, "会话标识不合法")`（守卫 `ChatSubscribeSessionIdTest`）。`ExecutionIdentity.resolveRootSessionId` 仍抛 `IllegalStateException`（内部调用方需要），故**合法但不存在的会话 id 仍会 500** —— 未决。
- ⚠️ 尚未迁移：`useChatView.ts` 仍自持 AbortController，`chatStreamService.sendMessageStream` 仍自建流。前端无测试框架，只能 `npm run build` 兜类型。
- ⚠️ 同一轮次只允许一条 assistant 气泡：`applyStreamMessage` 按 id 合并，审批恢复流气泡钉本地 id（`msg-bot-resume-*`），`chatSessionStore#initTurn` 复用的却是该轮既有气泡 → 必须再按 **turnId** 兜底归并（`mergeAuthoritativeMessages` 无条件保留 `isComplete===false`）。`chatSessionStore` 只有 `initTurn`。
- ⚠️ reducer 绝不能捕获 `session.messages` 裸数组引用：`useChatHistory#reconcileSessionAfterStream`/`handleLoadMoreHistory` 整体替换 `cur.messages`/`cur.subSessions`；`useChatSessionList#handleSelectSession` 用 `{...old, ...detail}` 替换整个 session。故 `TurnStreamReducer` 入参是 `ChatMessage[] | (() => ChatMessage[])`，一律走 `getMessages()`；`streamSessionRouter#bindRootSession` 同 id 也必须先更新 `currentRootSession` 再复用 reducer。违反即复现「第二条用户气泡要等 AI 完成才出现」。
- 回答气泡工具条（token/耗时/模型/状态）权威源 = `session.turns`（`Record<turnId, ChatTurn>`），绑定走 `utils/session#buildMessageTurnMap`；分组唯一规则 `groupMessagesByTurn`。历史接口每页返回 `turns`，**必须 `mergeTurns` union 进 `session.turns`**。null=未采集→「暂无统计」，绝不显示 0。
- 回归面：`frontend/tests/{streamRendering,crossPageTurn,frontendRenderFix,promiseCard,chatLiveRenderFixes,qaIndependentVerification}.test.ts`。`npm test` 有 4 条既有失败（`reasoningEffort.test.ts` 调未导出的 `syncReasoningEffort`），且脚本 `&&` 串联致末尾原生测试被跳过；`npm run build` 本机需 `CODEBUDDY_SAFE_DELETE_ENABLED=0`。

## 五、人工在环卡片（PROMISE）契约
- 后端 `com.summit.dp.toolcall` 权威：`content.kind` = PLAN`{title,text}` / CHOICE`{question,options[]}` / COMMAND`{command,workDir,shell,intention?}`；`allowedActions` PLAN/COMMAND→APPROVE|REJECT、CHOICE→ANSWER；★唯一可审批判定 **`type==='PROMISE' && status==='pending'`**。决策 `POST /tool-call/decisions`（`commandId` 幂等 + `expectedVersion` 冲突），权威查询 `GET /tool-call/{toolCallId}`。
- 前端唯一映射点 `utils/toolCallCard.ts`：`resolveCardKind` 对缺失/非法/EXECUTE **恒降级 UNAVAILABLE，绝不回落 COMMAND**；`canDecideCard(card,action)` 是按钮门控（`pending===true && allowedActions.includes(action)`）。
- 双路径建卡：历史 `utils/session.ts` 对 `type==='PROMISE'` 把权威 `ToolCallVO` 存进 `asst.promptCards`；实时 `turnStreamReducer#resolvePromptCard` 经 `onResolveCard`（=`chatApi.fetchToolCall`）拉 VO，有 `type!=='PROMISE'` 守卫。**改任一路必须同步另一路**。
- 卡片渲染在过程折叠区之外（`ChatMessageItem.vue` 约 397-446）；待决卡整卡展开、折叠/关闭 `v-if="isResolved"`（待决态不可移除）；已决卡收成摘要行。外壳/色板 `utils/cardUi.ts`，header `CardHeader.vue`，按钮 `CardActionButton.vue`。
- ⚠️ `scrollbar-thin` 是**有效**类（`src/style.css:78-86`）；`bg-zinc-850` 未定义 token（Tailwind v4 无此档），已改 `zinc-800`。

## 六、前端过程时间线 order 契约
- `order` 是前端自造的跨集合排序键：`aggregateSessionMessages` 把扁平行分桶进 `thoughtSteps`/`toolCalls`/`aiMessages`，跨类型先后丢失 → 用 `order` 编码回原始行位置，`ChatMessageItem#processTimeline` 按它排序。
- ⚠️ 三条集合必须同基准：历史回放统一 `rowIndex * TIMELINE_SLOT_STRIDE`（`utils/session.ts`，行内 +0 思考 / +1 中间文本 / +2+tIdx 工具；stride=100）。实时流另一套编码 `getNextOrder = max+1`，两者不可混进同一气泡。
- 「终结轮次 = 该轮无工具调用」的文本才是正文；`call_sub_agent` 折叠成「团队协作」banner（钉首个委派 order）。

## 七、业务约定
- 邮箱：`email` 表 = 一轮协作里一个收件 Agent 的**角色邮箱**；业务键 `(workflow_execution_id, recipient_agent_id)`，唯一索引 `uk_email_workflow_recipient`。统一入口 `ExecutionAttributes.readLong`/`.workflowExecutionId`。投递只走 `EmailService.sendMail`。并发首建靠 `DuplicateKeyException`。
- 执行身份属性：新建走 `RequestPreparer.attributes()`；**恢复不经过 RequestPreparer**（`ChatServiceImpl#resume`、`ToolCallServiceImpl#decideDecision`、`CommandApprovalExecutor#finish`），必须调 `SessionAttributeRestorer.restore(execution, sessionId)`。`CallSubAgentTool#childAttributes` 下行 `TEAM_ID`。`TeamPromptComposer` 是话术唯一来源。
- 工具暴露面：`RequestPreparer.toolListOf` 在「未配清单 + 可写档位」时返回 null = 全部已注册工具。有身份前置条件的工具必须在 `#withoutUnusableCollaborationTools` 登记（`call_sub_agent` 需 TEAM_ID，`send_mail_to_agent` 需 AGENT_ID）。协作工具按角色显式授予：指挥者 `AgentWorkflowOrchestratorImpl#commanderTools`，成员 `CallSubAgentTool#memberTools`（只发信、绝不给委派）。默认 Agent = `ToolCatalog.DEFAULT_AGENT_TOOLS`。
- MCP 渐进式披露：① 提示词 `## MCP Tools` 只放 name+description；② `SearchToolExecutor` 命中后 `scope.disclose(name)`；③ 下一轮 `ModelRequestFactory.availableTools` 并入 `disclosedTools()`。两闸门故意不一致：`ModelRequestFactory`（给模型看）vs `DefaultToolExecutionManager.admissible`（scope 内一律放行）。
- 三条人工在环链路：命令审批（`CommandPolicyConfig`）/ plan（`CreatePlanTool`）/ choice（`RequireChoiceToolExecutor`）。
- ★ **恢复语义（2026-10-07 重构，取代旧的「落库退避+巡检重投」）**：批准 = 「决策已落库，后端**只尝试恢复一次**」，启动失败即收口 `FAILED`，不重试/不退避/不轮询。`execution_resume_task` 退化为纯请求记录（无 `attempts`/`next_attempt_at`；状态只剩 `READY/CLAIMED/SUCCEEDED/SUPERSEDED/FAILED`），唯一用途是覆盖崩溃窗口 —— 重启后区分「正常等审批的 SUSPENDED」与「已批准但恢复没起步的 SUSPENDED」。三个落点：① 竞争失败判据 = `ExecutionActivity#isActive`（别匹配框架 `"execution is already running"` 文案）；② 运行阶段边界 = **落库状态是否离开 SUSPENDED**（框架 `RuntimeProcessorTemplate.process` 先 `resumeChecked()+save` 落 RUNNING 才进 loop），异常后重读判「框架是否已接管」——这是「loop 已跑完、回写上下文抛异常不得改判失败」的护栏；③ 失败收尾 = `ExecutionControl.fail(execution, cause).run()` 一条链（落终态 → 仓储提交后通知轮次收口+清未决工具 → 发终态事件），**业务侧不要手写轮次收口**。⚠️ 抄 `PreparedChatExecutor#markStartupFailedQuietly` 的守卫时注意：它「SUSPENDED 一律跳过」是那个场景的口径，本场景必须允许 SUSPENDED→FAILED（`failChecked` = `requireNotTerminal`，只拦终态），否则 req「已批准但启动失败要收口」不可达。
- 挂起沿委派链传播：子执行 SUSPENDED → `CallSubAgentTool:222-226` 转父执行 `DELEGATION` PROMISE（载荷带 subSessionId）→ 父同步挂起 → 传到根。`kind=DELEGATION` 卡片不是人工审批卡（`ToolCallServiceImpl#decide` 对它抛错）。回填由 `DelegationBackfillListener`（异步 + 每父执行一把锁）做，`resumeIfReady` 收口「停止 vs 审批」竞态。
- 会话不继续执行的三道闸门（请求线程、用户消息落库前）：① `ChatServiceImpl#guardNotSuspended`；② `SessionExecutionRegistry#beginRoot` 单飞；③ `registerChild` 的 cancelled 检查。`stop` 四层覆盖：会话树 + `liveChildren` + `activeExecutionIds` + `Thread.interrupt()`。
  - ⚠️ 薄弱点：`guardNotSuspended` 与 `ExecutionIdentity#latestSuspendedExecutionId`(67-74) 只查单个会话，多层委派的**孙会话挂起会漏判**。`root_execution_id` 是执行归属不是会话归属。
  - `execution.snapshot` 反解全项目唯一一处：`LocalExecutionRepository:190`（`findById`）。只读场景一律不反解。
- 重构进行中：`tool_call` 表 + `ToolCall` 充血模型 + `ToolCallRegistrar` 替换 `interaction_status`；旧链路在 `interaction/application/service/impl/deprecated/`。
- 本地联调：`.run/` 是 gitignore 本地目录；`user_configs.workspace_type=sandbox`、`model_config.id=4` 是真 DeepSeek key。
- 前端无「任务清单」（2026-10-02 整体删除）：后端无 `create_task_manifest`/`update_task`，**别再引入**；与「计划模式 / `create_plan` / `PlanCard`」区分。`UserConfigVO.planMaxReminders` 与任务清单无关。

## 八、持久化 / 可移植性
- 零 XML mapper：全部 `BaseMapper` + LambdaQueryWrapper。零 MySQL 专有函数。
- JSON 列不依赖 DB JSON 类型：H2 下 6 个 JSON 列（`mcp.headers/env`、`tool_call.content/raw_input/raw_output/meta_data`）必须写 `TEXT`。
- 主键：`IdType.AUTO`（DB 自增，7 个 PO，含 team）；`IdType.INPUT`（雪花，session_message / session_context / email）。
- `update_time` 双写：DDL 有 `ON UPDATE CURRENT_TIMESTAMP`，代码另有 8 处显式 `.updateTime(...)`。
- `docker-compose.yml` 的 `redis:8` 是死配置（pom 无 redis 依赖）。

## 九、工程教训
1. 守卫/断言类测试必须模拟干净环境（`git archive HEAD` / `git worktree`）再跑 —— git 不跟踪空目录。
2. 同批同模式改动必须全部检查，不能抽查一处。
3. 改并发代码时「移除锁条目」类方案要先想清竞态。
4. 在脏工作树上叠加改动前，先固化「改动前快照」（`git diff HEAD > .run/wip-backup-<日期>.patch` + 打包未跟踪文件），事后用 worktree 建基线复跑同一批测试，才能证明失败是既有的。
5. ⚠️ `diff -rq` 比对两个工作树会被行尾符噪声污染；界定「本次改了哪些文件」用 `find <dir> -newermt "<时间>"`。
6. ⚠️ 前端 `vue-tsc -b` 报出与改动面无关的类型错误时，先怀疑陈旧增量缓存：`rm -f frontend/node_modules/.tmp/*.tsbuildinfo` 再 `vue-tsc -b --force`。
7. ⚠️ **本机 `git push` 会卡死**：仓库 `credential.helper` 指向 PortableGit 的 `git-credential-manager.exe`，push 时实际拉起 `git-credential-helper-selector.exe` 等待交互选择，进程挂着零输出（`GIT_TERMINAL_PROMPT=0` 也拦不住，它拦的是终端提示不是 helper）。`git ls-remote` 不受影响（公开仓匿名可读），所以「能 ls-remote 不能 push」正是这个症状。解法：改用 `gh` 的凭据 —— `git -c credential.helper= -c credential.helper='!gh auth git-credential' push origin <branch>`（先 `gh auth status` 确认已登录且带 `repo` scope）。别用 `gh auth setup-git` 改全局配置。
8. ⚠️ 长耗时命令（`git push`、`mvn test`）用后台跑并让通知回报；前台超时会被 SIGTERM 打断，表现为「无输出 + Signal: SIGTERM」，容易被误判成网络问题。
9. ⚠️ **grep 假阴性**：「扫一遍确认没有 X」时，模式要覆盖**所有等价写法**。实例：`fail(.*retryAt` 匹配不到 `fail(reason, null)`，据此删掉 `fail(String, Instant)` 后编译才报错 —— 真正有效的做法是先用编译器/测试兜一遍，或按方法名而非实参形状搜（`grep -rn "\.fail("`）。同源教训见 §提交前自检的「金丝雀正对照」。
