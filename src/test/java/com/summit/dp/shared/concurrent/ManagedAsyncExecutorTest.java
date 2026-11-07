package com.summit.dp.shared.concurrent;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 受管执行器的三条不可退化性质：线程归它、关闭后不静默丢、拒绝不进调用方。
 *
 * <p><b>为什么必须断言线程身份</b>：这条 bean 存在的理由就是「别再跑在公共
 * {@code ForkJoinPool} 上」。若只断言「任务被执行了」，把实现改回
 * {@code CompletableFuture.runAsync(task)} 依然全绿 —— 那等于没测。</p>
 */
class ManagedAsyncExecutorTest {

    private ManagedAsyncExecutor executor;
    private ListAppender<ILoggingEvent> logs;
    private Logger logger;

    @BeforeEach
    void setup() {
        executor = new ManagedAsyncExecutor();
        logger = (Logger) LoggerFactory.getLogger(ManagedAsyncExecutor.class);
        logs = new ListAppender<>();
        logs.start();
        logger.addAppender(logs);
    }

    @AfterEach
    void shutdown() {
        logger.detachAppender(logs);
        logs.stop();
        executor.shutdown();
    }

    @Test
    @DisplayName("任务跑在受管线程上：线程名带固定前缀，且不是公共 ForkJoinPool 的工作线程")
    void taskRunsOnManagedThread() throws Exception {
        AtomicReference<String> worker = new AtomicReference<>();
        AtomicReference<String> caller = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);

        caller.set(Thread.currentThread().getName());
        assertTrue(executor.tryExecute("线程归属探测", () -> {
            worker.set(Thread.currentThread().getName());
            done.countDown();
        }));
        assertTrue(done.await(5, TimeUnit.SECONDS), "任务必须在 5 秒内跑起来");

        assertNotNull(worker.get());
        assertTrue(worker.get().startsWith(ManagedAsyncExecutor.THREAD_NAME_PREFIX),
                "任务必须跑在以 " + ManagedAsyncExecutor.THREAD_NAME_PREFIX + " 命名的线程上，实际: " + worker.get());
        assertFalse(worker.get().startsWith("ForkJoinPool.commonPool"),
                "任务不得跑在公共 ForkJoinPool 上（那正是本 bean 要消灭的形态），实际: " + worker.get());
        assertFalse(worker.get().equals(caller.get()), "任务不得占用调用方线程");
    }

    @Test
    @DisplayName("submit 返回的 future 随任务完成而完成，异常不外抛")
    void submitCompletesFuture() throws Exception {
        CompletableFuture<Void> ok = executor.submit("成功任务", () -> { });
        CompletableFuture<Void> failed = executor.submit("失败任务", () -> {
            throw new IllegalStateException("炸了");
        });

        assertEquals(null, ok.get(5, TimeUnit.SECONDS));
        Exception error = assertThrows(Exception.class, () -> failed.get(5, TimeUnit.SECONDS));
        assertTrue(error.getCause() instanceof IllegalStateException,
                "任务异常必须落到 future 上，而不是消失在后台，实际: " + error);
    }

    @Test
    @DisplayName("关闭后提交：不抛到调用方、返回未被受理、并留下明确的丢弃日志")
    void submissionAfterShutdownIsLoggedAndNotThrown() {
        executor.shutdown();
        assertTrue(executor.isShutdown());

        boolean accepted = executor.tryExecute("关闭后的任务", () -> { });
        assertFalse(accepted, "关闭后必须报告「未被受理」，让调用方有机会补偿");

        CompletableFuture<Void> future = executor.submit("关闭后的 future 任务", () -> { });
        assertTrue(future.isCompletedExceptionally(), "拒绝必须落到 future 上，不能静默挂起");
        // CompletableFuture.get 把异常包在 ExecutionException 里，取 cause 才是拒绝原因本身。
        java.util.concurrent.ExecutionException wrapped = assertThrows(java.util.concurrent.ExecutionException.class,
                () -> future.get(1, TimeUnit.SECONDS));
        RejectedExecutionException rejected = assertThrows(RejectedExecutionException.class,
                () -> { throw wrapped.getCause(); });
        assertTrue(rejected.getMessage().contains("关闭后的 future 任务"), "拒绝原因必须带任务名: " + rejected.getMessage());

        List<ILoggingEvent> warnings = logs.list.stream()
                .filter(event -> event.getLevel() == Level.WARN).toList();
        List<ILoggingEvent> errors = logs.list.stream()
                .filter(event -> event.getLevel() == Level.ERROR).toList();
        assertFalse(errors.isEmpty(), "被明确丢弃的任务必须有一条 ERROR 日志，实际日志: " + messages());
        assertTrue(errors.getLast().getFormattedMessage().contains("任务被明确丢弃"),
                "丢弃日志必须说清后果，实际: " + errors.getLast().getFormattedMessage());
        // 有界重试：每次提交各留 2 条 warn（attempt=1/2）后放弃，次数有上限（不无限自旋）。
        long warnsPerTask = warnings.stream()
                .filter(event -> event.getFormattedMessage().contains("task=关闭后的任务,")).count();
        assertEquals(ManagedAsyncExecutorTest.MAX_EXPECTED_WARNINGS, warnsPerTask,
                "单次提交的重试次数必须有界（warn 条数即重试次数），实际日志: " + messages());
    }

    @Test
    @DisplayName("拒绝后先重试再放弃：短暂不可用不会丢任务")
    void transientRejectionIsRetried() throws Exception {
        FlakyExecutorService flaky = new FlakyExecutorService(1);
        ManagedAsyncExecutor retrying = new ManagedAsyncExecutor(flaky);
        try {
            CountDownLatch done = new CountDownLatch(1);
            assertTrue(retrying.tryExecute("瞬时拒绝", done::countDown));
            assertTrue(done.await(5, TimeUnit.SECONDS), "第一次被拒后重试必须把任务跑起来");
            assertEquals(2, flaky.executions.get(), "应当正好尝试两次（一次被拒 + 一次成功）");
        } finally {
            retrying.shutdown();
        }
    }

    @Test
    @DisplayName("空任务直接拒绝，不产生「受理了但什么都没做」的假象")
    void nullTaskIsRejected() {
        assertThrows(IllegalArgumentException.class, () -> executor.tryExecute("空任务", null));
        CompletableFuture<Void> future = executor.submit("空任务 future", null);
        assertTrue(future.isCompletedExceptionally());
    }

    /** 关闭后每次拒绝都会留一条 warn（前两次），第 3 次直接 error，因此 warn 恒为 2 条。 */
    private static final int MAX_EXPECTED_WARNINGS = 2;

    private List<String> messages() {
        return logs.list.stream().map(ILoggingEvent::getFormattedMessage).toList();
    }

    /** 前 {@code rejections} 次提交抛拒绝、之后正常执行：复现「关闭瞬间的在途提交」。 */
    private static final class FlakyExecutorService implements ExecutorService {

        private final ExecutorService delegate = Executors.newSingleThreadExecutor();
        private final int rejections;
        private final java.util.concurrent.atomic.AtomicInteger executions =
                new java.util.concurrent.atomic.AtomicInteger();

        private FlakyExecutorService(int rejections) {
            this.rejections = rejections;
        }

        @Override
        public void execute(Runnable command) {
            if (executions.incrementAndGet() <= rejections) {
                throw new RejectedExecutionException("模拟关闭瞬间的拒绝");
            }
            delegate.execute(command);
        }

        @Override public void shutdown() { delegate.shutdown(); }
        @Override public List<Runnable> shutdownNow() { return delegate.shutdownNow(); }
        @Override public boolean isShutdown() { return delegate.isShutdown(); }
        @Override public boolean isTerminated() { return delegate.isTerminated(); }
        @Override public boolean awaitTermination(long timeout, TimeUnit unit) throws InterruptedException {
            return delegate.awaitTermination(timeout, unit);
        }
        @Override public <T> java.util.List<java.util.concurrent.Future<T>> invokeAll(
                java.util.Collection<? extends java.util.concurrent.Callable<T>> tasks) throws InterruptedException {
            return delegate.invokeAll(tasks);
        }
        @Override public <T> java.util.List<java.util.concurrent.Future<T>> invokeAll(
                java.util.Collection<? extends java.util.concurrent.Callable<T>> tasks, long timeout, TimeUnit unit)
                throws InterruptedException {
            return delegate.invokeAll(tasks, timeout, unit);
        }
        @Override public <T> T invokeAny(java.util.Collection<? extends java.util.concurrent.Callable<T>> tasks)
                throws java.util.concurrent.ExecutionException, InterruptedException {
            return delegate.invokeAny(tasks);
        }
        @Override public <T> T invokeAny(java.util.Collection<? extends java.util.concurrent.Callable<T>> tasks,
                                         long timeout, TimeUnit unit)
                throws java.util.concurrent.ExecutionException, InterruptedException,
                java.util.concurrent.TimeoutException {
            return delegate.invokeAny(tasks, timeout, unit);
        }
        @Override public <T> java.util.concurrent.Future<T> submit(java.util.concurrent.Callable<T> task) {
            return delegate.submit(task);
        }
        @Override public <T> java.util.concurrent.Future<T> submit(Runnable task, T result) {
            return delegate.submit(task, result);
        }
        @Override public java.util.concurrent.Future<?> submit(Runnable task) {
            return delegate.submit(task);
        }
    }
}
