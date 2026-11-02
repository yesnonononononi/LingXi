package com.summit.dp.shared.persistence;

import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.PessimisticLockingFailureException;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.sql.SQLException;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicLong;

/** 锁冲突重放整个事务；调用方已有事务时只执行一次，避免拆散原子提交。 */
@Slf4j
public final class TransactionRetryTemplate {

    /** 默认尝试次数含首次，避免持续竞争无限阻塞业务。 */
    public static final int DEFAULT_MAX_ATTEMPTS = 4;
    /** 每次重试前的线性退避基数（毫秒）。 */
    public static final long DEFAULT_BACKOFF_MILLIS = 20L;

    /** 事务管理器；为 {@code null} 表示没有事务基础设施（例如直接 new 出来的用例），只跑一次。 */
    private final PlatformTransactionManager transactionManager;
    /** 动作名，只用于日志与指标区分。 */
    private final String operation;
    private final int maxAttempts;
    private final long backoffMillis;
    /** 指标：总尝试次数、重试次数、重试耗尽次数。 */
    private final AtomicLong attempts = new AtomicLong();
    private final AtomicLong retries = new AtomicLong();
    private final AtomicLong exhausted = new AtomicLong();

    /**
     * 用默认参数（4 次尝试、20ms 退避基数）。
     *
     * @param transactionManager 事务管理器；可为 {@code null}
     * @param operation          动作名（日志用）
     */
    public TransactionRetryTemplate(PlatformTransactionManager transactionManager, String operation) {
        this(transactionManager, operation, DEFAULT_MAX_ATTEMPTS, DEFAULT_BACKOFF_MILLIS);
    }

    /**
     * @param transactionManager 事务管理器；可为 {@code null}
     * @param operation          动作名（日志用）
     * @param maxAttempts        尝试次数上限（含首次），会被夹到 1..20
     * @param backoffMillis      退避基数（毫秒），第 n 次重试睡 {@code n × backoffMillis}
     */
    public TransactionRetryTemplate(PlatformTransactionManager transactionManager, String operation,
                                    int maxAttempts, long backoffMillis) {
        this.transactionManager = transactionManager;
        this.operation = operation == null || operation.isBlank() ? "事务动作" : operation;
        this.maxAttempts = Math.clamp(maxAttempts, 1, 20);
        this.backoffMillis = Math.max(0L, backoffMillis);
    }

    /** 可重试动作：在调用方没有外层事务时，每次尝试都会在一个全新事务里执行。 */
    @FunctionalInterface
    public interface Action<T> {
        /** 在事务内执行；可以直接返回值。 */
        T run();
    }

    /**
     * 执行动作：没有外层事务时，整笔放进新事务并按锁冲突有限重试；有外层事务时只执行一次。
     *
     * @param action 动作，必须能用同样的输入复现（幂等）；不能带外部副作用
     * @param <T>    返回值类型
     * @return 动作的返回值
     * @throws RuntimeException 动作的真实失败，或重试耗尽后的最后一次锁冲突
     */
    public <T> T execute(Action<T> action) {
        Objects.requireNonNull(action, "action");
        if (transactionManager == null || TransactionSynchronizationManager.isActualTransactionActive()) {
            // 没有事务基础设施，或动作必须留在调用方事务里：只跑一次，锁冲突交给调用方。
            return action.run();
        }
        RuntimeException lastFailure = null;
        for (int attempt = 1; attempt <= maxAttempts; attempt++) {
            attempts.incrementAndGet();
            TransactionTemplate transaction = new TransactionTemplate(transactionManager);
            // 每次尝试都是全新事务/新快照：避免沿用失败事务的锁与读状态。
            transaction.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
            try {
                return transaction.execute(status -> action.run());
            } catch (RuntimeException failure) {
                lastFailure = failure;
                if (attempt == maxAttempts || !isLockConflict(failure)) {
                    if (isLockConflict(failure)) {
                        exhausted.incrementAndGet();
                    }
                    throw failure;
                }
                retries.incrementAndGet();
                log.warn("{}遇到数据库锁冲突，换新事务重试: attempt={}/{}, cause={}",
                        operation, attempt, maxAttempts, rootMessage(failure));
                backoff(attempt);
            }
        }
        throw lastFailure == null ? new IllegalStateException(operation + "失败") : lastFailure;
    }

    /** 指标快照：总尝试、重试、重试耗尽次数。 */
    public Metrics metrics() {
        return new Metrics(attempts.get(), retries.get(), exhausted.get());
    }

    /** 只重试 H2 的锁超时与死锁，不把语句超时或 IO 失败当成写入竞争。 */
    public static boolean isLockConflict(Throwable failure) {
        for (Throwable cause = failure; cause != null; cause = cause.getCause()) {
            if (cause instanceof PessimisticLockingFailureException) {
                return true;
            }
            if (cause instanceof SQLException sqlFailure
                    && (sqlFailure.getErrorCode() == 50200 || sqlFailure.getErrorCode() == 40001
                    || "40001".equals(sqlFailure.getSQLState()))) {
                return true;
            }
            if (cause.getCause() == cause) {
                break;
            }
        }
        return false;
    }

    /** 异常链最里层的消息，日志里比最外层有用。 */
    private static String rootMessage(Throwable failure) {
        Throwable cause = failure;
        while (cause.getCause() != null && cause.getCause() != cause) {
            cause = cause.getCause();
        }
        return cause.getMessage();
    }

    private void backoff(int attempt) {
        if (backoffMillis <= 0L) {
            return;
        }
        try {
            Thread.sleep(backoffMillis * attempt);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    /**
     * 重试指标。
     *
     * @param attempts         总尝试次数（含首次）
     * @param retries          实际发生的重试次数
     * @param exhaustedBatches 重试耗尽后仍然失败的次数
     */
    public record Metrics(long attempts, long retries, long exhaustedBatches) { }
}
