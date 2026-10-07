package com.summit.dp.execution.application.service;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.SuspendedExecutionResumer;
import com.summit.dp.execution.domain.lifecycle.ExecutionCoordination;
import com.summit.dp.execution.domain.model.ExecutionResumeTask;
import com.summit.dp.execution.domain.model.ResumeTaskState;
import com.summit.dp.execution.domain.repository.ExecutionResumeTaskRepository;
import com.summit.dp.shared.exception.ClientException;
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
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 三条恢复路径（PLAN/CHOICE 决策、COMMAND T2、委派回填）共用的恢复派发口。
 *
 * <p><b>为什么必须先落库再派发</b>：决策事务提交与「把任务丢给线程」之间有进程崩溃窗口 ——
 * 用户点了批准、决策已落库，恢复却没派发出去，进程就死了。恢复意图先写
 * {@code execution_resume_task}，派发只做「唤醒 worker」，两者之间不再有可信的原子性假设。
 * 反过来（先派发后落库）会在崩溃后留下无人认领的恢复。</p>
 *
 * <p><b>worker 纪律（每条都是硬约束，改动前逐条确认）</b>：</p>
 * <ol>
 *   <li><b>短事务领取，锁外跑模型</b>：{@code claim} 是一次条件更新就结束；
 *       模型调用在 {@link #runLoop} 里，全程不持任何锁。</li>
 *   <li><b>重新读取执行与未决集合</b>：领取时看到的状态是快照，可能已被 stop 或另一条决策
 *       改变。仍有槽位就重新入队等待，不恢复。</li>
 *   <li><b>已终态 / 已运行 / 已换 generation 一律让位</b>：任务标 SUPERSEDED，
 *       绝不启动第二次 loop。</li>
 *   <li><b>不外层重复 register</b>：恢复用既有 {@code executionControl.resume} 的登记互斥，
 *       在它之外再 register 一次会与自己抢锁。</li>
 *   <li><b>状态写入按 version 条件</b>：释放锁到框架 register 之间 stop 可能已落库 CANCELLED，
 *       无条件写会把 CANCELLED 改回去。</li>
 * </ol>
 *
 * <p><b>锁回收</b>：本类不用「按 executionId 建锁对象」的 map，直接复用
 * {@link ExecutionCoordination} 的固定 256 条门闩 —— 它按 id 哈希取模，常驻内存恒定，
 * 不存在 map 无限增长的问题。单飞则由 {@code claim} 的条件更新保证（同一任务只有一方能领到）；
 * 派发中的标记用完即从 map 里移除，不留历史条目。</p>
 */
@Slf4j
@Service
public class ExecutionResumeCoordinator {

    /** 恢复重试上限；达到后不再自动派发，交由用户手工触发恢复。 */
    public static final int MAX_ATTEMPTS = 3;
    /** 退避基数（毫秒），按尝试次数指数放大。 */
    private static final long RETRY_BACKOFF_MILLIS = 2_000L;
    /** 巡检间隔：兜住「任务已落库但派发动作本身丢了」的情况。 */
    private static final long SWEEP_INTERVAL_SECONDS = 5L;
    private static final int SWEEP_BATCH = 50;
    /** 已结束任务的回收窗口：终态任务没有保留价值，留着只会让表无限增长。 */
    private static final long PURGE_AFTER_SECONDS = 3600L;

    private final ExecutionResumeTaskRepository taskRepository;
    private final com.summit.dp.execution.domain.repository.ExecutionRepository executions;
    private final SuspendedExecutionResumer resumer;
    /** 框架仓储经 ObjectProvider 断开构造期闭环：它由 LocalExecutionRepository 实现，与恢复链互为依赖。 */
    private final ObjectProvider<ExecutionRepository> frameworkExecutions;

    /** 派发线程：与请求线程、loop 线程都分开，恢复失败不会拖垮受理响应。 */
    private final ExecutorService workers = Executors.newVirtualThreadPerTaskExecutor();
    /** 同执行已在派发中的标记；只防「同一瞬间重复唤醒」，真正的单飞靠 claim 条件更新。 */
    private final Map<String, AtomicBoolean> dispatching = new ConcurrentHashMap<>();
    private final ScheduledExecutorService sweeper =
            Executors.newSingleThreadScheduledExecutor(task -> {
                Thread thread = new Thread(task, "resume-task-sweeper");
                thread.setDaemon(true);
                return thread;
            });

    public ExecutionResumeCoordinator(ExecutionResumeTaskRepository taskRepository,
                                      com.summit.dp.execution.domain.repository.ExecutionRepository executions,
                                      SuspendedExecutionResumer resumer,
                                      ObjectProvider<ExecutionRepository> frameworkExecutions) {
        this.taskRepository = taskRepository;
        this.executions = executions;
        this.resumer = resumer;
        this.frameworkExecutions = frameworkExecutions;
        this.sweeper.scheduleWithFixedDelay(this::sweep, SWEEP_INTERVAL_SECONDS, SWEEP_INTERVAL_SECONDS,
                TimeUnit.SECONDS);
    }

    /**
     * 受理一次恢复意图并立即尝试派发。
     *
     * <p><b>调用方在决策事务内调用</b>：任务行与决策结论同事务提交，因此不存在
     * 「决策已落库但恢复意图没落库」的窗口。真正派发在 {@link #dispatch} 提交后才发生 ——
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
            return ResumeDisposition.WAITING_OTHER_TOOLS;
        }

        long generation = executions.findResumeGeneration(executionId);
        // 代际为 0 说明这次执行从未真正转入过 SUSPENDED（不应发生），按「无恢复边界」处理：
        // 硬派发会让 loop 拿到一个没有落定槽位的检查点。
        if (generation <= 0L) {
            return ResumeDisposition.ENDED;
        }
        taskRepository.enqueue(executionId, generation, Instant.now());
        dispatch(executionId);
        return ResumeDisposition.QUEUED;
    }

    /**
     * 唤醒 worker 处理某执行上所有可派发任务。
     *
     * <p>幂等：已在派发中就直接返回。真正的单飞由 {@code claim} 的 {@code eq(version)} 保证，
     * 这里的标记只用来避免「一次决策唤醒 N 个线程去抢同一条任务」。</p>
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
                    if (!taskRepository.claim(task, Instant.now())) {
                        continue;
                    }
                    runLoop(executionId, task);
                }
            } catch (RuntimeException error) {
                log.error("恢复任务派发失败: executionId={}, error={}", executionId, error.toString());
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
    private void runLoop(long executionId, ExecutionResumeTask task) {
        // 门闩只圈住「核对 + 写状态」这一小段；模型调用在临界区之外。
        synchronized (ExecutionCoordination.monitor(String.valueOf(executionId))) {
            if (supersedeIfStale(task)) {
                return;
            }
        }

        Execution execution = readCheckpoint(executionId);
        if (execution == null || ExecutionStatusCodes.isTerminalState(execution.getExecutionState())) {
            markSuperseded(task, "执行已结束，恢复意图作废");
            return;
        }
        if (execution.getExecutionState() != ExecutionState.SUSPENDED) {
            // 已在运行或已进入下一个阶段：交给现有控制槽位，不由本 worker 重复启动。
            markSuperseded(task, "执行已不在挂起态，无需本任务恢复");
            return;
        }
        if (resumer.hasUnresolvedSlot(executionId)) {
            // 还有槽位：重新回到可派发态等下一轮，不恢复。
            requeueWaiting(task);
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
        } catch (RuntimeException error) {
            // 恢复失败不回退已落库的决策：只标记任务，用户仍可手工重试「恢复执行」。
            // 已达重试上限时置 EXHAUSTED（无退避），而不是 FAILED + nextAttemptAt=null ——
            // 后者会被 listDispatchable 的 nextAttemptAt IS NULL 条件当作「可立即派发」反复选中。
            if (task.exhausted(MAX_ATTEMPTS)) {
                markExhausted(task, error.toString());
            } else {
                markFailed(task, error.toString(), Instant.now().plusMillis(backoffMillis(task.getAttempts())));
            }
            log.error("恢复执行失败: executionId={}, generation={}, attempts={}",
                    executionId, task.getGeneration(), task.getAttempts());
        }
    }

    /** 代际已变或任务已被作废 → 标 SUPERSEDED；返回 true 表示本 worker 必须让位。 */
    private boolean supersedeIfStale(ExecutionResumeTask task) {
        if (isFinished(task)) {
            return true;
        }
        long current = executions.findResumeGeneration(task.getExecutionId());
        if (current != task.getGeneration()) {
            markSuperseded(task, "恢复代际已变更，任务作废");
            return true;
        }
        return false;
    }

    private void requeueWaiting(ExecutionResumeTask task) {
        // 仍有槽位时不标失败：这是「还没到时候」，不是错误。退回可派发态由巡检再唤醒。
        task.deferTo(Instant.now().plusMillis(RETRY_BACKOFF_MILLIS));
        if (!taskRepository.updateState(task)) {
            log.debug("等待槽位的恢复任务状态已被改写: taskId={}", task.getId());
        }
    }

    private void markSuperseded(ExecutionResumeTask task, String reason) {
        if (!task.supersede()) {
            return;
        }
        if (!taskRepository.updateState(task)) {
            // 条件更新落空 = 另一方已改过状态；此时不得强行覆盖。
            log.debug("恢复任务作废时状态已变化: taskId={}, reason={}", task.getId(), reason);
        }
    }

    /** 永久失败（不再自动重试）：{@code retryAt} 传 {@code null}。 */
    private void markFailed(ExecutionResumeTask task, String reason) {
        markFailed(task, reason, null);
    }

    private void markFailed(ExecutionResumeTask task, String reason, Instant retryAt) {
        task.fail(reason, retryAt);
        if (!taskRepository.updateState(task)) {
            log.warn("恢复失败状态未能落库，可能已被他人改写: taskId={}, reason={}", task.getId(), reason);
        }
    }

    /** 重试耗尽：置 EXHAUSTED（等价于「永久失败」，无退避），不再自动派发。 */
    private void markExhausted(ExecutionResumeTask task, String reason) {
        task.exhaustRetries(reason);
        if (!taskRepository.updateState(task)) {
            log.warn("恢复耗尽状态未能落库，可能已被他人改写: taskId={}, reason={}", task.getId(), reason);
        }
    }

    /** 失败退避按尝试次数指数放大，避免恢复失败时把线程池打满。 */
    private static long backoffMillis(int attempts) {
        int exponent = Math.clamp(attempts, 1, 6);
        return RETRY_BACKOFF_MILLIS * (1L << (exponent - 1));
    }

    /**
     * 巡检：捞起所有可派发任务逐个唤醒。
     *
     * <p>存在的意义是覆盖「任务已落库但那次派发动作本身没发生」——除了进程崩溃，
     * 决策事务提交后线程池拒绝任务也会留下同样的空档。幂等：已在派发中的执行会被跳过。</p>
     */
    private void sweep() {
        try {
            List<ExecutionResumeTask> pending = taskRepository.listDispatchable(Instant.now(), SWEEP_BATCH);
            for (ExecutionResumeTask task : pending) {
                dispatch(task.getExecutionId());
            }
            taskRepository.purgeFinishedBefore(Instant.now().minusSeconds(PURGE_AFTER_SECONDS));
        } catch (RuntimeException error) {
            log.error("恢复任务巡检失败: error={}", error.toString());
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
                .map(summary -> summary.getStatus())
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
     * <p>这里必须容忍「属性缺失」而不是让它抛出去：恢复失败属于任务级失败，
     * 抛出会把整个巡检线程带走，其他执行的任务再也派发不了。</p>
     */
    private Long resolveConversationId(Execution execution) {
        try {
            return ExecutionIdentity.sessionId(execution);
        } catch (RuntimeException error) {
            log.warn("解析执行会话归属失败: executionId={}, error={}", execution.getId(), error.toString());
            return null;
        }
    }

    /**
     * 是否已无自动工作可做。
     *
     * <p>除 SUCCEEDED / SUPERSEDED 外，EXHAUSTED（重试耗尽）与 NEEDS_MANUAL（待人工）同样
     * 不再自动派发：它们不在 {@code listDispatchable} 的集合里，这里一并短路可省去无谓的领取尝试。</p>
     */
    private static boolean isFinished(ExecutionResumeTask task) {
        return task.getState() == ResumeTaskState.SUCCEEDED
                || task.getState() == ResumeTaskState.SUPERSEDED
                || task.getState() == ResumeTaskState.EXHAUSTED
                || task.getState() == ResumeTaskState.NEEDS_MANUAL;
    }

    /** 关闭时停掉巡检与派发线程，避免非托管场景下的线程泄漏。 */
    @PreDestroy
    public void close() {
        sweeper.shutdownNow();
        workers.shutdownNow();
    }
}
