package com.summit.dp.shared.persistence;

import org.mybatis.spring.MyBatisExceptionTranslator;
import org.springframework.dao.CannotAcquireLockException;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.DeadlockLoserDataAccessException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.dao.QueryTimeoutException;
import org.springframework.dao.support.PersistenceExceptionTranslator;

import javax.sql.DataSource;
import java.sql.SQLException;
import java.util.Locale;
import java.util.Set;

/**
 * H2 的 JDBC 异常翻译。
 *
 * <p><b>为什么必须自己写</b>：业务侧靠「捕获 {@link DuplicateKeyException} 判定重复」实现的
 * 「通知只投一次」「恢复请求只受理一次」「每会话至多一份活动清单」全部依赖异常类型判定。
 * Spring 默认的 SQLState 分类对 H2 的若干高频错误（尤其锁超时 {@code 50200}、
 * 锁冲突 {@code HYT00}）给不出「可重试的锁冲突」这一语义，结果是要么把冲突当成未知错误上抛，
 * 要么把业务错误误判成锁冲突无限重试。</p>
 *
 * <p><b>三类必须分开</b>（混在一起就是事故）：</p>
 * <ul>
 *   <li>唯一键冲突 {@code 23505} → {@link DuplicateKeyException}（业务靠它做幂等）；</li>
 *   <li>锁超时 {@code 50200} → {@link CannotAcquireLockException}、死锁 {@code 40001} →
 *       {@link DeadlockLoserDataAccessException}（这两类可重试，见 {@code TransactionRetryTemplate}）；</li>
 *   <li>普通 SQL 错误与致命存储故障 → 兜底翻译 / {@link DataAccessResourceFailureException}，
 *       <b>不得</b>被当成锁冲突（否则重试会掩盖真实错误）。</li>
 * </ul>
 */
public class H2ExceptionTranslator implements PersistenceExceptionTranslator {

    /** 唯一键/主键冲突。 */
    private static final int DUPLICATE_KEY = 23505;
    /** 检查约束违反。 */
    private static final int CHECK_CONSTRAINT = 23513;
    /** 非空约束违反。 */
    private static final int NULL_NOT_ALLOWED = 23502;
    /** 引用完整性违反（父/子）。 */
    private static final int REFERENTIAL_INTEGRITY_CHILD = 23503;
    private static final int REFERENTIAL_INTEGRITY_PARENT = 23506;
    /** 锁等待超时（实测 errorCode=50200，SQLState=HYT00）。 */
    private static final int LOCK_TIMEOUT = 50200;
    /** 死锁。 */
    private static final int DEADLOCK = 40001;
    /** 唯一键冲突的 SQLState。 */
    private static final String SQL_STATE_DUPLICATE_KEY = "23505";
    /** 死锁的 SQLState（两个引擎约定一致）。 */
    private static final String SQL_STATE_DEADLOCK = "40001";
    /** 通用超时 SQLState；未必是锁冲突，因此只在消息明确指向锁等待时才归为锁冲突。 */
    private static final String SQL_STATE_TIMEOUT = "HYT00";
    /** IO/存储层致命故障的错误码（H2 的 IO_EXCEPTION 等）。 */
    private static final Set<Integer> FATAL_STORAGE_CODES = Set.of(90020, 90028, 90031, 90098);
    /** 完整性约束类 SQLState 前缀（23xxx）。 */
    private static final String SQL_STATE_INTEGRITY_PREFIX = "23";
    /** 连接类 SQLState 前缀（08xxx）。 */
    private static final String SQL_STATE_CONNECTION_PREFIX = "08";

    /** 非约束、非锁类的错误交给它兜底，保证仍然是 DataAccessException 而非裸 PersistenceException。 */
    private final PersistenceExceptionTranslator fallback;

    /**
     * @param dataSource 同一个库的数据源；兜底翻译器要用它读数据库类型来分类错误
     */
    public H2ExceptionTranslator(DataSource dataSource) {
        this.fallback = new MyBatisExceptionTranslator(dataSource, false);
    }

    @Override
    public DataAccessException translateExceptionIfPossible(RuntimeException ex) {
        SQLException sqlException = findSqlException(ex);
        if (sqlException == null) {
            return fallback.translateExceptionIfPossible(ex);
        }
        String message = describe(sqlException);
        String summary = "H2 语句执行失败: " + sqlException.getMessage();
        if (isDeadlock(sqlException)) {
            return new DeadlockLoserDataAccessException(summary, sqlException);
        }
        if (isLockTimeout(sqlException, message)) {
            return new CannotAcquireLockException(summary, sqlException);
        }
        if (isDuplicateKey(sqlException)) {
            return new DuplicateKeyException(summary, sqlException);
        }
        if (isIntegrityViolation(sqlException)) {
            return new DataIntegrityViolationException(summary, sqlException);
        }
        if (isFatalStorageFailure(sqlException)) {
            return new DataAccessResourceFailureException(summary, sqlException);
        }
        if (SQL_STATE_TIMEOUT.equalsIgnoreCase(sqlException.getSQLState())) {
            // 语句级超时但不是锁等待：如实报成查询超时，不冒充锁冲突。
            return new QueryTimeoutException(summary, sqlException);
        }
        return fallback.translateExceptionIfPossible(ex);
    }

    /** 死锁：SQLState 40001 或同名错误码。 */
    private static boolean isDeadlock(SQLException ex) {
        return ex.getErrorCode() == DEADLOCK || SQL_STATE_DEADLOCK.equals(ex.getSQLState());
    }

    /**
     * 锁等待超时。
     *
     * <p>H2 锁超时的 errorCode 是 {@code 50200}、SQLState 是通用的 {@code HYT00}，
     * 因此只在「错误码命中」或「超时且消息明确在等锁」时才判定为锁冲突，
     * 避免把普通语句超时也当成可重试冲突。</p>
     */
    private static boolean isLockTimeout(SQLException ex, String message) {
        if (ex.getErrorCode() == LOCK_TIMEOUT) {
            return true;
        }
        return SQL_STATE_TIMEOUT.equalsIgnoreCase(ex.getSQLState()) && message.contains("lock");
    }

    /** 唯一键/主键冲突。 */
    private static boolean isDuplicateKey(SQLException ex) {
        return ex.getErrorCode() == DUPLICATE_KEY || SQL_STATE_DUPLICATE_KEY.equals(ex.getSQLState());
    }

    /** 其余完整性约束（CHECK / NOT NULL / 外键）。 */
    private static boolean isIntegrityViolation(SQLException ex) {
        int code = ex.getErrorCode();
        if (code == CHECK_CONSTRAINT || code == NULL_NOT_ALLOWED
                || code == REFERENTIAL_INTEGRITY_CHILD || code == REFERENTIAL_INTEGRITY_PARENT) {
            return true;
        }
        if (code == DUPLICATE_KEY || code == LOCK_TIMEOUT || code == DEADLOCK) {
            return false;
        }
        String state = ex.getSQLState();
        return state != null && state.startsWith(SQL_STATE_INTEGRITY_PREFIX);
    }

    /** 致命存储故障（磁盘/IO/连接断开）：必须与「可重试的锁冲突」区分开。 */
    private static boolean isFatalStorageFailure(SQLException ex) {
        if (FATAL_STORAGE_CODES.contains(ex.getErrorCode())) {
            return true;
        }
        String state = ex.getSQLState();
        return state != null && state.startsWith(SQL_STATE_CONNECTION_PREFIX);
    }

    /** 从异常链里找出真正的 SQLException；MyBatis 会把驱动异常包一层再抛。 */
    private static SQLException findSqlException(RuntimeException ex) {
        Throwable current = ex;
        while (current != null) {
            if (current instanceof SQLException sqlException) {
                return sqlException;
            }
            current = current.getCause() == current ? null : current.getCause();
        }
        return null;
    }

    /** 合并异常链上（含 getNextException）的文本，小写化后便于匹配。 */
    private static String describe(SQLException ex) {
        StringBuilder builder = new StringBuilder();
        SQLException current = ex;
        while (current != null) {
            if (current.getMessage() != null) {
                builder.append(current.getMessage()).append(' ');
            }
            current = current.getNextException();
        }
        return builder.toString().toLowerCase(Locale.ROOT);
    }
}
