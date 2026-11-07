package com.summit.dp.shared.concurrent;

import jakarta.annotation.PreDestroy;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 受管异步执行器：所有「提交后台任务」的入口都收敛到这里，统一线程身份、统一关闭语义。
 *
 * <p><b>为什么不直接用 {@code CompletableFuture.runAsync(task)}</b>：那个重载跑在公共
 * {@code ForkJoinPool} 上 —— 并行度是「CPU 核数 - 1」，且与全进程其它并行流共享。本类承接的任务
 * （审批收尾、命令执行后的恢复）都是**长阻塞 IO**（等数据库事务、等子进程），放进公共池会把
 * 队列占满、把不相关的工作饿死；出问题时线程名也是 {@code commonPool-worker-N}，从日志里认不出是谁。
 * 框架启动时还会把这类「无主任务」算进它自己的并行度预算里，进一步失真。</p>
 *
 * <p><b>为什么选虚拟线程而不是固定大小线程池</b>：任务是阻塞型的，线程池大小就必须猜 —— 猜小了
 * 排队（审批点下去迟迟不恢复），猜大了空耗平台线程。虚拟线程由 JVM 调度、不占用平台线程，
 * 一台机器上真正的并发上限由上游业务自然约束（一个挂起执行同一时刻只有一次审批），不需要再拿池大小
 * 去表达。项目里另外三处（{@code PreparedChatExecutor}、{@code InputWakeupService}、
 * {@code AsyncDelegationSubmitter}）已经是同一取向，本类只是把它们缺的**关闭语义**补上。</p>
 *
 * <p><b>关闭时绝不静默丢任务</b>：{@link #tryExecute} 在被拒绝时先短暂重试（关闭瞬间可能有任务正在
 * 收尾），仍失败就记一条明确丢弃日志并返回 {@code false}，由调用方决定补偿动作
 * （关掉那次 SSE、或把执行收成失败），而不是让一个「看起来提交成功」的任务凭空消失。</p>
 */
@Slf4j
@Component
public class ManagedAsyncExecutor {

    /** 线程名前缀：日志与用例靠它认出「任务确实跑在这个执行器上」。 */
    public static final String THREAD_NAME_PREFIX = "lingxi-async-";

    /** 拒绝后的有界重试次数：3 次 × 20ms = 最多 40ms，短到不影响请求，长到能覆盖关闭瞬间的在途提交。 */
    private static final int MAX_ATTEMPTS = 3;
    private static final long RETRY_PAUSE_MILLIS = 20L;

    private final ExecutorService delegate;
    private final AtomicBoolean closed = new AtomicBoolean(false);

    /** 生产装配：每个任务一个虚拟线程，线程名带固定前缀。 */
    public ManagedAsyncExecutor() {
        this(Executors.newThreadPerTaskExecutor(
                Thread.ofVirtual().name(THREAD_NAME_PREFIX, 0).factory()));
    }

    /**
     * 指定底层执行器：只给用例注入「已被关闭的执行器」来复现拒绝路径。
     *
     * @param delegate 底层执行器；关闭本 bean 时一并关闭
     */
    public ManagedAsyncExecutor(ExecutorService delegate) {
        if (delegate == null) {
            throw new IllegalArgumentException("底层执行器不能为空");
        }
        this.delegate = delegate;
    }

    /**
     * 提交一个后台任务并返回其结果。
     *
     * <p>被拒绝时**不抛异常**：返回的 future 以 {@link RejectedExecutionException} 异常完成，
     * 调用方按需在 {@code whenComplete} 里补偿。需要「拒绝即业务失败」的调用方请用
     * {@link #tryExecute} 的返回值自己判定。</p>
     *
     * @param taskName 任务名（进日志，便于定位是谁的后台任务）
     * @param task     任务体；为 {@code null} 时直接返回失败 future
     * @return 任务完成（或拒绝）后的 future
     */
    public CompletableFuture<Void> submit(String taskName, Runnable task) {
        CompletableFuture<Void> future = new CompletableFuture<>();
        if (task == null) {
            future.completeExceptionally(new IllegalArgumentException("后台任务不能为空: task=" + taskName));
            return future;
        }
        boolean accepted = tryExecute(taskName, () -> {
            try {
                task.run();
                future.complete(null);
            } catch (Throwable failure) {
                future.completeExceptionally(failure);
            }
        });
        if (!accepted) {
            future.completeExceptionally(new RejectedExecutionException(
                    "受管执行器已关闭，任务未被受理: task=" + taskName));
        }
        return future;
    }

    /**
     * 尝试执行一个后台任务：永不抛给调用方。
     *
     * @param taskName 任务名（进日志）
     * @param task     任务体
     * @return 被受理返回 {@code true}；重试耗尽仍被拒绝返回 {@code false}（已记明确丢弃日志）
     */
    public boolean tryExecute(String taskName, Runnable task) {
        if (task == null) {
            throw new IllegalArgumentException("后台任务不能为空: task=" + taskName);
        }
        for (int attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                delegate.execute(task);
                return true;
            } catch (RejectedExecutionException rejected) {
                if (attempt == MAX_ATTEMPTS) {
                    // 明确丢弃：日志是这条任务唯一的痕迹，调用方还会按返回值做补偿。
                    log.error("受管执行器已关闭，任务被明确丢弃: task={}, attempts={}, error={}",
                            taskName, attempt, rejected.toString());
                    return false;
                }
                log.warn("受管执行器拒绝任务，短暂重试: task={}, attempt={}", taskName, attempt);
                awaitRetryWindow();
            }
        }
        return false;
    }

    /** 关闭：标记后关闭底层执行器并等待在途任务收尾。重复调用幂等。 */
    @PreDestroy
    public void shutdown() {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        delegate.shutdown();
        try {
            if (!delegate.awaitTermination(10, java.util.concurrent.TimeUnit.SECONDS)) {
                log.warn("受管执行器未在 10 秒内收尾，强行关闭: pending={}", delegate);
                delegate.shutdownNow();
            }
        } catch (InterruptedException interrupted) {
            delegate.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }

    /** 是否已关闭（用例断言关闭后的提交路径用）。 */
    public boolean isShutdown() {
        return closed.get();
    }

    /** 重试间隔：被中断就当「窗口已关闭」立刻放弃，别把中断标记吞掉。 */
    private static void awaitRetryWindow() {
        try {
            Thread.sleep(RETRY_PAUSE_MILLIS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }
}
