package com.summit.dp.workflow.application.resume;

import org.springframework.beans.factory.annotation.Autowired;
import com.summit.dp.workflow.application.input.InputWakeupService;
import com.summit.dp.workflow.application.input.InputAutomationPolicy;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.application.port.ExecutionActivity;
import com.summit.dp.execution.application.service.ResumeDisposition;
import com.summit.dp.execution.domain.model.ExecutionResumeTask;
import com.summit.dp.execution.domain.model.ResumeTaskState;
import com.summit.dp.execution.domain.repository.ExecutionResumeTaskRepository;
import com.summit.dp.workflow.infrastructure.harness.ExecutionIdentity;
import com.summit.dp.workflow.infrastructure.harness.ExecutionStateCodec;
import com.summit.dp.workflow.infrastructure.lifecycle.ExecutionCoordination;
import com.summit.dp.workflow.application.lifecycle.ExecutionLaunchRole;
import com.summit.dp.workflow.application.lifecycle.StartupFailureCloser;
import com.summit.dp.workflow.application.lifecycle.GateCheckResult;
import com.summit.dp.workflow.application.lifecycle.ResumeTriggerType;
import com.summit.dp.workflow.application.lifecycle.SuspensionGateChain;
import com.summit.dp.workflow.application.lifecycle.UnresolvedToolSuspensionGate;
import jakarta.annotation.PreDestroy;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 三条恢复路径（PLAN/CHOICE 决策、COMMAND T2、委派回填）共用的恢复派发口。
 *
 * <p><b>为什么必须先落库再派发</b>：决策事务提交与「把恢复动作派发出去」之间有进程崩溃窗口 ——
 * 用户点了批准、决策已落库，恢复却没派发，进程就死了。恢复请求先写
 * {@code execution_resume_task}，派发只做「唤醒 worker」，两者之间不再有可信的原子性假设。
 * 反过来（先派发后落库）会在崩溃后留下无人认领的恢复。请求行的唯一用途就是这一件事：
 * 重启后区分「正常等待审批的 SUSPENDED」与「已批准但恢复没起步的 SUSPENDED」。</p>
 *
 * <p><b>只尝试一次</b>：批准 = 「决策已落库，后端只尝试恢复一次」。启动失败即收口成 FAILED，
 * 不重试、不退避、不轮询。因此重试次数、退避时刻与巡检线程全部取消：恢复不再有
 * 「稍后再来」的中间态，{@code execution_resume_task} 退化为一条纯请求记录。</p>
 *
 * <p><b>worker 纪律（每条都是硬约束，改动前逐条确认）</b>：</p>
 * <ol>
 *   <li><b>短事务领取，锁外跑模型</b>：{@code claim} 是一次条件更新就结束；模型调用在
 *       {@link #runOnce} 里，全程不持任何锁。</li>
 *   <li><b>重新读取执行</b>：领取时看到的状态是快照，可能已被 stop 或另一条决策改变。
 *       已终态 / 已不在挂起态 / 代际已变一律让位，不启动第二次 loop。</li>
 *   <li><b>控制槽位是竞争判据</b>：{@link ExecutionActivity#isActive} 为真说明已有 loop
 *       持有该执行的控制槽位，本 worker 让位 —— <b>竞争失败绝不记成执行失败</b>。</li>
 *   <li><b>不外层重复 register</b>：恢复用既有 {@code executionControl.resume} 的登记互斥，
 *       在它之外再 register 一次会与自己抢锁。</li>
 *   <li><b>状态写入按 version 条件</b>：释放锁到框架 register 之间 stop 可能已落库 CANCELLED，
 *       无条件写会把 CANCELLED 改回去。</li>
 * </ol>
 *
 * <p><b>锁回收</b>：本类不用「按 executionId 建锁对象」的 map，直接复用
 * {@link ExecutionCoordination} 的固定 256 条门闩 —— 它按 id 哈希取模，常驻内存恒定，
 * 不存在 map 无限增长的问题。单飞由 {@code claim} 的条件更新保证；派发中的标记用完即回收。</p>
 */
@Slf4j
@Service
public class ExecutionResumeCoordinator {

    private final ExecutionResumeTaskRepository taskRepository;
    private final com.summit.dp.execution.domain.repository.ExecutionRepository executions;
    private final SuspendedExecutionResumer resumer;
    private final ExecutionControl executionControl;
    /** 锁内复检用的门禁链：与手动预检同一份定义，差别只在「不通过怎么办」。 */
    private final SuspensionGateChain gates;
    /** 未决槽位判定只有一份：审批流程与恢复入口都从这里取。 */
    private final UnresolvedToolSuspensionGate unresolvedToolGate;
    /** 框架仓储经 ObjectProvider 断开构造期闭环：它由 LocalExecutionRepository 实现，与恢复链互为依赖。 */
    private final ObjectProvider<ExecutionRepository> frameworkExecutions;
    /** 控制槽位活跃判定；与 frameworkExecutions 同为实现类，语义不同，单独注入以免误用。 */
    private final ObjectProvider<ExecutionActivity> activity;
    /** 启动失败收口口径的唯一实现；本类只按 RESUME 角色调用它。 */
    private final StartupFailureCloser startupFailureCloser;

    /** 派发线程：与请求线程、loop 线程都分开，恢复失败不会拖垮受理响应。 */
    @Autowired
    private ObjectProvider<InputWakeupService> inputWakeups;
    private final ExecutorService workers = Executors.newVirtualThreadPerTaskExecutor();
    /** 同执行已在派发中的标记；只防「同一瞬间重复唤醒」，真正的单飞靠 claim 条件更新。 */
    private final Map<String, AtomicBoolean> dispatching = new ConcurrentHashMap<>();
    public ExecutionResumeCoordinator(ExecutionResumeTaskRepository taskRepository,
                                      com.summit.dp.execution.domain.repository.ExecutionRepository executions,
                                      SuspendedExecutionResumer resumer,
                                      ExecutionControl executionControl,
                                      SuspensionGateChain gates,
                                      UnresolvedToolSuspensionGate unresolvedToolGate,
                                      ObjectProvider<ExecutionRepository> frameworkExecutions,
                                      ObjectProvider<ExecutionActivity> activity,
                                      StartupFailureCloser startupFailureCloser) {
        this.taskRepository = taskRepository;
        this.executions = executions;
        this.resumer = resumer;
        this.executionControl = executionControl;
        this.gates = gates;
        this.unresolvedToolGate = unresolvedToolGate;
        this.frameworkExecutions = frameworkExecutions;
        this.activity = activity;
        this.startupFailureCloser = startupFailureCloser;
    }

    /**
     * 受理一次恢复请求并调度唯一一次派发（触发来源按自动唤醒处理）。
     *
     * <p>单参入口保留给「确实是机器唤醒」的调用方与直调路径；带来源的调用方必须显式声明，
     * 否则人工决策会拿不到人工待遇（见 {@link #accept(long, ResumeTriggerType)}）。</p>
     *
     * @param executionId 执行 ID；0 表示没有可用执行（如命令卡片未挂执行）
     * @return 本次决策的恢复处置结论，供回执直接下发
     */
    public ResumeDisposition accept(long executionId) {
        return accept(executionId, ResumeTriggerType.AUTO_INPUT_WAKEUP);
    }

    /**
     * 受理一次恢复请求并调度唯一一次派发。
     *
     * <p><b>调用方在决策事务内调用</b>：请求行与决策结论同事务提交，因此不存在
     * 「决策已落库但恢复请求没落库」的窗口。真正派发排在事务提交之后 ——
     * 它走独立线程，不会读到未提交的槽位状态。</p>
     *
     * <p><b>触发来源只在内存里传递，不落库</b>：它只影响消费端复检的门禁口径，
     * 不是请求的持久语义。进程重启后重投的请求按自动唤醒处理 —— 保守方向是「保持挂起」，
     * 用户仍可手动恢复；反过来把重投的请求当人工决策放行，就等于让一次崩溃替用户批准了工具。</p>
     *
     * @param executionId 执行 ID；0 表示没有可用执行（如命令卡片未挂执行）
     * @param trigger     触发来源；决定消费端复检时哪些门禁对它生效
     * @return 本次决策的恢复处置结论，供回执直接下发
     */
    public ResumeDisposition accept(long executionId, ResumeTriggerType trigger) {
        // 缺省来源是编程错误：静默退化成自动唤醒正是「人工批准被轮次上限吞掉」的成因。
        throwIf(trigger == null, "恢复触发来源不能为空");
        if (executionId == 0L) {
            return ResumeDisposition.ENDED;
        }
        Integer status = readStatus(executionId);
        if (ExecutionStatusCodes.isTerminal(status)) {
            return ResumeDisposition.ENDED;
        }
        if (unresolvedToolGate.hasUnresolvedSlot(executionId)) {
            // 还有槽位：不派发、不落请求。最后一个槽位落定时它自己的决策会再走一遍 accept。
            return ResumeDisposition.WAITING_OTHER_TOOLS;
        }
        if (isActive(executionId)) {
            // 活跃循环自己检查输入，退出后再按事实复查。
            return ResumeDisposition.RUNNING;
        }
        long generation = executions.findResumeGeneration(executionId);
        // 代际为 0 说明这次执行从未真正转入过 SUSPENDED（不应发生），按「无恢复边界」处理：
        // 硬派发会让 loop 拿到一个没有落定槽位的检查点。
        if (generation <= 0L) {
            return ResumeDisposition.ENDED;
        }
        taskRepository.enqueue(executionId, generation, Instant.now());
        // 请求先随决策事务提交，派发动作排到提交之后；无事务同步时立即执行（单测与直调路径）。
        frameworkExecutions.getObject().afterCommit(() -> dispatch(executionId, trigger));
        return ResumeDisposition.QUEUED;
    }

    /**
     * 唤醒 worker 处理某执行上的恢复请求（触发来源按自动唤醒处理）。
     *
     * <p>崩溃遗留、启动收口这类「没人告诉我们是谁触发的」重投都走这里：保守按自动唤醒，
     * 门禁全查，宁愿保持挂起也不替人做决定。</p>
     */
    public void dispatch(long executionId) {
        dispatch(executionId, ResumeTriggerType.AUTO_INPUT_WAKEUP);
    }

    /**
     * 唤醒 worker 处理某执行上的恢复请求。
     *
     * <p>幂等：已在派发中就直接返回。真正的单飞由 {@code claim} 的 {@code eq(version)} 保证，
     * 这里的标记只用来避免「一次决策唤醒 N 个线程去抢同一条请求」。</p>
     */
    public void dispatch(long executionId, ResumeTriggerType trigger) {
        String key = String.valueOf(executionId);
        AtomicBoolean gate = dispatching.computeIfAbsent(key, ignored -> new AtomicBoolean());
        if (!gate.compareAndSet(false, true)) {
            return;
        }
        try {
            workers.execute(() -> {
                try {
                    for (ExecutionResumeTask task : taskRepository.findByExecutionId(executionId)) {
                        if (isFinished(task)) {
                            continue;
                        }
                        // 领取失败说明已被另一 worker 领走或已作废：让位，不重复跑 loop。
                        if (!taskRepository.claim(task)) {
                            continue;
                        }
                        runOnce(executionId, task, trigger);
                        if (inputWakeups != null) inputWakeups.getObject().resumeIfInputPending(executionId);
                    }
                } catch (RuntimeException error) {
                    log.error("恢复请求派发失败: executionId={}, error={}", executionId, error.toString());
                } finally {
                    releaseGate(key, gate);
                    // 退出前复查：worker 运行期间新入队的请求可能因门闩 CAS 失败被挡掉，
                    // 此处门闩已释放，重新派发即可领到它（CAS 成功）。只认仍 READY 的请求，
                    // 已被他人领取 / 已收口的请求不再触发，避免空转。
                    // 来源沿用本次：同一执行上并发的请求多半来自同一类触发（决策或唤醒）；
                    // 若这里退化成自动唤醒，被 CAS 挡掉的审批请求会在轮次上限处被静默作废 —— 那正是要修的缺陷。
                    if (hasReadyTask(executionId)) {
                        dispatch(executionId, trigger);
                    }
                }
            });
        } catch (RejectedExecutionException rejected) {
            // 提交被拒（线程池正在关闭）：lambda 永不运行，其 finally 也不会执行 ——
            // 必须在这里同款回收闸门，否则该执行的重试会被 CAS 永久挡住。
            releaseGate(key, gate);
            log.warn("恢复派发提交被拒，已回收派发闸门: executionId={}", executionId);
        }
    }

    /**
     * 释放派发闸门（置回未占用并回收条目）。
     *
     * <p>闸门与被提交的 lambda 是两处生命周期：lambda 未运行（提交被拒）时其 {@code finally}
     * 不会执行，必须由提交侧兜底回收，否则该执行后续的重试会被 CAS 永久挡在门外。</p>
     */
    private void releaseGate(String key, AtomicBoolean gate) {
        gate.set(false);
        // 门闩条目必须回收：否则并发执行的量级会让这张 map 随历史线性增长。
        dispatching.remove(key, gate);
    }

    /** 该执行下是否还有仍处于 READY 的恢复请求（新入队、尚未被任何 worker 领取）。 */
    private boolean hasReadyTask(long executionId) {
        for (ExecutionResumeTask live : taskRepository.listLiveByExecution(executionId)) {
            if (live.getState() == ResumeTaskState.READY) {
                return true;
            }
        }
        return false;
    }

    /**
     * 在锁外跑一次恢复。
     *
     * <p>顺序刻意是「重读 → 判闸门 → 才运行」：领取时的状态是快照，可能已被 stop 或另一条
     * 决策改变，直接跑就会出现「已取消的执行被恢复」或「同一执行跑两个 loop」。</p>
     *
     * @param trigger 本次请求的触发来源：门禁口径由它决定，<b>不能在这里写死</b> ——
     *                写死成自动唤醒会把人工决策一起按自动唤醒的规则拦掉
     */
    private void runOnce(long executionId, ExecutionResumeTask task, ResumeTriggerType trigger) {
        // 门闩只圈住「核对代际 + 写状态」这一小段；模型调用在临界区之外。
        synchronized (ExecutionCoordination.monitor(String.valueOf(executionId))) {
            if (supersedeIfStale(task)) {
                return;
            }
        }
        Execution execution = readCheckpoint(executionId);
        if (execution == null || ExecutionStateCodec.isTerminalState(execution.getExecutionState())) {
            markSuperseded(task, "执行已结束，恢复请求作废");
            return;
        }
        if (execution.getExecutionState() != ExecutionState.SUSPENDED) {
            // 已在运行或已进入下一个阶段：交给现有控制槽位，不由本 worker 重复启动。
            markSuperseded(task, "执行已不在挂起态，无需本请求恢复");
            return;
        }
        // 锁内复检：与手动入口的同步预检同一套门禁，口径由触发来源决定。不通过就静默保持挂起 ——
        // 这不是失败，只是「还没条件恢复」，标失败会把「等审批」错记成「恢复崩了」。
        synchronized (ExecutionCoordination.monitor(String.valueOf(executionId))) {
            GateCheckResult readiness = gates.checkReadiness(execution, trigger);
            if (!readiness.allowed()) {
                markSuperseded(task, "挂起门禁未放行: " + readiness.reason());
                return;
            }
        }
        if (isActive(executionId)) {
            // 已有 loop 持有控制槽位：让位。竞争失败不是执行失败，绝不改判。
            markSuperseded(task, "执行已有运行持有控制槽位，恢复请求作废");
            return;
        }
        Long conversationId = resolveConversationId(execution);
        if (conversationId == null) {
            markFailed(task, "执行缺少会话归属，无法恢复");
            return;
        }
        try {
            // 恢复闸门与恢复动作都在 SuspendedExecutionResumer 内：补会话属性 → resume → 回写上下文。
            // 不在本类外层再 register 一次 —— 框架的 resume 已带登记互斥，重复登记会与自己抢锁。
            resumer.resume(execution, conversationId);
            task.succeed();
            taskRepository.updateState(task);
        } catch (Exception error) {
            if (isInterrupt(error)) {
                // 中断来自关闭（close → shutdownNow），不是启动失败：此时执行仍是挂起态、恢复请求
                // 并没有失效，把行留在未完成态，由启动收口兜底。
                Thread.currentThread().interrupt();
                log.warn("恢复被中断（关闭），请求留在未完成态待启动收口: executionId={}", executionId);
                return;
            }
            handleStartupFailure(executionId, task, error);
        }
    }

    /**
     * 恢复抛异常后的判责：先重读落库状态与控制槽位，只有确属启动失败才收口。
     *
     * <p>框架 {@code RuntimeProcessorTemplate.process} 的顺序是「先 save(execution)、
     * resumeChecked 后再 save、然后才进 loop」，即状态先落库、loop 后运行。因此异常后重读：
     * 执行已终态 / 已离开挂起态 / 代际已变 / 已有运行持有控制槽位，都说明框架已接管或
     * stop 已落地 —— 让位即可，<b>绝不把这种竞争失败改判成执行失败</b>。这正是
     * 「loop 已跑完、随后回写上下文抛异常」这类场景的护栏。</p>
     */
    private void handleStartupFailure(long executionId, ExecutionResumeTask task, Exception error) {
        Execution latest = readCheckpoint(executionId);
        boolean takenOver = latest == null
                || Boolean.TRUE.equals(InputAutomationPolicy.attributes(latest).get(InputAutomationPolicy.USER_PAUSED))
                || ExecutionStateCodec.isTerminalState(latest.getExecutionState())
                || latest.getExecutionState() != ExecutionState.SUSPENDED
                || executions.findResumeGeneration(executionId) != task.getGeneration()
                || isActive(executionId);
        if (takenOver) {
            markSuperseded(task, "执行已离开挂起点或已有运行接管，恢复请求作废");
            return;
        }
        // 仍 SUSPENDED 且无控制槽位：确属启动失败。收口执行（终态 + 结束时间 + 轮次收口 + 终态事件），
        // 再记下失败原因。
        closeFailedExecution(latest, error);
        markFailed(task, "恢复启动失败: " + error.getMessage());
    }

    /**
     * 启动失败收口：复用框架的失败链，不手写轮次收口。
     *
     * <p>{@code ExecutionControl.fail} 先落库（终态 + 结束时间），再由仓储在提交后通知轮次收口、
     * 清理未决工具并发布终态事件 —— 业务侧手工再写一遍轮次会与它打架。</p>
     *
     * <p><b>只拦终态</b>：{@code failChecked} 对终态会抛「非法状态转换」，故先短路；而
     * SUSPENDED → FAILED 是合法转换（{@code failChecked} 只拦终态），这正是「已批准但启动失败」
     * 要收的口 —— 若照抄 {@code PreparedChatExecutor} 里「SUSPENDED 一律跳过」的守卫，
     * 这一支将永远收不了口。</p>
     */
    private void closeFailedExecution(Execution execution, Exception cause) {
        // 收口口径只有一处定义（StartupFailureCloser 按角色分三种）；恢复启动连挂起态也要收口。
        startupFailureCloser.closeQuietly(execution, cause, ExecutionLaunchRole.RESUME);
    }

    /**
     * 启动收口入口：把某执行按框架失败链落成终态；供启动收尸钩子复用同一处「怎么收口」。
     *
     * <p>读不到检查点（执行行已不存在）时无对象可收，直接返回。</p>
     */
    public void closeStartupFailure(long executionId, String reason) {
        Execution execution = readCheckpoint(executionId);
        if (execution == null) {
            return;
        }
        closeFailedExecution(execution, new IllegalStateException(reason));
    }

    /** 代际已变或请求已被作废 → 标 SUPERSEDED；返回 true 表示本 worker 必须让位。 */
    private boolean supersedeIfStale(ExecutionResumeTask task) {
        if (isFinished(task)) {
            return true;
        }
        long current = executions.findResumeGeneration(task.getExecutionId());
        if (current != task.getGeneration()) {
            markSuperseded(task, "恢复代际已变更，请求作废");
            return true;
        }
        return false;
    }

    private void markSuperseded(ExecutionResumeTask task, String reason) {
        if (!task.supersede()) {
            return;
        }
        if (!taskRepository.updateState(task)) {
            // 条件更新落空 = 另一方已改过状态；此时不得强行覆盖。
            log.debug("恢复请求作废时状态已变化: taskId={}, reason={}", task.getId(), reason);
        }
    }

    /** 启动失败已收口：记失败原因，不再派发。 */
    private void markFailed(ExecutionResumeTask task, String reason) {
        task.fail(reason);
        if (!taskRepository.updateState(task)) {
            log.warn("恢复失败状态未能落库，可能已被他人改写: taskId={}, reason={}", task.getId(), reason);
        }
    }

    /**
     * 读执行状态编码；只取摘要列，不加载检查点正文。
     *
     * <p>行不存在返回 {@code null}（视为非终态），后续由「读不到检查点」这一步收敛 ——
     * 凭空按终态处理会让一个刚建好的执行被误判成已结束。</p>
     */
    private Integer readStatus(long executionId) {
        return executions.findSummariesByIds(List.of(executionId)).stream()
                .findFirst()
                .map(com.summit.dp.execution.domain.model.Execution::getStatus)
                .orElse(null);
    }

    private Execution readCheckpoint(long executionId) {
        try {
            return frameworkExecutions.getObject().findById(String.valueOf(executionId)).orElse(null);
        } catch (RuntimeException error) {
            log.warn("读取执行检查点失败: executionId={}, error={}", executionId, error.toString());
            return null;
        }
    }

    /**
     * 解析执行归属会话；取不到返回 {@code null}。
     *
     * <p>这里必须容忍「属性缺失」而不是让它抛出去：恢复失败属于请求级失败，
     * 抛出会把整个派发线程带走，其他执行的请求再也派发不了。</p>
     */
    private Long resolveConversationId(Execution execution) {
        try {
            return ExecutionIdentity.sessionId(execution);
        } catch (RuntimeException error) {
            log.warn("解析执行会话归属失败: executionId={}, error={}", execution.getId(), error.toString());
            return null;
        }
    }

    private boolean isActive(long executionId) {
        return activity.getObject().isActive(String.valueOf(executionId));
    }

    /**
     * 入口参数校验。
     *
     * <p>抛 {@link IllegalArgumentException} 而不是 {@code ClientException}：这里的入参来自内部调用方，
     * 传空是编程错误、不是用户输入错误 —— 变成业务错误回执会把这类缺陷伪装成「操作失败」。</p>
     */
    private void throwIf(boolean condition, String err) {
        if (condition) {
            throw new IllegalArgumentException(err);
        }
    }

    /**
     * 是否已无自动工作可做。
     *
     * <p>FAILED（启动失败已收口）与 SUCCEEDED / SUPERSEDED 一样不再派发，一并短路。</p>
     */
    private static boolean isFinished(ExecutionResumeTask task) {
        return task.getState() == ResumeTaskState.SUCCEEDED
                || task.getState() == ResumeTaskState.SUPERSEDED
                || task.getState() == ResumeTaskState.FAILED;
    }

    /** 中断（关闭）不是启动失败：沿异常链或线程中断标志识别。 */
    private static boolean isInterrupt(Throwable error) {
        if (Thread.currentThread().isInterrupted()) {
            return true;
        }
        for (Throwable cause = error; cause != null; cause = cause.getCause()) {
            if (cause instanceof InterruptedException) {
                return true;
            }
        }
        return false;
    }

    /** 关闭时停掉派发线程，避免非托管场景下的线程泄漏。 */
    @PreDestroy
    public void close() {
        workers.shutdownNow();
    }
}
