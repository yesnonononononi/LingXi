
## 一、单实例（09-27）
- LocalInstance.ID="local"；禁 userId=1；common_config 按行存在分支 save/updateById；身份随 attributes 流动（ExecutionContext record，无 ThreadLocal）；对外 agentId=common_config.agent_id（可空）
- 委派 teamId 走 ExecutionAttributes.TEAM_ID 随快照流动（TeamContext 已删）
- API Key 明文存 model_config；ModelResolver 四级→ClientException；快照 formatVersion=2 含 Key，旧版拒恢复
- SSE 按 rootSessionId（broadcast 已删禁复活）；root_session_id==0/null=自身即根；chatStream 顺序 prepare→connect→beginRoot 固定
- 迁移脚本在 `src/main/resources/db/manual/`；MP 分页内核在伴生包 mybatis-plus-jsqlparser（删了静默 total=0）；分页测试配 PaginationInnerInterceptor(DbType.H2)；ModelContextService.replace 是 upsert
- 已删禁引用：auth/UserContext/interaction 全族（包名 dp.interaction→dp.toolcall）/Redis/JJWT/Kafka

## 二、tool_call
- 包 com.summit.dp.toolcall.*；两表：session_message（TOOL 行 content 只存 call_id）+tool_call（id=call_xxx、status 仅 pending/in_progress/completed 无 FAILED）
- JSON 键真源=ToolCallKeys 禁裸串；content.kind∈{PLAN,CHOICE,COMMAND} 判别；结论只写 raw_output.outcome 枚举禁嗅探；可审批唯一判定 type==='PROMISE'&&status==='pending'
- 写入唯一入口 ToolCallRegistrar（幂等 UPSERT，EXECUTE 升级 PROMISE/pending 同 id）；EXECUTE 结果只挂 RuntimeListener.onToolCallOutput；读=批量 message→去重→一次 IN 查（缺行降级）
- SSE：CARD_PENDING{rootSessionId,toolCallId,cardKind,...}；EXECUTION_RESUMED 必须先于 resume 发布（resume 阻塞至下一挂起点，resume(String) 禁用）
- 事务：PLAN/CHOICE 单事务；COMMAND 两段式（T1 先于外部副作用，块在 CommandApprovalExecutor）；execution 禁 import toolcall，走 ExecutionLifecycleListener+Adapter

## 三、会话（09-28 / 09-29）
- **session.team_id 已改为可变（09-29）**：不再"仅创建时绑定"。变更唯一入口 `POST /session/{id}/team?teamId=`（`SessionService.bindTeam`，null/缺省=解绑）；`/session/create` 也接受 teamId（首绑）。`SessionCommand/SessionRequest` 的 teamId 不参与 `update()`（null 无法区分"不改"与"解绑"）
- **chat/chatStream 请求已无 teamId**：`ChatRequest`/`ChatCommand` 该字段已删。`RequestPreparer.effectiveTeamId = session==null ? null : session.getTeamId()`——**新会话首轮无团队绑定**（前端建会话时随 create 参数落库）；前端 `createChatForm` 已去掉该字段
- **坑1（必看）**：`SessionPO.teamId` 必须 `@TableField(updateStrategy = FieldStrategy.IGNORED)`，否则 MP `updateById` 跳过 null → **解绑静默失效**（领域已 null、库里仍旧值）
- **坑2**：`SessionAttributeRestorer.restore` 在会话 team 为 null 时必须 `attributes.remove(TEAM_ID)`（清快照陈旧值），不能直接 return，否则"解绑后恢复仍按旧队委派"
- **前端同步落点唯一**：`useChatView.handleUpdateTeam`（下拉框 `updateTeam` 事件 + 新建团队都走它）。仅已有会话才落库；空/临时会话只改本地，等 create 时随参数绑定。`ChatView.vue` 的 `@updateTeam` 已从 inline 赋值改为该 handler
- session.team_id 仅 initialize 首轮写入不可变
- 前端流治理：流归属快照+引用计数；decide 接管先 abort 原流；详见 09-28 日报
- **session.status 已整体删除（09-28 技术债偿还）**：会话不持执行状态；过程状态唯一归属 execution 表（框架循环独占写）。已删 SessionStatus 枚举 / Session.status / SessionPO.status / SessionRepository#updateStatus+resetNonIdleStatus / SessionStatusStartupReset / init.sql 列。移植残留见 `db/manual/20260928_drop_session_status_column.sql`（观察期≥1周后人工执行，**未执行**）
- **运行态改查询组合**：session 经 `ExecutionQueryService.latestStatesBySession(sessionIds)` 读 execution（**禁多表联查，内存聚合+一次批量 IN**，禁 select snapshot），组合为 `runStatus`(IDLE/RUNNING/SUSPENDED) + `lastOutcome`(COMPLETED/FAILED/CANCELLED 可空)，**两字段独立可同时非空**（「上轮 FAILED + 本轮 RUNNING」）。组合唯一落点 SessionServiceImpl.runStatusOf/lastOutcomeOf；前端词表唯一落点 `frontend/src/utils/subSessionStatus.ts`
- **单飞校验**：`SessionExecutionRegistry.beginRoot` 已 rootRunning 时抛 ClientException("该会话正在执行中")；`cancelRoot` 必须同时清 rootRunning（否则 stop 后永久锁死）；`beginRoot` 在请求线程（prepare 后、connect 前）
- **启动收尸**：`ExecutionStartupReaper`(ApplicationReadyEvent) 条件更新 execution `status IN (0,1)`→FAILED；SUSPENDED(2)/终态绝不动。execution.status 编码：0创建/1运行/2暂停/3完成/4失败/5取消（权威 `LocalExecutionRepository.statusOf`，非 ordinal）

## 四、规范铁律
- CommandGuard 唯一入口 assess==DESTRUCTIVE；持久化 PO+BaseMapper+RepositoryImpl（Lambda Wrapper）禁 JDBC；禁 var；新 PO 登记 InitSqlPoConsistencyTest.PO_CLASSES
- AGENTS.md 六条：领域更新 change 非 final 字段+常量校验入模型；service if(command.getX()!=null) model.changeX()+updateById()；方法体禁全类名；业务错统一抛 ClientException（**允许带 message 区分原因**，不必只用无参构造；**禁 `return Result.error(...)` 表达业务失败**）；仓储接口 RepositoryTemplate/实现 AbstractRepository；新模块先 DddCodeGenerator；雪花 id 用 IdUtil
- **业务失败一律 throw，不走返回值**：`ClientException(message)` → `GlobalExceptionHandler.handleClientException` → `Result.error(e.getMessage())`，HTTP 200 + code≠1 + errMsg 透给前端 `isOk()` 判定与展示。`Result` 只用于**成功**返回（`Result.success(...)`）。这样 service 方法签名才表达得出「失败」，调用方也不会漏判返回值。
  - 无参 `ClientException()` 仅用于「原因无需区分」的兜底（如 `orElseThrow(ClientException::new)`）；凡是调用方/用户需要区分的，必须带 message
  - 特殊语义另立子类并由专用 handler 接管：`AccessDeniedException`（403）、`SessionNoFoundException`/`WorkspaceNoFoundException`（403）
  - 前端侧：`utils/api.ts` `SUCCESS_CODES=[1]`；Java 侧 `Result` **没有 `isOk()`**，单测判成败用 `getErrMsg() == null`

## 五、email（09-28）
- 两聚合 Email/EmailMessage；时间字段 createAt/updateAt 对齐 DDL
- 批量消费 POST /email/message/consume-batch?executionId=&agentId=：条件 UPDATE(where status='PENDING') 按 affected 判定，批量不足抛 ClientException 回滚；匹配=agent 必中+root/target 任一（兼容历史同源）
- **@Builder 单全参构造 PO 禁单列投影**（列序自动映射 IndexOutOfBounds），全列查后 map；del 级联删消息；consume 单向状态机

## 六、mcp（09-29）
- 框架侧 1.1.0 才有 `com.summit.core.conf.McpConfig`（sealed `Conf` 三实现 + `@JsonTypeInfo(property="type")`）；**1.0.3 完全没有该类**（只有 `core/mcp/{McpProvider,McpToolExecutor}`）→ 排查 MCP 异常先确认运行时挂的是 1.1.0，否则「旧产物行为 vs 新源码」的错位必然误导
- 装配链路：DB `mcp.transport` → `McpTransport.parse`(trim/upper/- →_) → `McpServiceImpl.toMCP` switch → `McpConfig.MCP.conf` 运行时类型 → `McpClientFactory.transportOf` 按 conf 类型选 `StdioMcpTransport` / `StreamableHttpMcpTransport`。conf 类型是唯一决策点，`transport` 枚举仅用于 `McpValidator.requireTransport` 一致性校验
- `McpServiceImpl` switch 与 `McpClientFactory.transportOf` 都是穷举 switch（新增传输=编译期报错），已用反编译 jar 验证过打包产物与源码一致
- 入口：`RequestPreparer.buildRequest` 每轮执行调 `mcpService.currentConfig()` 重读库（管理端改动下一轮生效）；`ChatAgent.openMcpScope` → `McpRegister.open` → `AgentMcpProvider.openScope`；失败只 warn 不抛（`continuing without its tools`），**日志只打 server name + 异常类名**，看不到 URL/transport → 排查必须自己开 `-Dlogging.level.dev.langchain4j=DEBUG`（框架把 transport 的 logRequests/logResponses/logEvents 全关了，但 `StdioMcpTransport.start` 的 `Starting process: [...]` DEBUG 还在，是判断传输选择的唯一线索）
- **stdio 在 Windows 必须写 `npx.cmd`，不能写 `npx`**：`StdioMcpTransport` 用 `new ProcessBuilder(command).start()`；Windows 的 `npx` 是无扩展名 sh 脚本，直接 start 抛 IOException → 该 server 静默降级丢掉全部工具。正确 command=`["npx.cmd","--yes","@playwright/mcp@latest"]`（实测 47→72 工具）
- **别把同时间窗的多条报错当因果**：`DefaultMcpClient: List-change subscription failed` + 404 来自 **github server** 的资源订阅，是**无害噪音**，与 playwright 失败无关（线程/来源都不同）。排查先看线程名与紧邻的 `discover result: <serverName>` 确认归属
- jdbc 直连：`docker exec LingXi-mysql mysql -uroot -proot LingXi -e "..."`（容器名 LingXi-mysql，mysql:8.0.30）
- **探针实操**：验证框架类行为用「解包 jar 到 Windows 路径 + `java.exe -cp "D:/..." 单文件.java`」，classpath 必须 Windows 反斜杠/正斜杠路径，Unix 式 `/d/...` 会 `找不到符号`
- **框架源码根 = `D:\code\starter\lingxi-harness-agent`**（不是仓库根）；五模块。只读参考，**仅用户明确授权时可改**
- 09-29 框架改动（用户授权）：`McpClientFactory` 关掉 `subscribeTo*ListChanges`（404 根治）；新增 `WindowsCommandResolver` 按 PATH+`.cmd/.bat/.exe` 探测 argv[0]；`AgentMcpProvider` 失败日志带 transport+根因且脱敏（只打 key 名、只打根因 message）；新增 `McpServerSummary`、`McpResume.server`、`McpToolScope.{toolServers,serverOf,serverSummaries,toolsOfServer,serverNames}`
- **渐进披露两级入口**：提示词 `### MCP Prompt` + 每服务 `- <name> count: <n>`（`SystemPromptAssembler` 在 **`harness-runtime` 的 `com.summit.runtime.prompt`** 包）；`list_mcp_tools(mcpName,limit)` 列 name+description **不揭露**；`search_tool` 返 schema **并揭露** → 下一轮才进模型可见清单。LingXi 侧 `ToolCatalog.LIST_MCP_TOOLS` + `RequestPreparer.toolListOf` 两入口都授予
- 框架侧 JSON 输出规范：**record + `objectMapper.writeValueAsString()`，禁 `Map.put()`**；返回值**禁中文**（连「无结果提示」也不留中文——改为回显入参，如 `keyword`；需要区分的用 `servers` 这类结构化字段表达）；javadoc 精简。`SearchToolExecutor` / `ListMcpToolsExecutor` 已按此规整
- **前端 stdio 警示图标**：文案常量 `types/chat.ts#MCP_STDIO_ENV_HINT`（列表卡片 + 编辑表单**共用一份**）；图标用 **inline SVG 黄圈白底感叹号**（`viewBox 0 0 16 16`，`stroke #f59e0b`，白实心圆），**不要用「圆角 span + 文字 `!`」**（文字基线跨平台不居中）；tooltip 走**原生 `title` + `cursor-help`**——全仓无 tooltip/popper 库，`ChatMessageItem` 也是 `:title`，新组件别引依赖
- 前端检查铁律：改完必须 `vue-tsc -b --force`（`node ./node_modules/vue-tsc/bin/vue-tsc.js -b --force`，**不要用 `--noEmit`**）+ `vite build`
- **改框架侧 / 改前端前，先加载 skill `lingxi-harness-conventions`**（用户级，`~/.workbuddy/skills/`）：固化框架根路径、record+Jackson、禁中文返回、npx.cmd、SubscribeTo*ListChanges、两级披露契约、SVG 图标、vue-tsc 铁律等全部规范与踩坑

## 八、SSE 消息模型（09-29 定案）- **`AI_MESSAGE` ≠ 「有新正文」**，它 = **一个模型轮次结束**（后端 `AgentLoopStepRunner.invokeModel` 每轮发一次 `onAiMessage`）；**工具调用轮也会发，且 `text` 为 null**。消费方**必须先判 `event.text` 是否为空**，**绝不能** 用 `event.text ?? currentTurnText` 兜底——那会把上一轮文本再记一遍。
- aiMessages 落盘唯一入口：`services/chat.ts` / `chatStream.ts` 的 `appendAiMessage(target,text,thinking)`（text 空则 return；相邻同文本视为断流重放忽略；order = 已有 max+1）。**实时与恢复（EXECUTION_RESUMED 重放）四条路径共用**，新增事件分支不得再裸 push。
- 渲染契约：`message.content` = 正文（历史解析里 = 最后一条非空 AI 行文本）；`ChatMessageItem.intermediateAiMessages` = 「**文本 ≠ content** 且全数组去重」的其余条目（**不是** 按位置 `slice(0,-1)`——末条不必等于正文）。
- 排查入口：重复/缺失展示先查 `services/chat.ts`+`chatStream.ts`（实时）→ `utils/session.ts`（历史）→ `ChatMessageItem.vue`（渲染）；DB 侧用 `MD5(JSON_UNQUOTE(JSON_EXTRACT(content,'$.text')))` 对 AI 行查重即可判定是持久化脏数据还是纯前端问题。

## 七、遗留
- git 已重建基线：root-commit `dae2329`（09-29，436 files，rebase 事故后从工作区修复 309 个丢失 blob 而来）；reflog 死指针未清；origin=github.com/yesnonononononi/LingXi 未推送
- 提交需用户明确要求（用户自管 git，AI 不主动提交）
- **框架侧改动需用户自行 install**（AI 不跑 `mvn install`）；本次框架改动（MCP 渐进披露 + 日志 + `npx.cmd` 探测 + SearchToolExecutor 规整）**待用户 install 后端到端验证**：提示词应出现 `### MCP Prompt` + 每服务 `- <name> count: <n>`，agent 能调 `list_mcp_tools` 列服务工具集，`search_tool` 取 schema 并揭露

## 九、子会话复用（09-30 定案）
- **绑定落 `session.agent_id`**（09-30 新增列，`KEY idx_root_agent(root_session_id, agent_id)`；迁移脚本 `src/main/resources/db/manual/20260930_add_session_agent_id.sql`，dev 库已执行）。此前子会话与 Agent 的绑定**只在 SSE 事件 + 内存 registry 里**，重启即失效，无法反查。
- **复用键 = `(root_session_id, agent_id)`**，唯一入口 `SessionRepository.findByRootAndAgent`（Mapper `selectLatestByRootAndAgent`，`ORDER BY id DESC LIMIT 1`）；`SessionAggregateService.findByRootAndAgent` 为应用层出口。
- **委派语义**（`CallSubAgentTool.resolveTarget`）：命中 → **复用同一子会话**、不建 session 行、把其 `session_context` 作为历史经 `buildRequest(..., priorMessages)` → `contextOf()` 拼「历史 + 本次任务」交给子 Agent（框架契约：`AgentRequest.messages` 是执行期历史**唯一**来源）；未命中 → 雪花派生 + `registerSubSession` 写入 `agentId`。**上下文缺失只降级为空历史，绝不回退成派生**。
- **`SUB_AGENT_SESSION_CREATED` 两条路径都必须发**：前端据它建「子会话 id → 根会话」路由、把工具调用挂到子会话按钮；事件幂等（前端 `updateSubSession` 按 id 合并）。`reused` 只 gate「是否建 session 行」。
- **`SessionVO.agentId` 语义已修正**：恒为 `session.getAgentId()`（子会话=真实子 Agent；根/普通会话=null）。**旧实现恒返回全局单例 Agent**（`currentAgentId()` 已删），对子会话是错的。
- **历史数据坑**：改动前建的子会话 `agent_id` 为 NULL → **不会被复用命中**，会另派生新子会话；需回溯只能按 `session.name`（由 Agent 名生成）人工补值。
