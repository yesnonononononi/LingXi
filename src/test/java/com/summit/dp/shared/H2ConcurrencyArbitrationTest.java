package com.summit.dp.shared;

import com.summit.dp.checklist.infrastructure.persistence.mapper.ChecklistMapper;
import com.summit.dp.checklist.infrastructure.persistence.po.ChecklistPO;
import com.summit.dp.shared.persistence.H2ExceptionTranslator;
import com.summit.dp.shared.persistence.TransactionRetryTemplate;
import com.summit.dp.shared.support.H2TestDatabase;
import org.apache.ibatis.exceptions.PersistenceException;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.dao.CannotAcquireLockException;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.dao.DeadlockLoserDataAccessException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.dao.QueryTimeoutException;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * H2 真实写写冲突下的裁决：唯一索引 + 条件更新 + 锁冲突分类。
 *
 * <p><b>为什么不用 Mockito 假装异常</b>：唯一索引是否真的拦得住第二条 ACTIVE、
 * 锁等待超时在驱动那一侧到底抛什么错误码，只有真实文件库 + 真实并发连接能回答。
 * 本用例因此全部跑真实 H2 文件库（禁内存库）。</p>
 *
 * <p><b>分类必须三分</b>：唯一键冲突 → {@link DuplicateKeyException}（业务靠它做幂等）；
 * 锁等待超时 → {@link CannotAcquireLockException}（可重试）；普通 SQL 错误与致命存储故障 →
 * 兜底 / {@link DataAccessResourceFailureException}，<b>都不得</b>冒充锁冲突。</p>
 */
class H2ConcurrencyArbitrationTest {

    private final List<H2TestDatabase> databases = new ArrayList<>();

    @AfterEach
    void cleanUp() {
        for (H2TestDatabase database : databases) {
            database.shutdown();
        }
        databases.clear();
    }

    @Test
    @DisplayName("同一会话的第二份 ACTIVE 清单被唯一索引拒绝，并翻成 DuplicateKeyException")
    void secondActiveChecklistIsRejectedAsDuplicateKey() {
        H2TestDatabase database = newDatabase("checklist-active");
        SqlSessionFactory factory = database.sessionFactory(ChecklistMapper.class);
        SqlSessionTemplate template = H2TestDatabase.sqlSession(factory);
        ChecklistMapper mapper = template.getMapper(ChecklistMapper.class);

        assertEquals(1, mapper.insert(activeChecklist(1L, 7L)), "第一份 ACTIVE 必须写入成功");

        DataAccessException failure = assertThrows(DataAccessException.class,
                () -> mapper.insert(activeChecklist(2L, 7L)));
        assertInstanceOf(DuplicateKeyException.class, failure,
                "第二份 ACTIVE 必须落成 DuplicateKeyException（库侧由 uk_checklist_active_session 保证），实际="
                        + failure.getClass().getName());

        // 同一会话的非 ACTIVE 行不受限制：唯一性只针对 ACTIVE。
        ChecklistPO done = activeChecklist(3L, 7L);
        done.setStatus("DONE");
        assertEquals(1, mapper.insert(done), "非 ACTIVE 行必须可插入");
    }

    @Test
    @DisplayName("真实锁等待超时 → CannotAcquireLockException，且被重试模板视为可重试冲突")
    void lockTimeoutBecomesCannotAcquireLockException() throws SQLException {
        H2TestDatabase database = newDatabase("lock-timeout");
        database.execute("INSERT INTO checklist (id, session_id, title, status, remind_status,"
                + " progress_version, create_at, update_at)"
                + " VALUES (10, 7, 'locked', 'ACTIVE', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)");

        SQLException observed;
        try (Connection holder = database.openConnection();
             Connection challenger = database.openConnection()) {
            holder.setAutoCommit(false);
            try (Statement statement = holder.createStatement()) {
                statement.execute("SET LOCK_TIMEOUT 5000");
                statement.executeUpdate("UPDATE checklist SET title = 'held' WHERE id = 10");
            }
            challenger.setAutoCommit(false);
            try (Statement statement = challenger.createStatement()) {
                statement.execute("SET LOCK_TIMEOUT 200");
            }
            try (PreparedStatement update = challenger.prepareStatement(
                    "UPDATE checklist SET title = 'blocked' WHERE id = 10")) {
                update.executeUpdate();
                observed = null;
                fail("第二个连接必须等待锁超时而不是静默成功");
            } catch (SQLException e) {
                observed = e;
            } finally {
                challenger.rollback();
                challenger.setAutoCommit(true);
                holder.rollback();
                holder.setAutoCommit(true);
            }
        }
        assertEquals(50200, observed.getErrorCode(), "H2 锁超时的错误码必须是 50200（实测值）");

        H2ExceptionTranslator translator = new H2ExceptionTranslator(database);
        DataAccessException translated = translator.translateExceptionIfPossible(
                new PersistenceException("更新清单失败", observed));
        assertInstanceOf(CannotAcquireLockException.class, translated,
                "锁等待超时必须翻成 CannotAcquireLockException，实际=" + translated.getClass().getName());
        assertTrue(TransactionRetryTemplate.isLockConflict(translated),
                "重试模板必须把它当作可重试冲突（否则冲突只能一路冒到用户面前）");
    }

    @Test
    @DisplayName("死锁 / 普通 SQL 错误 / 致命存储故障三类分开：都不冒充锁冲突")
    void classificationsAreNotConflated() {
        H2ExceptionTranslator translator = new H2ExceptionTranslator(newDatabase("classification"));

        DataAccessException deadlock = translator.translateExceptionIfPossible(new PersistenceException(
                "死锁", new SQLException("Deadlock detected", "40001", 40001)));
        assertInstanceOf(DeadlockLoserDataAccessException.class, deadlock,
                "SQLState 40001 必须归为死锁，实际=" + deadlock.getClass().getName());

        DataAccessException fatal = translator.translateExceptionIfPossible(new PersistenceException(
                "IO 故障", new SQLException("IO Exception: disk full", "90028", 90028)));
        assertInstanceOf(DataAccessResourceFailureException.class, fatal,
                "致命存储故障必须单独分类，实际=" + fatal.getClass().getName());
        assertFalse(fatal instanceof CannotAcquireLockException,
                "致命故障绝不能被当成可重试的锁冲突");

        DataAccessException statementTimeout = translator.translateExceptionIfPossible(new PersistenceException(
                "语句超时", new SQLException("Statement was canceled or the session timed out", "HYT00", 57014)));
        assertInstanceOf(QueryTimeoutException.class, statementTimeout,
                "非锁等待的超时必须报成查询超时，实际=" + statementTimeout.getClass().getName());

        DataAccessException plain = translator.translateExceptionIfPossible(new PersistenceException(
                "普通 SQL 错误", new SQLException("Table NOPE not found", "42S02", 42102)));
        assertFalse(plain instanceof CannotAcquireLockException,
                "普通 SQL 错误不得被当作锁冲突，实际=" + plain.getClass().getName());
    }

    @Test
    @DisplayName("条件更新（WHERE version=?）返回 0 行即冲突信号，不靠 SELECT ... FOR UPDATE")
    void staleVersionUpdateReportsZeroRows() throws SQLException {
        H2TestDatabase database = newDatabase("conditional-update");
        database.execute("INSERT INTO chat_turn (id, version, session_id, status)"
                + " VALUES (100, 1, 7, 'ACCEPTED')");

        assertEquals(1, updateVersion(database, 100L, 1L, 2L), "带正确版本的条件更新必须命中 1 行");
        assertEquals(0, updateVersion(database, 100L, 1L, 3L),
                "版本已过期时条件更新必须命中 0 行（这就是并发冲突的裁决口径）");
        assertEquals("2", database.queryString("SELECT version FROM chat_turn WHERE id = 100"),
                "第二次更新不得生效");
    }

    private static int updateVersion(H2TestDatabase database, long id, long expected, long next) throws SQLException {
        try (Connection connection = database.openConnection();
             PreparedStatement update = connection.prepareStatement(
                     "UPDATE chat_turn SET version = ? WHERE id = ? AND version = ?")) {
            update.setLong(1, next);
            update.setLong(2, id);
            update.setLong(3, expected);
            return update.executeUpdate();
        }
    }

    /** 构造一份 ACTIVE 清单行（active_session_key 由库侧生成列算出，不写入）。 */
    private static ChecklistPO activeChecklist(long id, long sessionId) {
        ChecklistPO po = new ChecklistPO();
        po.setId(id);
        po.setSessionId(sessionId);
        po.setTitle("活动清单 " + id);
        po.setStatus("ACTIVE");
        po.setRemindStatus(false);
        po.setProgressVersion(0L);
        po.setCreateAt(Instant.now());
        po.setUpdateAt(Instant.now());
        return po;
    }

    private H2TestDatabase newDatabase(String prefix) {
        H2TestDatabase database = H2TestDatabase.create(prefix);
        databases.add(database);
        return database;
    }
}
