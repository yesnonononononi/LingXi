# 消除 ExecutionRegistrationService —— 业务接入执行登记能力的完整方案（修订版 v2）

- **日期**：2026-10-06（v1 同日修订；本次为 v2）
- **性质**：源码评估（**未修改、未编译业务项目**；本文件是施工级设计，不是已落地变更）
- **目标**：删除 `ExecutionRegistrationService`（接口 + 实现 + 全部调用），**不新增功能类、不扩展框架职责**
- **v1 → v2 修订原因**：v1 的失败通知时序设计**不成立**（框架在业务 catch 之前就已发事件），
  状态保护只覆盖了执行、漏了业务轮次，入口清单漏了 `acceptCommand` / `resend` / `submitAsync`。
  详见「附录 A：v1 的错误与撤换」。

---

## 一、结论（TL;DR）

**方向确认**：用框架创建**完整 Execution**（含 snapshot）替代业务的空记录登记，可以消除这个类。

**注意一处事实修正**：不是「三表没有同事务登记」——今天 `registerInitial` 已经在 `commitUserMessage`
的同一个事务里（`RequestPreparer.java:258` 与 `acceptTurn`/`appendUser` 同事务）。真正缺的是两样：

1. 登记的是**空记录**：`ExecutionRegistrationServiceImpl.registerInitial` 不写 `snapshot`，
   而 `LocalExecutionRepository.findById` 对 `snapshot IS NULL` 的行返回空 ⇒ 这个执行对象**读不回来**；
2. **创建时机**：框架创建执行发生在后续编排阶段（`agent.execute(agentRequest)` 内部），
   因此「失败时业务手里没有一个可收口的执行对象」，只能靠一条条件 UPDATE 打补丁。

四步施工（与用户的方案一致）：

| # | 动作 | 落点 |
|---|---|---|
| 1 | 拆开创建与执行：编排器提供 `createExecution(context)` / `execute(context, execution)`，保留原人设、工具与 Agent 选择逻辑；`RuntimeContext` 携带 Execution | `AgentWorkflowOrchestrator(Impl)`、`RuntimeContext` |
| 2 | 统一受理事务：轮次与用户消息落库 → 带 turnId → 框架创建完整 Execution；一个共同入口覆盖四个调用点 | `PreparedChatExecutor#admit`（`@Transactional`）+ `ChatServiceImpl#commitUserMessage` |
| 3 | 业务收尾时序：仓储在「首次落 FAILED 且无活跃控制槽位」时**提交后**通知 `notifyFinished`，使轮次收口恒早于框架发事件；业务失败路径统一 `ExecutionControl.fail`，删掉手工广播 | `LocalExecutionRepository#save`、`PreparedChatExecutor` |
| 4 | 删除旧代码：登记接口/实现/调用 + 已无引用的 `markFailedIfUnfinished`（保留启动收尸） | 见第六节 |

净代码量约为负：新增 2 个方法 + 1 个守卫分支 + 1 个 record 分量；删除 2 个类、3 个方法、1 个测试类、
以及 `PreparedChatExecutor` 的 3 个依赖字段与手工事件构造。

---

## 二、现状取证（2026-10-06 深夜实读；工作区含大量未提交改动）

> ⚠️ 引用基准：本轮全部行号在**当前工作区**重读取得。上一轮（约 30 分钟前）读到的 `ChatServiceImpl`
> 与 `PreparedChatExecutor` 已经不同（新增了 `acceptCommand` / `submitAsync` / `failSubmit`），
> 凡跨会话复核务必重跑，不要沿用旧行号。

### 2.1 受理事务：已有同事务登记，但登记的是空记录

`RequestPreparer.commitUserMessage`（`@Transactional`，:242-269）内依次：

```java
executionRegistrationService.registerInitial(new InitialExecution(executionId, sessionId));  // :258
long turnId = chatTurnService.acceptTurn(...);                                               // :263
transcriptService.appendUser(...);                                                           // :266
```

`ExecutionRegistrationServiceImpl:22-28` 只写 `id / session_id / status=CREATED`，
**不写 snapshot**。⇒ 三表确实同事务，但执行行读不回来：`LocalExecutionRepository.findById` 第 187 行
`if (snapshot == null) return Optional.empty();`。

### 2.2 四个调用点，一个共同受理入口

| 入口 | 路径 | 依据 |
|---|---|---|
| `chat`（同步） | `chat`(:70) → `executePrepared`(:218) → `chatExecutor.run` | `ChatServiceImpl:76`、`:219` |
| `chatStream`（流式） | `chatStream`(:98) → `executePrepared`(:218) → `chatExecutor.run` | `ChatServiceImpl:116`、`:219` |
| `acceptCommand`（同步受理） | `acceptCommand`(:140) → `commitAndSubmit`(:183) → `chatExecutor.submitAsync` | `ChatServiceImpl:144`、`:186` |
| `resend`（重发） | `resend`(:156) → 回滚 → `commitAndSubmit`(:183) → `submitAsync` | `ChatServiceImpl:177` |

四者**都经过 `ChatServiceImpl#commitUserMessage`(:200-209)** —— 这就是方案要求改的「共同受理入口」。
（`resend` 顺序约束不变：回滚必须在 `commitUserMessage` 之前，:168-175 已注释说明。）

### 2.3 失败通知时序：框架先发事件，业务 catch 排在后面

这是 v1 判断错误的那一条。真实链路：

```java
// ChatAgent.java:98-117（框架，harness-runtime）
try {
    executionRuntime = prepareExecutionRuntime(execution);
} catch (RuntimeException e) {
    if (execution.getExecutionState() == ExecutionState.CREATED) {
        try {
            executionControl.fail(execution, e).run();   // :106 —— 事件在这里就出去了
        } catch (RuntimeException saveFailure) { ... }
    }
    throw e;                                              // :111 —— 业务 catch 才轮到
}
```

而 `DefaultExecutionController.fail`（`harness-runtime`，:84-95）：

```java
public Runnable fail(Execution execution, Exception cause) {
    execution.failChecked(cause.getMessage());
    executionRepository.save(execution);                  // ① 先落库（状态 + completedAt）
    return () -> executionRepository.afterCommit(() ->    // ② 返回的才是「发布事件」任务
            runtimeLifeStyleManager.onError(execution, cause));
}
```

⇒ 业务 catch 里的任何排序都**管不到**框架这条路径：`save` 与 `publish` 之间那一段间隙，
才是轮次收口唯一的合法落点。loop 内的失败同理（`RuntimeProcessorTemplate:90-102` 先 `fail`，
事件挂在 `finally` 的 `pendingEvent` 里更晚才发）。

### 2.4 轮次终态的唯一来源

`ChatTurnLifecycleListener.onExecutionFinished`（:45-56）是唯一按执行终态写轮次状态的实现，
由 `LocalExecutionRepository` 广播，现有**两个**广播点：

| 广播点 | 触发场景 | 位置 |
|---|---|---|
| `unregister` | 活跃循环结束（含 loop 内失败） | `LocalExecutionRepository:250-256` |
| `requireCancel` | 取消一个**挂起中**的执行（`/stop`，不发事件） | `:282` |

初始化失败两者都不经过 ⇒ v1 说的缺口成立。**但修法不是「业务 catch 里补排序」**（见 2.3），
而是在 `save` 里补第三个广播点（见 4.4）。

### 2.5 现状的补偿代码（本方案要删掉的部分）

`PreparedChatExecutor.markStartupFailedQuietly`（:121-146）今天做三件事：
① `executionRegistrationService.markStartupFailed(executionId)`（条件 UPDATE 打补丁）；
② 手工把轮次标 FAILED + 写原因（:138-140）；③ `broadcastStartupFailure`（:155-167）**手工构造**
`ExecutionErrorEvent`（因为手里没有 Execution，元数据只能从 `RuntimeContext` 现场拼）。

三步都是「没有执行对象」这一事实的派生补偿。第 1 步接入后，三者全部可由框架既有链路承担。

---

## 三、目标设计

### 3.1 时序（改造后）

```
请求线程                                 异步执行线程
────────                                 ──────────
prepare(command)                          │ 解析会话/工作空间/档位/模型/执行身份
ensureSessionTreeIsIdle()                 │
beginRoot(rootSessionId)                  │ 单飞锁
├─ chat / chatStream：connect(SSE)        │
└─ acceptCommand / resend：不建流          │
        │                                 │
        └── commitUserMessage(context)     │ ← 共同受理入口（ChatServiceImpl:200）
             └─ chatExecutor.admit(context)          【新】事务根
                  ├─ requestPreparer.commitUserMessage → turnId（轮次 + 用户消息）
                  ├─ withTurnId(turnId)
                  └─ orchestrator.createExecution(ctx) → 框架创建并保存完整 Execution
                                          │
                                          ▼
                                  chatExecutor.run(committed)   / submitAsync → run
                                       └─ orchestrator.execute(ctx, execution)
                                            └─ SubAgent/IChatAgent.execute(execution)
                                                 └─ ChatAgent.execute(Execution) → loop
                                       ├─ 成功：正常终态链路（unregister → 轮次终态 → 事件）
                                       └─ 失败：见 3.3
                                       └─ finally：finishRoot（含校验失败的路径）
```

### 3.2 事务边界

| 层 | 事务 | 内容 |
|---|---|---|
| `PreparedChatExecutor#admit` | `@Transactional`（**新的事务根**） | 轮次 + 用户消息 + 执行行（含 snapshot） |
| `RequestPreparer#commitUserMessage` | `@Transactional`（原有，REQUIRED → 加入上式） | 轮次 + 用户消息 |
| `LocalExecutionRepository#save` | `@Transactional`（框架侧薄接口，REQUIRED → 加入上式） | 执行行 + snapshot |
| `ChatTurnServiceImpl#acceptTurn` | **无注解**（:32-36、:45-57），纯靠调用方事务 | 轮次落库 |

全仓 `REQUIRES_NEW` 只出现在 toolcall 的就绪/收口钩子（`ToolCallReadinessService:43`、`ToolCallServiceImpl:104`），
与本链路无关 ⇒ 物理上只有一个事务。

### 3.3 失败路径的收尾（本方案的时序核心）

```
业务侧（派发/校验失败，未进框架）       框架侧（ChatAgent:104-111）
────────────────────────               ────────────────────────
复用同一份 fail 调用                    框架自己调 fail
        │                                       │
        └──────────────┬────────────────────────┘
                       ▼
        DefaultExecutionController.fail
          ① execution.failChecked(reason)     ← 执行对象进终态（completedAt 落定）
          ② executionRepository.save(execution)
               └─ LocalExecutionRepository.save 内【新增】：
                  首次落 FAILED 且无活跃控制槽位
                    → afterCommit(notifyFinished(execution))
                       └─ ChatTurnLifecycleListener.onExecutionFinished
                            → chatTurnService.markTerminal(FAILED, execution.getCompletedAt())
          ③ 返回的 Runnable.run()
               └─ RuntimeLifeStyleManager.onError → ExecutionErrorEvent
                    ├─ ChatTurnRuntimeListener.onExecutionError → recordFailureReason（原因）
                    └─ AgentEventListener.finishExecution → publish + disconnectRoot
```

**不变量**：轮次终态在「执行行落 FAILED 并提交」时即完成，**恒早于**终态事件发布。
前端收到 `EXECUTION_FAILED` 时，轮次已是 FAILED 且带原因（原因由 `ChatTurnRuntimeListener` 的
`@Order(HIGHEST_PRECEDENCE)` 保证先于 SSE 广播提交）。

loop 内的失败仍由 `unregister` 通知（改后行为不变）：`RuntimeProcessorTemplate.execute` 先 `register`，
失败时 `active` 槽位仍在 ⇒ `save` 侧的守卫不触发 ⇒ 走 `unregister` ⇒ 结果与今天一致。

### 3.4 状态保护（覆盖执行**与**轮次）

| 执行状态 | 调用 `fail` | 写轮次 FAILED | 依据 |
|---|---|---|---|
| CREATED | ✅ | ✅（经 `notifyFinished`） | 未开始的执行必须收口，否则历史留「创建中」 |
| RUNNING | ✅ | ✅ | 同上 |
| SUSPENDED | ❌ | ❌ | 挂起可恢复；误标失败会让「待恢复」入口消失 |
| COMPLETED / FAILED / CANCELLED | ❌ | ❌ | 终态不可改写（`failChecked` 会抛「非法状态转换」） |

**执行状态 → 轮次终态的映射只有一处**（`ChatTurnLifecycleListener.resolveTerminalStatus:69-80`），
业务侧不再有任何「无条件写 FAILED」的代码路径 —— 这是把 v1 的散点补丁换成一类结构性保证。

---

## 四、逐文件改动清单

### 4.1 `shared/utils/RequestPreparer.java`

- 删除字段与 import `ExecutionRegistrationService`（:8、:83）。
- `commitUserMessage(RuntimeContext, String, String)`（:243-269）：**删除 :258-260 的 `registerInitial` 调用**，
  `acceptTurn` → `appendUser` 顺序不动。
- 文档修订：方法 javadoc 里「同时登记『初始执行』记录」改为「执行行由受理协作（`PreparedChatExecutor#admit`）
  在本事务内经框架创建」；「一个短事务：执行行、业务轮次与用户消息」这条约束上移到 `admit` 的位置说明。
- `@Transactional` 保留（内层加入外层事务；独立调用时仍是自洽边界）。**不得改为 `REQUIRES_NEW`。**

### 4.2 `agent/infrastructure/workflow/AgentWorkflowOrchestrator(.java / Impl.java)`

接口收敛为两个方法：

```java
public interface AgentWorkflowOrchestrator {
    /** 受理阶段：解析人设与工具清单 → 构造 AgentRequest → 交框架创建并保存执行（不运行）。 */
    Execution createExecution(RuntimeContext context);

    /** 执行阶段：把已登记的执行交给对应执行器运行；只做分发，不做任何查询。 */
    Execution execute(RuntimeContext context, Execution execution);
}
```

实现要点：

- 新增私有助手 `private Agent resolveAgent(RuntimeContext context)`：`teamId != null` → `subAgent`；
  否则 `agentId != null` → `subAgent`；否则 → `agent`（`IChatAgent`）。
  **`createExecution` 与 `execute` 必须共用它**：`Execution.agentId` 由创建方的 `id()` 写入
  （`Execution.create`），而 `SubAgent.id()` 返回 `""`、`IChatAgent.id()` 返回 `"chatAgent"`，错配即写错归属。
- `createExecution(context)` = 现有三个 `executeXxx` 的**前半段原样保留**（团队人设与 `commanderTools`、
  单 Agent 的 `getPrompt()/getToolList()`、裸模型的 `userTextOf()` 与 `ToolCatalog.DEFAULT_AGENT_TOOLS`），
  收尾从 `xxx.execute(agentRequest)` 改为 `resolveAgent(context).createExecution(agentRequest)`。
- `execute(context, execution)` = `resolveAgent(context).execute(execution)`。
- 删除 `executeWorkflow` / `executeSingleAgent` / `executeDefaultAgent`（接口 + 实现同步）。
- 为什么解析必须留在编排器：`Execution.create` 要求 `request.messages()` 非空，且**整份 request 会进 snapshot**
  （`LocalExecutionRepository:62`）—— 在受理阶段塞「无人设、无工具清单」的半成品会让落库请求 ≠ 实际执行请求，
  且 `Execution.agentId` 无法确定。

**循环依赖说明（为什么事务根不在 RequestPreparer）**：

```
RequestPreparer ──▶ AgentWorkflowOrchestratorImpl ──▶ RequestPreparer   ← 构造期循环，Spring 启动即失败
```

`RequestPreparer` 直接调编排器就踩这条环（这也解释了登记逻辑当初为何被抽成独立小接口）。
拆解：`RequestPreparer` 只留「写轮次 + 写用户消息」，编排器只留「解析 + 创建 + 分发」，
由**已同时依赖两者的** `PreparedChatExecutor` 担任事务根 —— 且必须由 `ChatServiceImpl` 跨 bean 调用
（`commitUserMessage` 是 `private` 自调用，注解挂它上面**不会生效**，见 4.5）。

### 4.3 `agent/application/service/impl/PreparedChatExecutor.java`（改动最大）

**依赖变更**

| 动作 | 字段 |
|---|---|
| 删 | `ExecutionRegistrationService executionRegistrationService`（:21、:46） |
| 删 | `ChatTurnService chatTurnService`（:47）—— 轮次收口改由生命周期端口承担（4.4） |
| 删 | `RuntimeEventPublisher runtimeEventPublisher`（:49）—— 手工广播删除 |
| 增 | `RequestPreparer requestPreparer`（受理事务内落库） |
| 增 | `ExecutionControl executionControl`（失败收口） |

**新增受理方法**（放在 `submitAsync` 之前）：

```java
/**
 * 受理：把业务轮次、用户消息与框架执行行放进同一个事务提交。
 *
 * <p><b>为什么事务根在这里</b>：执行行由框架创建（{@code Agent.createExecution}），而构建执行请求需要
 * 编排器（它又依赖 RequestPreparer），只有本类能同时持有两者而不构成循环依赖。</p>
 *
 * <p><b>顺序不可交换</b>：{@code createExecution} 必须在 {@code acceptTurn} 之后 ——
 * 轮次 ID 会写进执行请求的事件元数据（{@code ExecutionEventMetadata}），
 * 先建执行会让本轮的 SSE 事件带上空 turnId。</p>
 *
 * <p><b>失败语义</b>：本方法抛出的异常一律是<b>受理失败</b>（事务整体回滚，三表都不留记录），
 * 与后续执行阶段的失败严格区分 —— 前者要求用户重发，后者输入已生效、只需展示失败。</p>
 */
@Transactional
public RuntimeContext admit(RuntimeContext context) {
    if (context == null || context.pendingUserMessage() == null) {
        return context;
    }
    Long turnId = requestPreparer.commitUserMessage(context);
    RuntimeContext committed = context.withTurnId(turnId);
    Execution execution = agentWorkflowOrchestrator.createExecution(committed);
    return committed.withExecution(execution);
}
```

**改造 `run`**（:88-102）—— 执行对象校验进 `try`，任何退出路径都释放运行资格：

```java
public Execution run(RuntimeContext context) {
    long rootSessionId = context.executionContext().rootSessionId();
    try {
        Execution execution = context.execution();
        if (execution == null) {
            // 程序性前提，不是客户端错误：受理事务必然登记了执行对象，缺它说明调用顺序被破坏。
            throw new IllegalStateException("执行未登记：受理事务必须先创建执行");
        }
        Execution result = agentWorkflowOrchestrator.execute(context, execution);
        modelContextService.replace(ExecutionIdentity.sessionId(result), result.getMessages());
        return result;
    } catch (RuntimeException e) {
        markStartupFailedQuietly(context, e);
        throw e;
    } finally {
        sessionExecutionRegistry.finishRoot(rootSessionId);
    }
}
```

⚠️ 校验**必须在 `try` 内**：放外面会让 `finishRoot` 被跳过，会话被单飞锁死（用户再也发不出下一条）。

**重写 `markStartupFailedQuietly`**（原 :121-146，从 26 行缩到约 12 行）：

```java
/**
 * 收口「已登记但没能跑起来」的执行；收口本身失败只告警，绝不掩盖原始异常。
 *
 * <p><b>为什么只判状态、别的都不做</b>：执行行与轮次的收口、以及终态事件的发布，
 * 全部由框架的 {@code ExecutionControl.fail} 一条链完成 —— 它先落库（终态 + 结束时间），
 * 再由仓储在提交后通知轮次收口，最后才发布事件。业务侧再手工写一遍轮次就会与它打架。</p>
 *
 * <p><b>为什么必须先判状态</b>：框架入口内（{@code ChatAgent} 初始化）与 loop 内的失败，
 * 框架已自行 fail 过；{@code Execution.failChecked} 对已终态会抛「非法状态转换」。
 * 判据与旧的 SQL 条件更新同口径：只处理 CREATED / RUNNING。</p>
 */
private void markStartupFailedQuietly(RuntimeContext context, RuntimeException cause) {
    Execution execution = context.execution();
    if (execution == null) {
        return;
    }
    try {
        ExecutionState state = execution.getExecutionState();
        if (ExecutionStatusCodes.isTerminalState(state) || state == ExecutionState.SUSPENDED) {
            return;
        }
        executionControl.fail(execution, cause).run();
    } catch (RuntimeException failFailure) {
        log.warn("收口启动失败的执行时出错: executionId={}, cause={}, 收口失败原因={}",
                execution.getId(), cause.toString(), failFailure.toString());
    }
}
```

**同时删除**：`broadcastStartupFailure`（:155-167）、`resolveHistoryRevision`（:170-173）、
以及 `start(context)`（:105-113，档位判定收敛到编排器）、`ExecutionEventMetadata` / `SessionVO` /
`ChatTurnStatus` / `Instant` / `Map` 相关 import。
`submitAsync`（:58-65）与 `failSubmit`（:73-76）**签名与语义不变** —— `failSubmit` 仍走 `markStartupFailedQuietly` + `finishRoot`，
只是收口链换成了框架那条（提交被拒时执行仍在 CREATED、无活跃槽位 ⇒ 保护条件成立）。

### 4.4 `execution/infrastructure/repository/LocalExecutionRepository.java`（第 3 步的落点）

在 `save`（:49-97）的 update 分支内新增一个守卫广播。`previous` 已有的选择列（:73-76）够用：

```java
// 行前态读出之后（guard 之前）判定，update 成功之后再广播 ——
// version 条件保证并发只有一方成功落库，成功者才广播，天然「只发一次」。
boolean firstFailure = state == ExecutionState.FAILED
        && (previous == null || previous.getStatus() == null
            || previous.getStatus() != ExecutionStatusCodes.FAILED);
boolean noActiveSlot = !active.containsKey(execution.getId());
...
if (updated != 1) throw new IllegalStateException("执行检查点不存在: executionId=" + id);
cacheAfterCommit(execution.getId(), snapshot, terminal);
// 初始化失败路径没有任何活跃控制槽位，unregister 不会到来 ——
// 在这里补上轮次收口，使它在框架发布终态事件之前完成（时序不变量见设计 §3.3）。
if (firstFailure && noActiveSlot) {
    afterCommit(() -> notifyFinished(execution));
}
```

设计要点与边界（逐条已核对）：

- **为什么限定 FAILED**：其他终态已有各自的收口路径 —— 运行中被取消走 `unregister`（:250-256）、
  取消挂起中的执行走 `requireCancel` 的显式 `afterCommit(notifyFinished)`（:282）、
  审批执行中断走 `failApproval → fail(...)`（FAILED，本规则覆盖）。
  若改成「任意终态」，`requireCancel` 会多一次重复通知（同终态幂等、无害，但属多余噪声）。
- **为什么用「无活跃控制槽位」而不是「state 是不是 RUNNING」**：活跃循环的失败流程是
  `register → fail → save →（finally）unregister`，`active` 槽位在 `save` 时仍在 ⇒ 交给 `unregister` 通知，
  与今天行为完全一致；初始化失败从未 `register` ⇒ 由本规则通知。两者互斥，不会双发。
- **为什么放在 `afterCommit`**：`save` 自身是 `@Transactional`；在受理事务之外它是自开事务，
  `afterCommit` 会立即执行（`isSynchronizationActive()==false` 分支，:135-138），
  仍严格早于框架随后 `.run()` 的发布。
- **通知携带的对象**：用传入的活对象（状态、`completedAt`、事件元数据都已就绪），
  与 `unregister` 用 `findById` 解码副本的做法不同 —— 这里没有事务外的解码需求，少一次 LONGTEXT 反序列化。
- **不改动**：`unregister` / `requireCancel` / `notifyFinished` / `notifySuspended` 全部原样。
- **分层说明**：仓储只广播领域端口（`ExecutionLifecycleListener`），不反向依赖 turn 应用服务 ——
  与该文件既有两条广播路径同一形态，无新增分层违反。

### 4.5 `agent/application/service/impl/ChatServiceImpl.java`

**只改共同受理入口**（:200-209），四个调用点自动覆盖：

```java
private RuntimeContext commitUserMessage(RuntimeContext context) {
    try {
        // 受理事务：轮次、用户消息与框架执行行一起提交（admit 上标注 @Transactional）。
        return chatExecutor.admit(context);
    } catch (RuntimeException commitFailure) {
        sessionExecutionRegistry.finishRoot(context.executionContext().rootSessionId());
        throw commitFailure;
    }
}
```

- `executePrepared`(:218-220) 与 `commitAndSubmit`(:183-191) **不需要改**（它们拿到的是已带 Execution 的上下文）。
- `resend`(:156-178) 的回滚顺序不变：仍在 `commitUserMessage` 之前（:168-175 的注释继续成立）。
- 受理失败（含 `createExecution` 抛错）仍由本方法释放运行资格并向上抛 —— 与今天 `commitUserMessage` 失败的处理完全一致。
- ⚠️ 事务根的**代理**要求：`admit` 必须由另一个 bean 调用。`commitUserMessage` 是 `private` 自调用，
  若有人日后把 `admit` 的内容内联进 `ChatServiceImpl`，事务会**静默失效**（不报错、原子性丢失）。
  所以在 `admit` 的方法注释里写明「不可内联」。

### 4.6 `agent/application/service/impl/RuntimeContext.java`

record 增一个分量并加派生方法（其余不动）：

```java
public record RuntimeContext(
        ExecutionContext executionContext, Long agentId, Long teamId, SessionVO session,
        List<Message> messageList, WorkspaceSpec workspace, ModelConfig modelConfig,
        AgentAccessMode accessMode, CommandApprovalPolicy commandApprovalPolicy, boolean requirePlan,
        UserMessageEntity pendingUserMessage, Long turnId,
        /** 受理事务登记的框架执行对象；受理前为 null，受理后与 turnId 一并生效。 */
        Execution execution) {

    /** 受理前的便捷构造器：turnId 与 execution 都还没有。 */
    public RuntimeContext(... 原 11 参 ...) { this(..., null, null); }

    public RuntimeContext withTurnId(Long turnId) { ... }
    public RuntimeContext withExecution(Execution execution) { ... }
}
```

**为什么不回查执行表**（`findById` 也可行，明确不选）：① 回查要把 LONGTEXT snapshot 反序列化一次，
只为拿一个刚在内存里造好的对象；② **对象同一性有意义** —— loop 就地改这个实例，
拿副本会让「执行行里的对象」与「loop 手里的对象」变成两份；③ 旧缺陷根因正是「snapshot 缺失读不到」，
改成依赖回查等于把同一风险换个位置留着。

保留 11 参便捷构造器后，现有构造点（`RequestPreparer:196`、`ChatAdmissionOrderTest:104`、
`RequestPreparerExecutionIdentityTest:178/189`、`CollaborationToolExposureTest:214`、
`PreparedChatExecutorTest:82`、`ChatAcceptanceEndpointTest:92`）**全部无需改动**。

### 4.7 `agent/infrastructure/agent/{IChatAgent,SubAgent}.java`（仅注释，已核对）

两个 Agent **已经**按 7 参把 `ExecutionRepository` / `ExecutionControl` 传进 `super(...)`（`IChatAgent:29-38`、
`SubAgent:27-36`），无需改动。但两处 javadoc 仍写「必须使用 **5 参**构造器」/「**4 参**构造器会把
`scopeMcpProvider` 置为 null」，与现状（框架 7 参 `@AllArgsConstructor` + 一个 6 参兼容构造器，见
`ChatAgent:35-73`）不符 —— 属误导性注释，施工时**顺手改正**（项目有「注释-实现一致」纪律）。

---

## 五、关键设计与取舍

1. **为什么必须把档位解析放进受理阶段**：见 4.2 末尾（snapshot 与 `agentId` 两重原因）。
   代价是受理事务多两次查询（`TeamVO`/`AgentVO`，`prepare` 的 `effectiveCommand` 本就在查同一个 team）
   与一次 snapshot 序列化，**事务内不含任何模型调用**。
2. **为什么轮次收口落在仓储而不是业务**：见 3.3 —— 框架先 `save` 后发事件，业务 catch 排在后面，
   只有在 `save` 与发布之间插入才能保证「轮次先于事件」。用领域端口广播，不引入反向依赖。
3. **为什么业务侧不再写轮次终态**：写两遍会与端口链路打架（同一事实两个写入者）；
   且 v1 的「挂起也顺手标 FAILED」正是双写入者带来的错误。
4. **为什么 `acceptTurn` 必须先于 `createExecution`**：事件元数据带 `turnId`
   （`RequestPreparer#executionEventMetadata` → `context.turnId()`），已落地测试
   `RequestPreparerExecutionIdentityTest:142-147` 断言了这份元数据的四个键。
   副作用：`historyRevision` 的读取从「执行启动时」提前到「受理事务内」——对本轮更准确，
   代价是事务内多一次会话行主键读（`RequestPreparer:379-383` 的兜底逻辑不变）。
5. **`@Transactional` 不可放 `REQUIRES_NEW`**：会切断轮次/消息/执行行与外层的原子性，
   这正是本方案要保住的不变量。

---

## 六、删除清单

| # | 目标 | 依据 |
|---|---|---|
| 1 | `execution/application/service/ExecutionRegistrationService.java` | 整文件 |
| 2 | `execution/application/service/impl/ExecutionRegistrationServiceImpl.java` | 整文件 |
| 3 | `execution/.../mapper/ExecutionMapper.java:38-56` `markFailedIfUnfinished` + javadoc | 删 #1/#2 后仅剩其自身与 #6 测试引用 |
| 4 | `execution/infrastructure/repository/ExecutionRepositoryImpl.java:86-90` | 同上 |
| 5 | `execution/domain/repository/ExecutionRepository.java:27-38` | 同上 |
| 6 | `src/test/java/.../ExecutionStartupFailureClosureTest.java` | 测的是 #3 的条件 UPDATE；新守卫在内存判状态 + 仓储广播，覆盖改由 4.4 / 第七节用例承担 |
| 7 | `PreparedChatExecutor.broadcastStartupFailure` / `resolveHistoryRevision` / `start` | 手工事件构造与档位分发被框架链路与编排器取代 |
| — | `markOrphanRunsFailed`（Mapper:33-36 / RepoImpl:82-84 / domain:25） | **保留** —— 启动收尸仍在用 |
| — | `src/test/resources/execution-status-schema.sql` | **保留** —— `ResumeGenerationTest:53`、`ExecutionQueryServiceTest:51`、`ExecutionStartupReaperTest:63`、`ExecutionSummaryQueryTest:53` 在用 |

⚠️ `ExecutionCommand`（历史 debug 记录的死类）与本次无关，手不要伸过去。

---

## 七、测试影响与验收覆盖

### 7.1 必须同步修改（编译期即被挡住）

| 测试 | 改动 |
|---|---|
| `ChatAdmissionOrderTest` | 删登记服务 mock（:71/:84）；`PreparedChatExecutor` 构造实参换为 `(orchestrator, modelContextService, registry, requestPreparer, executionControl)`；`orchestrator.executeDefaultAgent(...)` → `execute(any(), any())`（:140/:156/:184/:197/:211/:226/:246/:264 等）；`markStartupFailed` 断言（:203/:213）改为断言 `executionControl.fail(execution, cause)` 被调用且返回的 Runnable 被 run；补「终态/挂起不调用 fail」两条 |
| `PreparedChatExecutorTest` | 删登记服务 mock（:56/:68/:106/:121）；改为装配**真实** `LocalExecutionRepository` + `DefaultExecutionController` + `ChatTurnLifecycleListener`（mock `ChatTurnService`），断言链换成「`fail` → 仓储触发轮次终态 → 事件发布」（见 7.3） |
| `ChatAcceptanceEndpointTest` | `commitUserMessage` 桩（:102/:119/:132/:140）改为 `chatExecutor.admit(...)` 桩（`admit` 与 `submitAsync` 都在同一 mock 上）；顺序断言改为 `beginRoot → admit → submitAsync` |
| `RequestPreparerExecutionIdentityTest` | 删 mock（:68/:83）与 `registerInitial` 断言（:150-154）、`verifyNoInteractions(registrationService)`（:123/:196）；用例名与断言语义收窄为「轮次 + 用户消息同事务」 |
| `ChatResumeTeamAttributeTest:72-74` | `new PreparedChatExecutor(...)` 实参表变化 |
| `SessionTeamBindingTest:59-66` / `CollaborationToolExposureTest:202-209` | `RequestPreparer` 构造实参少一个 |
| `ExecutionStartupFailureClosureTest` | 整文件删除（第六节 #6） |

### 7.2 ⚠️ 顺序测试不能证明原子性

`ChatAdmissionOrderTest` 的 `InOrder` 只证明「调用发生的先后」，**不证明三表共同提交/回滚** ——
mock 之间没有事务。用户已明确要求真实事务测试，方案同意：原子性必须由 7.3 第 1 条证明，
顺序断言降级为「补充证据」，不得作为原子性验收依据。

### 7.3 验收覆盖（对应四类必须验证的行为）

**① 三表共同提交 / 回滚（真实事务，必须新增）**

沿用项目既有的「每模块一份测试 DDL + 真实 `TransactionTemplate`」模式（样板见 `ToolCallPersistenceTest:47/58`、
`ChatTurnRepositoryTest:48`）：

- 新增 `src/test/resources/session-message-schema.sql`（列形对齐 `init.sql:86-97`：
  `id/session_id/turn_id/type/content/create_time/update_time` + `stream_key` 与 `UNIQUE(session_id, stream_key)`）；
- 测试装配：`EmbeddedDatabaseBuilder.addScript("execution-status-schema.sql").addScript("chat-turn-schema.sql").addScript("session-message-schema.sql")`
  + `new TransactionTemplate(new DataSourceTransactionManager(database))` + 真实 mapper/repository
  + 真实 `PreparedChatExecutor`（`requestPreparer` / `orchestrator` 可为 mock，**`createExecution` 桩成抛异常**）；
- 断言：
  - 异常路径：`assertThrows` 包住 `transaction.executeWithoutResult(s -> executor.admit(context))`，
    随后 `chat_turn` / `session_message` / `execution` 三表 `count(*)` **全为 0**；
  - 正常路径：三表各 1 行，且 `execution.snapshot IS NOT NULL`（这是本方案要修掉的核心事实）。
- ⚠️ 测试里包 `TransactionTemplate` 是必需的：`@Transactional` 靠代理生效，
  手工 `new` 出来的实例没有代理；生产环境的代理由 Spring 提供（4.5 已说明）。

**② 初始化失败：事件只发一次，且轮次已 FAILED**

- 用**真实**链路装配：`LocalExecutionRepository`（真实 `save` + 真实 `ChatTurnLifecycleListener`）+ 真实
  `DefaultExecutionController`（`com.summit.runtime.loop`，公开构造器）+ 真实 `RuntimeEventPublisher` +
  真实 `AgentEventListener`（mock `SseEventPublisher`、mock `ChatTurnService`、mock `ExecutionIdentity`）；
- 断言：`InOrder order = inOrder(chatTurnService, sseEventPublisher)`
  → `order.verify(chatTurnService).markTerminal(..., FAILED, ..., execution.getCompletedAt(), ...)`
  → `order.verify(sseEventPublisher).publish(rootSessionId, event)`（**轮次先于事件**，这是本方案的核心不变量）；
  → `verify(sseEventPublisher, times(1)).publish(...)`（只发一次）→ 随后 `disconnectRoot`；
  → 事件 `type` = `EXECUTION_FAILED` 且 `executionId` 为已固化 ID。

**③ 挂起与其他终态不被覆盖**

- 执行侧：`CREATED`/`RUNNING` → `fail` 被调用；`SUSPENDED`/`COMPLETED`/`CANCELLED` → `fail` **不被调用**；
- 轮次侧：`SUSPENDED` 时轮次**不得**被写 FAILED（v1 的错误就在这一条）——
  在真实 `LocalExecutionRepository` 上 `save(SUSPENDED)` / `save(COMPLETED)` / `save(CANCELLED)`，
  断言 `notifyFinished` 未触发（用 spy 的 `ChatTurnLifecycleListener` 或直接断言 `ChatTurnService` 零交互）；
- 仓储侧：同一执行重复 `save(FAILED)` → 只广播一次（version 条件 + `previous` 判据）；
  并发两方保存 → 只有一方成功、只有一方广播（可参考 `ResumeGenerationTest` 的并发写法）。

**④ 提交失败与执行失败都释放运行资格**

- `failSubmit`（线程池拒绝）与 `run` 失败（含执行对象缺失的校验失败）→ 均 `verify(registry).finishRoot(...)`；
- 尤其新增一条：**执行对象为 null 时抛异常也要释放**（校验已移入 `try`，4.3）。

### 7.4 回归确认（行为不变的部分）

- 挂起 → 审批 → 恢复链路不经过本次改动的任何方法；
- 进程在受理后、执行前被杀：`ExecutionStartupReaper` / `markOrphanRunsFailed` 照旧收口（保留）；
- loop 内失败仍由 `unregister` 通知轮次（改后不新增广播：`active` 槽位守卫）。

### 7.5 本机验证注意（工作区含在建改动）

本仓库常处于「用户并行改到一半」的状态，整树 `test-compile` / `test` 可能因**与本改动无关的文件**全红。
验证时按这两条做，**不要顺手改在建文件**：

- 隔离副本验证：`git worktree add --detach D:/Code/LingXi-verify HEAD` → 用工作树现状覆盖 `src`/`pom.xml`/`init.sql`
  → 就地回退与本次无关的在建模块 → 在副本里跑 `mvn test`；判据是「`main/java` 编译 0 错误」+「本次相关测试类全绿」；
- 或只跑相关测试类（私有输出目录编译 + surefire，产物**不得写进 `target/classes`** —— 会丢掉 `-parameters` 让 Spring 取不到参数名）。

---

## 八、风险与未决

| # | 项 | 说明 | 处置 |
|---|---|---|---|
| R1 | **行为变化**：团队 / Agent 查询、请求构建失败 → 受理失败 | 改造前：轮次 + 空记录执行行已落库，历史留一条永远「已受理」的提问；改造后整体回滚，什么都不留 | 判定为**改善**，与 `commitUserMessage` 既有注释「先取运行资格再落库，避免『消息已入库、执行却被拒绝』的孤行」同源。代价：前端在这条路径上只看到流关闭（`chatStream` 的 catch+finally，与今天表现相同） |
| R2 | 受理事务变长 | 事务内多 `TeamVO`/`AgentVO` 各一次查询 + snapshot 序列化 + 2 次冷路径读，**无模型调用** | 接受；注解不得改 `REQUIRES_NEW` |
| R3 | `@Transactional` 自调用失效 | 事务根在 `admit`，必须跨 bean 调用 | 已满足；注释写明「不可内联」（4.5） |
| R4 | 双重收尾（`AgentEventListener` 关流 + `chatStream` finally 再 `finish`） | 新增的失败事件也会关一次流 | 本方案不改动：现役 `/stop` 路径本就存在同样形态（`ChatServiceImpl:247` + 运行体 finally），属既有幂等收尾，与本次改造无关 |
| R5 | 仓储侧新增广播的幂等性 | 依赖「version 条件 + 行前态」两个既有保护 | 已由 7.3 ③ 的并发/重复用例覆盖 |
| R6 | 重启收尸路径不触发轮次收口 | 收尸走 `markOrphanRunsFailed` 的裸 SQL，不经 `save` | 由 `ChatTurnStartupReaper` 同机收口 ACCEPTED/RUNNING 轮次兜住，与今天一致 |
| R7 | 前端对失败事件的呈现 | 事件必达，但前端如何展示属前端议题（审计 BE-4/BE-12） | 本方案只保证事件与轮次状态的一致抵达 |
| 未决 | `admit` 的最终命名 | 本方案用 `admit`（受理）；如需贴合既有命名可改 `admitTurn` | 风格问题，不影响设计 |
| 未决 | 是否把档位解析进一步前移到 `prepare` | **不推荐**：会让 `RuntimeContext` 再多两个字段（人设 + 工具清单），并把「选人设与工具清单」这个编排器职责搬进 `shared/utils` | 代价大于收益 |

### 引用基准与已核对范围

- 全部 `文件:行号` 引用为 **2026-10-06 深夜**对本机工作区（`D:\Code\LingXi`，含大量未提交改动；
  其中 `ChatServiceImpl`、`PreparedChatExecutor`、`ChatAdmissionOrderTest`、`PreparedChatExecutorTest`、
  `ChatAcceptanceEndpointTest` 在两次读取之间已发生变化，本轮全部重读）实读所得。
- **业务侧实读**：`ChatServiceImpl`、`PreparedChatExecutor`、`RuntimeContext`、`RequestPreparer`、
  `AgentWorkflowOrchestrator(Impl)`、`IChatAgent`、`SubAgent`、`LocalExecutionRepository`、
  `ExecutionRegistrationService(Impl)`、`ExecutionRepositoryImpl`、`ExecutionMapper`、`Execution`(domain)、
  `ExecutionStatusCodes`、`ExecutionAttributes`、`ExecutionContext`、`ExecutionIdentity`、
  `ChatTurnService(Impl)`、`ChatTurnLifecycleListener`、`ChatTurnRuntimeListener`、`AgentEventListener`、
  `ApprovalFinalizer`、`SseEventPublisher`、`ExecutionLifecycleListener`、`init.sql`、
  `src/test/resources/*.sql`、上述 7 个测试类。
- **框架侧实读**（`D:\code\starter\lingxi-harness-agent`，只读）：`ChatAgent`、`Agent`、`AgentRequest`、
  `Execution`、`ExecutionControl`、`DefaultExecutionController`、`RuntimeProcessorTemplate`、
  `DefaultRuntimeLifeStyleManager`、`ExecutionErrorEvent` 链路。
- **未做**（受本轮范围限制）：未改任何业务代码、未编译、未跑测试、未启动服务。
  第七节的用例与断言是**验收要求**，不是已验证结果。

---

## 十一、实施记录（2026-10-06 23:47 → 2026-10-07 00:05）

按用户授权施工，**未提交、未推送**（按项目约定需明确指令）。

### 11.1 落地清单

| 文件 | 改动 |
|---|---|
| `RuntimeContext` | 增 `execution` 分量 + `withExecution`；11 参便捷构造器保留（既有构造点零改动） |
| `AgentWorkflowOrchestrator` / `Impl` | `createExecution(context)` + `execute(context, execution)`；新增 `resolveAgent`（创建与执行共用，避免 `agentId` 错配）；删三个 `executeXxx` |
| `PreparedChatExecutor` | 新增 `@Transactional admit`；`run` 的校验移入 `try`；`markStartupFailedQuietly` 收敛为「判状态 → `ExecutionControl.fail(...).run()`」；删 `broadcastStartupFailure` / `resolveHistoryRevision` / `start` 与三个依赖字段 |
| `ChatServiceImpl#commitUserMessage` | 改为委派 `chatExecutor.admit(context)`（四个入口共用此点） |
| `RequestPreparer` | 删登记服务字段、import 与 `registerInitial` 调用；修订两处 javadoc |
| `LocalExecutionRepository#save` | 新增「首次落 FAILED 且无控制槽位 → `afterCommit(notifyFinished)`」 |
| 删除 | `ExecutionRegistrationService`、`ExecutionRegistrationServiceImpl`、`markFailedIfUnfinished`（mapper / repoimpl / domain 三层）、`ExecutionStartupFailureClosureTest`；三个文件里随之失效的 `LocalDateTime` 等 import |
| 未做（对方已完成） | `IChatAgent` / `SubAgent` 的 javadoc 已由并行改动修正，本次未动 |

### 11.2 测试改动

- 机械更新：`RequestPreparerExecutionIdentityTest`、`SessionTeamBindingTest`、`CollaborationToolExposureTest`、`ChatResumeTeamAttributeTest`、`ChatAcceptanceEndpointTest`（桩从 `commitUserMessage` 移到 `admit`）。
- **施工中发现清单外的第 8 个构造点**：`AgentModelConfigurationTest:67` 用 15 个 `null` 构造 `RequestPreparer` → 改为 14 个。
- 重写：`ChatAdmissionOrderTest`（13 个用例：顺序、受理产物下行、受理失败释放资格、启动失败经框架收口并**真的 run 发布任务**、终态/挂起不重复收口、流式同序）。
- 重写：`PreparedChatExecutorTest`（真实 `LocalExecutionRepository` + `DefaultExecutionController` + `RuntimeEventPublisher` + 两个真实监听器，断言「轮次 FAILED → 失败原因 → 事件 → 关流」的 InOrder 与 `times(1)`）。
- 新增：`ChatAdmissionTransactionTest`（真实 H2 + `TransactionTemplate` + 三张真表真仓储：异常路径三表零行、正常路径三表各一行且 `snapshot` 非空）。
- 新增资源：`src/test/resources/session-message-schema.sql`（列形对齐 `init.sql`）。
- 新增守卫用例（放在 `LocalExecutionRepositoryResumeTest`，比放业务侧更贴调用点）：首次 FAILED 且无槽位才广播、活跃槽位交给 `unregister`、完成/挂起/重复 FAILED 不广播。

### 11.3 实施中的两处非显然约束（写进这里，避免下次重踩）

1. **测试的 MyBatis 配置不能关驼峰转下划线**：`ChatAdmissionTransactionTest` 一开始照抄既有测试的 `setMapUnderscoreToCamelCase(false)`，结果 `session_message` 的 INSERT 用了 `sessionId/turnId/contentType` 这类驼峰列名直接报 `Column "SESSIONID" not found`。原因：项目里只有 `SessionMessagePO` **没有 `@TableField`**（`ChatTurnPO` 16 个、`ExecutionPO` 8 个都有），它依赖该开关做列名映射。
2. **`admit` 在 `pendingUserMessage == null` 时是空操作**（与 `commitUserMessage` 同口径），因此测试上下文必须带待落库消息，否则 `run` 的执行对象校验会抛「执行未登记」—— 这是刻意的，不是漏判。

### 11.4 验收结果

| 项 | 结果 |
|---|---|
| 主代码编译 | `mvn -o -DskipTests compile` → **BUILD SUCCESS**，322 源文件，0 ERROR |
| 测试代码编译 | `mvn -o -DskipTests test-compile` → **BUILD SUCCESS** |
| 本次相关测试类 | **75 / 75 通过**（`ChatAdmissionOrderTest` 13、`PreparedChatExecutorTest` 5、`ChatAdmissionTransactionTest` 2、`LocalExecutionRepositoryResumeTest` 15、`ChatAcceptanceEndpointTest` 2、`ChatResumeTeamAttributeTest` 6、`SessionTeamBindingTest` 7、`CollaborationToolExposureTest` 11、`RequestPreparerExecutionIdentityTest` 5、`AgentModelConfigurationTest` 4、`ChatTurnLifecycleListenerTest` 6） |
| 全量测试 | 见 `.run/test-all.txt`（施工当时与并行改动同处一个工作区，若出现与本改动无关的红点会在汇报中逐条点名归属） |
| 未做 | 未提交/未推送；未做端到端（需重启 8088 后端，且起第二实例会被 `mcpManager` 的 SSL 握手挡住） |

⚠️ **施工期间工作区被并行改动**（另有 agent 在做前后端改造）：出现过一次 `target/classes` 被并发构建清空导致的 test-compile 假失败（报一批「程序包不存在」），重跑即恢复。凡在持续被改的工作区里验证，**不要据此改在建文件**，重跑一次再判定归属。

---

## 附录 A：v1 的错误与撤换（留档，避免重复踩）

| # | v1 的说法 | 实际 | 撤换为 |
|---|---|---|---|
| 1 | 在 `PreparedChatExecutor` 的 catch 里「先收口轮次、后调用 `fail(...).run()`」即可保证顺序 | `ChatAgent:106` 在 rethrow 之前就已 `.run()`，业务 catch 拿不到排序权 | 轮次收口改挂在 `LocalExecutionRepository.save`（「首次 FAILED 且无活跃槽位」→ `afterCommit(notifyFinished)`），落在框架 `save` 与 `publish` 的间隙里 |
| 2 | 挂起执行不 `fail`，但轮次仍由业务收口为 FAILED | 这会把挂起执行对应的轮次误标失败，与「挂起可恢复」冲突 | 业务侧**不再写**轮次终态；状态映射只由 `ChatTurnLifecycleListener` 一处决定（3.4） |
| 3 | 只改 `ChatServiceImpl#executePrepared` | 漏了 `acceptCommand` / `resend` / `submitAsync` / `failSubmit` 四个入口 | 改共同受理入口 `commitUserMessage`(:200)，四个调用点全覆盖（4.5） |
| 4 | `run` 里先校验再进 `try` | 校验抛异常会跳过 `finally`，运行资格不释放 ⇒ 会话永久锁死 | 校验移入 `try`（4.3） |
| 5 | 「三表没有同事务登记」 | 今天已有同事务登记（`registerInitial` 与 `acceptTurn`/`appendUser` 同事务） | 准确表述：缺的是**完整 snapshot** 与**正确的创建时机**（第一节） |
