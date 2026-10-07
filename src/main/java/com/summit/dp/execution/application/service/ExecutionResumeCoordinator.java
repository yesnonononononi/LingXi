package com.summit.dp.execution.application.service;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.SuspendedExecutionResumer;
import com.summit.dp.execution.domain.lifecycle.ExecutionActivity;
import com.summit.dp.execution.domain.lifecycle.ExecutionCoordination;
import com.summit.dp.execution.domain.model.ExecutionResumeTask;
import com.summit.dp.execution.domain.model.ResumeTaskState;
import com.summit.dp.execution.domain.repository.ExecutionResumeTaskRepository;
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
    /** 框架仓储经 ObjectProvider 断开构造期闭环：它由 LocalExecutionRepository 实现，与恢复链互为依赖。 */
    private final ObjectProvider<ExecutionRepository> frameworkExecutions;
    /** 控制槽位活跃判定；与 frameworkExecutions 同为实现类，语义不同，单独注入以免误用。 */
    private final ObjectProvider<ExecutionActivity> activity;

    /** 派发线程：与请求线程、loop 线程都分开，恢复失败不会拖垮受理响应。 */
    private final ExecutorService workers = Executors.newVirtualThreadPerTaskExecutor();
    /** 同执行已在派发中的标记；只防「同一瞬间重复唤醒」，真正的单飞靠 claim 条件更新。 */
    private final Map<String, AtomicBoolean> dispatching = new ConcurrentHashMap<>();

    public ExecutionResumeCoordinator(ExecutionResumeTaskRepository taskRepository,
                                      com.summit.dp.execution.domain.repository.ExecutionRepository executions,
                                      SuspendedExecutionResumer resumer,
                                      ExecutionControl executionControl,
                                      ObjectProvider<ExecutionRepository> frameworkExecutions,
                                      ObjectProvider<ExecutionActivity> activity) {
        this.taskRepository = taskRepository;
        this.executions = executions;
        this.resumer = resumer;
        this.executionControl = executionControl;
        this.frameworkExecutions = frameworkExecutions;
        this.activity = activity;
    }

    /**
     * 受理一次恢复请求并调度唯一一次派发。
     *
     * <p><b>调用方在决策事务内调用</b>：请求行与决策结论同事务提交，因此不存在
     * 「决策已落库但恢复请求没落库」的窗口。真正派发排在事务提交之后 ——
     * 它走独立线程，不会读到未提交的槽位状态。</p>
     *
     * @param executionId 执行 ID；0 表示没有可用执行（如命令卡片未挂执行）
     * @return 本次决策的恢复处置结论，供回执直接下发
     */
    public ResumeDisposition accept(long executionId) {
        if (executionId == 0L) {
            return ResumeDisposition.ENDED;
        }
        Integer status = readStatus(executionId);
        if (ExecutionStatusCodes.isTerminal(status)) {
            return ResumeDisposition.ENDED;
        }
        if (resumer.hasUnresolvedSlot(executionId)) {
            // 还有槽位：不派发、不落请求。最后一个槽位落定时它自己的决策会再走一遍 accept。
            return ResumeDisposition.WAITING_OTHER_TOOLS;
        }
        long generation = executions.findResumeGeneration(executionId);
        // 代际为 0 说明这次执行从未真正转入过 SUSPENDED（不应发生），按「无恢复边界」处理：
        // 硬派发会让 loop 拿到一个没有落定槽位的检查点。
        if (generation <= 0L) {
            return ResumeDisposition.ENDED;
        }
        if (isActive(executionId)) {
            // 已有 loop 持有控制槽位：本次决策不重复启动。
            return ResumeDisposition.RUNNING;
        }
        taskRepository.enqueue(executionId, generation, Instant.now());
        // 请求先随决策事务提交，派发动作排到提交之后；无事务同步时立即执行（单测与直调路径）。
        frameworkExecutions.getObject().afterCommit(() -> dispatch(executionId));
        return ResumeDisposition.QUEUED;
    }

    /**
     * 唤醒 worker 处理某执行上的恢复请求。
     *
     * <p>幂等：已在派发中就直接返回。真正的单飞由 {@code claim} 的 {@code eq(version)} 保证，
     * 这里的标记只用来避免「一次决策唤醒 N 个线程去抢同一条请求」。</p>
     */
    public void dispatch(long executionId) {
        String key = String.valueOf(executionId);
        AtomicBoolean gate = dispatching.computeIfAbsent(key, ignored -> new AtomicBoolean());
        if (!gate.compareAndSet(false, true)) {
            return;
        }
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
                    runOnce(executionId, task);
                }
            } catch (RuntimeException error) {
                log.error("恢复请求派发失败: executionId={}, error={}", executionId, error.toString());
            } finally {
                gate.set(false);
                // 门闩条目必须回收：否则并发执行的量级会让这张 map 随历史线性增长。
                dispatching.remove(key, gate);
            }
        });
    }

    /**
     * 在锁外跑一次恢复。
     *
     * <p>顺序刻意是「重读 → 判闸门 → 才运行」：领取时的状态是快照，可能已被 stop 或另一条
     * 决策改变，直接跑就会出现「已取消的执行被恢复」或「同一执行跑两个 loop」。</p>
     */
    private void runOnce(long executionId, ExecutionResumeTask task) {
        // 门闩只圈住「核对代际 + 写状态」这一小段；模型调用在临界区之外。
        synchronized (ExecutionCoordination.monitor(String.valueOf(executionId))) {
            if (supersedeIfStale(task)) {
                return;
            }
        }
        Execution execution = readCheckpoint(executionId);
        if (execution == null || ExecutionStatusCodes.isTerminalState(execution.getExecutionState())) {
            markSuperseded(task, "执行已结束，恢复请求作废");
            return;
        }
        if (execution.getExecutionState() != ExecutionState.SUSPENDED) {
            // 已在运行或已进入下一个阶段：交给现有控制槽位，不由本 worker 重复启动。
            markSuperseded(task, "执行已不在挂起态，无需本请求恢复");
            return;
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
                || ExecutionStatusCodes.isTerminalState(latest.getExecutionState())
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
        try {
            if (ExecutionStatusCodes.isTerminalState(execution.getExecutionState())) {
                return;
            }
            executionControl.fail(execution, cause).run();
        } catch (RuntimeException closeFailure) {
            // 收口失败只告警，绝不掩盖原始异常。
            log.warn("收口启动失败的执行时出错: executionId={}, cause={}, 收口失败原因={}",
                    execution.getId(), cause.toString(), closeFailure.toString());
        }
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
     * 读执行状态编码；只取摘要列，不加载 LONGTEXT 检查点。
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
