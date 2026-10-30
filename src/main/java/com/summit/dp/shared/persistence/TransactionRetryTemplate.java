package com.summit.dp.shared.persistence;

import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.CannotAcquireLockException;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.sql.SQLException;
import java.sql.SQLTransientException;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 整笔事务重试：把「可能撞上数据库锁冲突的一整段读写」放进可重试边界，每次重试开**全新事务**。
 *
 * <p><b>为什么必须整笔重试</b>：SQLite 的事务在第一次读时就固定了数据库快照。
 * 同期别的连接提交之后，本事务再写会立刻收到 {@code SQLITE_BUSY_SNAPSHOT} ——
 * 在同一个已过期的读事务里重试 UPDATE 永远不会成功，只能丢弃整个事务、
 * 用新事务重新读一遍再写。{@code busy_timeout} 对「读锁升写锁」不生效，靠等也不行。</p>
 *
 * <p><b>为什么不能重试外层事务</b>：调用方已有事务时（例如受理要把轮次、消息、执行行一起提交），
 * 把动作拿进新事务就等于把它从调用方事务里偷走，原子性先碎。所以
 * {@link #execute(Action)} 对「已有外层事务」只跑一次、锁冲突如实上抛，由调用方决定语义。</p>
 *
 * <p><b>什么时候不该用它</b>：动作不是幂等复现（有外部副作用、发消息、写文件）时，
 * 重放会重复副作用 —— 那种场景要先自己把副作用移出可重试边界。</p>
 */
@Slf4j
public final class TransactionRetryTemplate {

    /** 默认尝试次数（含首次）。SQLite 的写冲突窗口很短，几次足够。 */
    public static final int DEFAULT_MAX_ATTEMPTS = 4;
    /** 每次重试前的线性退避基数（毫秒）。 */
    public static final long DEFAULT_BACKOFF_MILLIS = 20L;

    // SQLite 的锁冲突错误码：5=SQLITE_BUSY，6=SQLITE_LOCKED，517=SQLITE_BUSY_SNAPSHOT，
    // 262=SQLITE_LOCKED_SHAREDCACHE。
    private static final int SQLITE_BUSY = 5;
    private static final int SQLITE_LOCKED = 6;
    private static final int SQLITE_BUSY_SNAPSHOT = 517;
    private static final int SQLITE_LOCKED_SHAREDCACHE = 262;

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
            // 每次尝试都是全新事务/新快照：这是 BUSY_SNAPSHOT 类冲突能重试成功的唯一前提。
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

    /**
     * 是否为可重试的数据库锁冲突。
     *
     * <p>SQLite 单写者下，并发写同一库必然有 {@code SQLITE_BUSY}（库被写）/
     * {@code SQLITE_BUSY_SNAPSHOT}（读快照已过期）；这类冲突换新事务重放就能成功。
     * 其它异常（约束、SQL 错误、业务校验）一律不重试 —— 重放同样的输入只会得到同样的失败。</p>
     */
    public static boolean isLockConflict(Throwable failure) {
        for (Throwable cause = failure; cause != null; cause = cause.getCause()) {
            if (cause instanceof CannotAcquireLockException || cause instanceof SQLTransientException) {
                return true;
            }
            if (cause instanceof SQLException sqlFailure) {
                int code = sqlFailure.getErrorCode();
                if (code == SQLITE_BUSY || code == SQLITE_LOCKED
                        || code == SQLITE_BUSY_SNAPSHOT || code == SQLITE_LOCKED_SHAREDCACHE) {
                    return true;
                }
            }
            String message = cause.getMessage();
            if (message != null && (message.contains("SQLITE_BUSY") || message.contains("SQLITE_LOCKED")
                    || message.contains("database is locked") || message.contains("database table is locked"))) {
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
