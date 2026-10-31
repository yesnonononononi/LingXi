package com.summit.dp.shared.persistence;

import org.mybatis.spring.MyBatisExceptionTranslator;
import org.springframework.dao.CannotAcquireLockException;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.dao.support.PersistenceExceptionTranslator;

import javax.sql.DataSource;
import java.sql.SQLException;
import java.util.Locale;

/**
 * SQLite 的 JDBC 异常翻译。
 *
 * <p><b>为什么必须自己写</b>：sqlite-jdbc 在约束冲突时给出 {@code SQLState=null}、
 * {@code errorCode=19}，Spring 默认的「按 SQLState 分类」与「按错误码表分类」都认不出来，
 * 于是唯一键冲突被归成 {@code UncategorizedSQLException}。</p>
 *
 * <p>这条差异会改变业务语义：「通知只投一次」和「恢复请求只受理一次」都靠捕获
 * {@link DuplicateKeyException} 判定重复，翻不出来就等于把幂等逻辑整条废掉。</p>
 */
public class SqliteExceptionTranslator implements PersistenceExceptionTranslator {

    /** SQLite 的 SQLITE_CONSTRAINT 错误码；约束类失败都用它。 */
    private static final int SQLITE_CONSTRAINT = 19;

    /** SQLITE_BUSY：另一连接正持有写锁；SQLITE_LOCKED：同一连接内的表锁冲突。 */
    private static final int SQLITE_BUSY = 5;
    private static final int SQLITE_LOCKED = 6;

    /** 非约束类的 SQL 错误交给它兜底，保证仍然是 DataAccessException 而非裸 PersistenceException。 */
    private final PersistenceExceptionTranslator fallback;

    /**
     * @param dataSource 同一个库的数据源；兜底翻译器要用它读数据库类型来分类错误
     */
    public SqliteExceptionTranslator(DataSource dataSource) {
        this.fallback = new MyBatisExceptionTranslator(dataSource, false);
    }

    @Override
    public DataAccessException translateExceptionIfPossible(RuntimeException ex) {
        SQLException sqlException = findSqlException(ex);
        if (sqlException == null) {
            return fallback.translateExceptionIfPossible(ex);
        }
        String message = describe(sqlException);
        String summary = "SQLite 语句执行失败: " + sqlException.getMessage();
        if (isLockConflict(sqlException, message)) {
            // 单写者下「读后升写」抢锁会立刻失败（busy_timeout 对升写不生效）：
            // 归成 Spring 的锁冲突异常，调用方才可能把它当可重试冲突处理，
            // 而不是变成一个语义不明的 UncategorizedSQLException。
            return new CannotAcquireLockException(summary, sqlException);
        }
        if (message.contains("unique constraint failed")) {
            return new DuplicateKeyException(summary, sqlException);
        }
        if (sqlException.getErrorCode() == SQLITE_CONSTRAINT || message.contains("constraint failed")) {
            return new DataIntegrityViolationException(summary, sqlException);
        }
        return fallback.translateExceptionIfPossible(ex);
    }

    /**
     * 是否为锁冲突（SQLITE_BUSY / SQLITE_LOCKED）。
     *
     * <p>两种来源都归到这里：错误码 5/6，或消息里带 {@code database is locked} /
     * {@code database table is locked}（xerial 偶尔只给文本不给码）。</p>
     */
    private static boolean isLockConflict(SQLException ex, String message) {
        int code = ex.getErrorCode();
        return code == SQLITE_BUSY || code == SQLITE_LOCKED
                || message.contains("database is locked")
                || message.contains("database table is locked");
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

    /** 合并异常链上（含 getNextException）的文本：驱动有时只把细节放在 cause 的 message 里。 */
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

