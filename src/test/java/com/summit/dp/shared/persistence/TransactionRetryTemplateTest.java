package com.summit.dp.shared.persistence;

import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.shared.utils.TestTimeouts;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.dao.CannotAcquireLockException;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.sql.SQLException;
import java.sql.SQLTimeoutException;
import org.springframework.dao.DeadlockLoserDataAccessException;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 共享整笔重试工具的守卫用例：只对锁冲突重试、有上限、每次尝试是新事务。
 *
 * <p>工具是 R2（检查点保存）与 R6（上下文替换）共用的那一层，所以它自己的语义必须被单独钉住：
 * 改宽了会把业务失败也重放（掩盖真实错误、重复副作用），改窄了并发写又会复发
 * {@code SQLITE_BUSY_SNAPSHOT}。</p>
 */
class TransactionRetryTemplateTest {

    /** 锁冲突后换新事务重试：第 3 次成功，断言尝试次数与返回值都是真的重放过。 */
    @Test
    @Timeout(TestTimeouts.HANG_GUARD)
    void retriesLockConflictWithFreshTransactionsUntilSuccess() {
        H2TestDatabase database = H2TestDatabase.create("retry-template-success");
        try {
            PlatformTransactionManager manager = new DataSourceTransactionManager(database);
            TransactionRetryTemplate template = new TransactionRetryTemplate(manager, "守卫用例", 4, 0L);
            AtomicInteger attempts = new AtomicInteger();
            String result = template.execute(() -> {
                int attempt = attempts.incrementAndGet();
                if (attempt < 3) {
                    throw new CannotAcquireLockException("模拟 H2 锁超时");
                }
                return "第" + attempt + "次成功";
            });
            assertEquals("第3次成功", result);
            assertEquals(3, attempts.get(), "锁冲突必须被重试到手，实际尝试次数=" + attempts.get());
            TransactionRetryTemplate.Metrics metrics = template.metrics();
            assertEquals(3L, metrics.attempts());
            assertEquals(2L, metrics.retries());
            assertEquals(0L, metrics.exhaustedBatches());
        } finally {
            database.shutdown();
        }
    }

    /** 业务失败不重试：重放同样的输入只会得到同样的失败，吞掉它就等于掩盖缺陷。 */
    @Test
    @Timeout(TestTimeouts.HANG_GUARD)
    void doesNotRetryNonLockFailure() {
        H2TestDatabase database = H2TestDatabase.create("retry-template-business");
        try {
            PlatformTransactionManager manager = new DataSourceTransactionManager(database);
            TransactionRetryTemplate template = new TransactionRetryTemplate(manager, "守卫用例", 4, 0L);
            AtomicInteger attempts = new AtomicInteger();
            assertThrows(IllegalArgumentException.class, () -> template.execute(() -> {
                attempts.incrementAndGet();
                throw new IllegalArgumentException("业务校验失败");
            }));
            assertEquals(1, attempts.get(), "业务失败只允许尝试一次，实际=" + attempts.get());
            assertEquals(0L, template.metrics().retries());
        } finally {
            database.shutdown();
        }
    }

    /** 次数有上限：一直冲突时尝试次数必须封顶，并把最后一次异常如实抛出（不吞）。 */
    @Test
    @Timeout(TestTimeouts.HANG_GUARD)
    void givesUpAfterMaxAttemptsAndPropagatesTheFailure() {
        H2TestDatabase database = H2TestDatabase.create("retry-template-exhaust");
        try {
            PlatformTransactionManager manager = new DataSourceTransactionManager(database);
            TransactionRetryTemplate template = new TransactionRetryTemplate(manager, "守卫用例", 3, 0L);
            AtomicInteger attempts = new AtomicInteger();
            CannotAcquireLockException failure = assertThrows(CannotAcquireLockException.class,
                    () -> template.execute(() -> {
                        attempts.incrementAndGet();
                        throw new CannotAcquireLockException("一直冲突");
                    }));
            assertEquals("一直冲突", failure.getMessage(), "必须如实抛出真实失败原因");
            assertEquals(3, attempts.get(), "尝试次数必须封顶在 3，实际=" + attempts.get());
            assertEquals(1L, template.metrics().exhaustedBatches());
        } finally {
            database.shutdown();
        }
    }

    /** 调用方已有事务时只跑一次：绝不能把动作偷进新事务，那会破坏调用方的原子性。 */
    @Test
    @Timeout(TestTimeouts.HANG_GUARD)
    void joinsCallerTransactionWithoutRetrying() {
        H2TestDatabase database = H2TestDatabase.create("retry-template-caller-tx");
        try {
            PlatformTransactionManager manager = new DataSourceTransactionManager(database);
            TransactionRetryTemplate template = new TransactionRetryTemplate(manager, "守卫用例", 4, 0L);
            AtomicInteger attempts = new AtomicInteger();
            new TransactionTemplate(manager).executeWithoutResult(status -> assertThrows(
                    CannotAcquireLockException.class, () -> template.execute(() -> {
                        attempts.incrementAndGet();
                        throw new CannotAcquireLockException("外层事务里不重试");
                    })));
            assertEquals(1, attempts.get(), "外层事务里只允许尝试一次，实际=" + attempts.get());
        } finally {
            database.shutdown();
        }
    }

    /** 没有事务管理器（例如直接 new 的用例）时降级为一次尝试，不能假装重试成功。 */
    @Test
    @Timeout(TestTimeouts.HANG_GUARD)
    void withoutTransactionManagerRunsOnce() {
        TransactionRetryTemplate template = new TransactionRetryTemplate(null, "守卫用例");
        AtomicInteger attempts = new AtomicInteger();
        assertEquals("ok", template.execute(() -> {
            attempts.incrementAndGet();
            return "ok";
        }));
        assertEquals(1, attempts.get());
    }

    @Test
    void onlyH2LockTimeoutAndDeadlockAreRetried() {
        assertTrue(TransactionRetryTemplate.isLockConflict(new CannotAcquireLockException("锁冲突")));
        assertTrue(TransactionRetryTemplate.isLockConflict(new RuntimeException("包装",
                new SQLException("锁超时", "HYT00", 50200))));
        assertTrue(TransactionRetryTemplate.isLockConflict(new SQLException("死锁", "40001", 40001)));
        assertTrue(TransactionRetryTemplate.isLockConflict(
                new DeadlockLoserDataAccessException("死锁", null)));
        assertFalse(TransactionRetryTemplate.isLockConflict(new SQLException("旧错误码", null, 517)));
        assertFalse(TransactionRetryTemplate.isLockConflict(new SQLException("database is locked")));
        assertFalse(TransactionRetryTemplate.isLockConflict(new SQLTimeoutException("查询超时", "HYT00", 57014)));
        assertFalse(TransactionRetryTemplate.isLockConflict(new IllegalArgumentException("业务失败")));
        assertFalse(TransactionRetryTemplate.isLockConflict(new SQLException("语法错误", "42S02", 42102)));
        assertFalse(TransactionRetryTemplate.isLockConflict(new SQLException("IO 失败", "90028", 90028)));
    }
}
