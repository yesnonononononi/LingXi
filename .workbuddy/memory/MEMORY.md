## 一、架构铁律（LingXi）
- 单实例：LocalInstance.ID="local"；禁 userId=1；common_config 按行 save/updateById；身份随 ExecutionContext(attributes) 流动，无 ThreadLocal；对外 agentId=common_config.agent_id(可空)
- 委派 teamId 走 ExecutionAttributes.TEAM_ID 随快照流动（TeamContext 已删）；API Key 明文存 model_config；快照 formatVersion=2 含 Key，旧版拒恢复
- SSE 按 rootSessionId（broadcast 已删禁复活）；root_session_id==0/null=自身即根；chatStream 顺序 prepare→connect→beginRoot 固定
- 已删禁引用：auth/UserContext/interaction 全族（包名 dp.interaction→dp.toolcall）/Redis/JJWT/Kafka；迁移脚本在 `src/main/resources/db/manual/`
- 业务失败一律 `throw new ClientException(message)` → GlobalExceptionHandler → `Result.error`；`Result` 只用于成功返回。特殊子类：`AccessDeniedException`(403)、`SessionNoFoundException`/`WorkspaceNoFoundException`(403)
- 持久化：PO+BaseMapper+RepositoryImpl(Lambda Wrapper)，禁 JDBC；新 PO 登记 `InitSqlPoConsistencyTest.PO_CLASSES`；新模块先 DddCodeGenerator；雪花 id 用 IdUtil；禁 var；方法体禁全类名；仓储接口 RepositoryTemplate / 实现 AbstractRepository
- 前端：`utils/api.ts` SUCCESS_CODES=[1]；检查铁律 `vue-tsc -b --force`(零输出) + `vite build`

## 二、tool_call
- 包 `com.summit.dp.toolcall.*`；两表：session_message（TOOL 行 content 只存 call_id）+ tool_call（id=call_xxx，status 仅 pending/in_progress/completed，无 FAILED）
- JSON 键真源 = `ToolCallKeys` 禁裸串；`content.kind ∈ {PLAN,CHOICE,COMMAND}` 判别；结论只写 `raw_output.outcome` 枚举；可审批唯一判定 `type==='PROMISE' && status==='pending'`
- 写入唯一入口 `ToolCallRegistrar`（幂等 UPSERT，EXECUTE 升级 PROMISE/pending 同 id）；读 = 批量 message → 去重 → 一次 IN（缺行降级）
- SSE：`CARD_PENDING{rootSessionId,toolCallId,cardKind}`；`EXECUTION_RESUMED` 必须先于 resume 发布
- 事务：PLAN/CHOICE 单事务；COMMAND 两段式（T1 先于外部副作用，块在 CommandApprovalExecutor）；execution 禁 import toolcall，走 ExecutionLifecycleListener+Adapter

## 三、会话与执行（09-28 ~ 09-30）
- chat/chatStream 请求已无 teamId；`RequestPreparer.effectiveTeamId = session==null?null:session.getTeamId()`；team 变更唯一入口 `POST /session/{id}/team?teamId=`（null=解绑），create 也接受 teamId
- 坑1：`SessionPO.teamId` 必须 `@TableField(updateStrategy=FieldStrategy.IGNORED)`，否则 MP updateById 跳 null → 解绑静默失效
- 坑2：`SessionAttributeRestorer.restore` 在 team 为 null 时必须 `attributes.remove(TEAM_ID)`（清陈旧快照），不能直接 return
- 前端 team 同步唯一落点 `useChatView.handleUpdateTeam`
- `session.status` 已整体删除（09-28）；运行态唯一来源 execution 表。session 经 `ExecutionQueryService.latestStatesBySession` 读（禁多表联查，内存聚合+一次批量 IN），组合 `runStatus`(IDLE/RUNNING/SUSPENDED)+`lastOutcome`(COMPLETED/FAILED/CANCELLED 可空)，唯一落点 `SessionServiceImpl.runStatusOf/lastOutcomeOf`；前端词表唯一落点 `utils/subSessionStatus.ts`
- execution.status 编码：0创建/1运行/2暂停/3完成/4失败/5取消（权威 `LocalExecutionRepository.statusOf`，非 ordinal）
- 单飞：`SessionExecutionRegistry.beginRoot` 已 rootRunning 时抛 ClientException("该会话正在执行中")；`cancelRoot` 必须同时清 rootRunning；`beginRoot` 在请求线程（prepare 后、connect 前）
- 启动收尸 `ExecutionStartupReaper`(ApplicationReadyEvent)：execution `status IN(0,1)`→FAILED，SUSPENDED/终态不动
- **session.agent_id（09-30 新增列，idx_root_agent）**：子会话复用键 = `(root_session_id, agent_id)`，唯一入口 `SessionRepository.findByRootAndAgent`（ORDER BY id DESC LIMIT 1）；`CallSubAgentTool.resolveTarget` 命中则复用同子会话、不建行，历史经 `buildRequest(..., priorMessages)`；`SUB_AGENT_SESSION_CREATED` 两条路径必发；`SessionVO.agentId = session.getAgentId()`（子会话=真实子 Agent，根=null）

## 四、SSE 消息模型（09-29 定案）
- **`AI_MESSAGE` = 一个模型轮次结束**（工具调用轮也会发，`text` 为 null）。消费方必须先判 `event.text` 空，禁止 `event.text ?? currentTurnText` 兜底
- aiMessages 落盘唯一入口：`services/chat.ts` / `chatStream.ts` 的 `appendAiMessage(target,text,thinking)`（text 空 return；相邻同文本忽略）。实时 + EXECUTION_RESUMED 恢复共四条路径共用，不得裸 push
- 渲染契约：`message.content` = 正文；`ChatMessageItem.intermediateAiMessages` = 「文本 ≠ content 且全数组去重」的其余条目（**不是** `slice(0,-1)`）

## 五、email
- 两聚合 Email/EmailMessage；时间字段 createAt/updateAt 对齐 DDL
- 批量消费 `POST /email/message/consume-batch?executionId=&agentId=`：条件 UPDATE(where status='PENDING') 按 affected 判定，不足抛 ClientException；匹配 = agent 必中 + root/target 任一
- **@Builder 单全参构造 PO 禁单列投影**（列序自动映射 IndexOutOfBounds），全列查后 map；del 级联删消息；consume 单向状态机

## 六、git 与框架仓（细节见 skill `lingxi-harness-conventions`）
- LingXi 本地与远程曾是两条无共同祖先历史；09-30 已按用户决策「本地覆盖远程」强推：LingXi `feature/agent`（cdea3fb）、框架仓 `develop`（205f20c）
- **备份 tag 禁删**（本地+远程都有）：`backup/remote-feature-agent-before-force`（f6b18bd，含 auth 全族）、`backup/remote-develop-before-force`（8546686）、`backup/remote-main-before-force`（ca7a423）
- 框架源码根 = `D:\code\starter\lingxi-harness-agent`（**自身即仓库根**，用 `git rev-parse --show-toplevel` 判断，别只看上层目录）；remote=github.com/yesnonononononi/lingxi-harness-starter
- 提交/推送需用户明确要求（AI 不主动提交、不跑 mvn install）；框架侧改动需用户自行 install
- 幽灵 blob 症状：`git commit` 报 `invalid object ... Error building trees`；修法 `git hash-object -w <file>` 强制写回对象库（单纯 `git add` 无效）

## 七、MCP（细节见 skill `lingxi-harness-conventions` §2）
- 排查 MCP 异常先确认运行时挂的是框架 1.1.0（`com.summit.core.conf.McpConfig` 仅 1.1.0 有）
- Windows stdio `command` 必须 `npx.cmd`，`npx` 会静默降级丢全部工具
- `McpClientFactory` 必须关 `subscribeTo{Tool,Prompt,Resource}ListChanges`（404 噪音根治），禁复活
- 渐进披露：提示词 `### MCP Prompt` + `- <name> count: <n>`；`list_mcp_tools` 列名**不揭露**；`search_tool` 返 schema **并揭露**
