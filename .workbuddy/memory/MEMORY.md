# LingXi 项目长期记忆

> 只留「换个会话必须知道」的契约与坑；细节在日报/docs/。

## 环境与流程
- Spring Boot 3.5.6 / Java 21 / MyBatis-Plus 3.5.9 / MySQL 8；单用户本地实例；DDD；包根 com.summit.dp；框架参考 D:\code\starter
- 构建 `export TMPDIR="D:/Code/LingXi/.run/tmp"`+`./mvnw.cmd`；JDK=D:\languages\jdk\jdk-21（PATH 的 JDK26 不可用）；启动带 -Djava.io.tmpdir=.run/tmp -Dserver.port=<显式端口>（8088=用户 IDEA 调试严禁占用）
- **测试判定：落 .run/ 日志读日志，严禁以退出码为准**（stdout 截断→假成功）；冒烟免认证；`curl --noproxy '*'`；POST /a/completion 系列为 multipart/form-data（JSON body 500）
- npx/npm 被沙箱拦→node 直调 bin；前端检查必须 `vue-tsc -b --force`；含中文文件禁 shell 重定向；**Edit 假成功→写后 Read 回读**；同文件并行 Edit 丢修改；用户常 IDEA 并行改动→冲突区备案禁触碰并上报

## 一、单实例（09-27）
- LocalInstance.ID="local"；禁 userId=1；common_config 按行存在分支 save/updateById；身份随 attributes 流动（ExecutionContext record，无 ThreadLocal）；对外 agentId=common_config.agent_id（可空）
- 委派 teamId 走 ExecutionAttributes.TEAM_ID 随快照流动（TeamContext 已删）
- API Key 明文存 model_config；ModelResolver 四级→ClientException；快照 formatVersion=2 含 Key，旧版拒恢复
- SSE 按 rootSessionId（broadcast 已删禁复活）；root_session_id==0/null=自身即根；chatStream 顺序 prepare→connect→beginRoot 固定
- 迁移脚本在 db/manual/（4 个）；MP 分页内核在伴生包 mybatis-plus-jsqlparser（删了静默 total=0）；分页测试配 PaginationInnerInterceptor(DbType.H2)；ModelContextService.replace 是 upsert
- 已删禁引用：auth/UserContext/interaction 全族（包名 dp.interaction→dp.toolcall）/Redis/JJWT/Kafka

## 二、tool_call
- 包 com.summit.dp.toolcall.*；两表：session_message（TOOL 行 content 只存 call_id）+tool_call（id=call_xxx、status 仅 pending/in_progress/completed 无 FAILED）
- JSON 键真源=ToolCallKeys 禁裸串；content.kind∈{PLAN,CHOICE,COMMAND} 判别；结论只写 raw_output.outcome 枚举禁嗅探；可审批唯一判定 type==='PROMISE'&&status==='pending'
- 写入唯一入口 ToolCallRegistrar（幂等 UPSERT，EXECUTE 升级 PROMISE/pending 同 id）；EXECUTE 结果只挂 RuntimeListener.onToolCallOutput；读=批量 message→去重→一次 IN 查（缺行降级）
- SSE：CARD_PENDING{rootSessionId,toolCallId,cardKind,...}；EXECUTION_RESUMED 必须先于 resume 发布（resume 阻塞至下一挂起点，resume(String) 禁用）
- 事务：PLAN/CHOICE 单事务；COMMAND 两段式（T1 先于外部副作用，块在 CommandApprovalExecutor）；execution 禁 import toolcall，走 ExecutionLifecycleListener+Adapter

## 三、会话（09-28）
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

## 六、遗留
- git 暂存未提交（用户自管，AI 禁提交）
