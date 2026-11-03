package com.summit.dp.shared;

import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionContextMapper;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionContextPO;
import com.summit.dp.session.infrastructure.persistence.po.SessionPO;
import com.summit.dp.shared.support.H2TestDatabase;
import org.apache.ibatis.session.SqlSession;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class H2TypeHandlerRoundTripTest {

    private static final int CONTEXT_CHUNK_BYTES = 1024;
    private static final int CONTEXT_CHUNK_COUNT = 10 * 1024;

    private final List<AutoCloseable> resources = new ArrayList<>();

    @AfterEach
    void cleanUp() {
        for (AutoCloseable resource : resources) {
            try {
                resource.close();
            } catch (Exception ignored) {
                // 清理失败不掩盖断言结果
            }
        }
        resources.clear();
    }

    @Test
    @DisplayName("H2：10 MiB 级 session_context.content 经 CLOB 写入读回逐字相等")
    void tenMebibyteContextSurvivesClobRoundTrip() {
        H2TestDatabase database = h2("clob-10m");
        StringBuilder builder = new StringBuilder(CONTEXT_CHUNK_BYTES * CONTEXT_CHUNK_COUNT);
        for (int index = 0; index < CONTEXT_CHUNK_COUNT; index++) {
            builder.append(String.format("%04d|", index)).append("上下文片段").append("a".repeat(980)).append('\n');
        }
        String content = builder.toString();
        assertTrue(content.length() > 9 * 1024 * 1024,
                "构造的正文必须达到 10 MiB 量级，实际字符数=" + content.length());

        SqlSessionFactory factory = database.sessionFactory(SessionContextMapper.class);
        try (SqlSession session = factory.openSession(true)) {
            SessionContextMapper mapper = session.getMapper(SessionContextMapper.class);
            SessionContextPO po = new SessionContextPO();
            po.setSessionId(1L);
            po.setContent(content);
            po.setVersion(1L);
            po.setCreateTime(Instant.now());
            po.setUpdateTime(Instant.now());
            assertEquals(1, mapper.insert(po), "写入大文本必须成功");

            SessionContextPO loaded = mapper.selectById(1L);
            assertNotNull(loaded, "必须能读回该行");
            assertEquals(content.length(), loaded.getContent().length(), "读回长度必须一致");
            assertEquals(content, loaded.getContent(), "读回正文必须逐字相等（截断即丢数据）");
        }
    }

    @Test
    @DisplayName("H2 的时间按 UTC 毫秒往返")
    void timeSemanticsUseUtc() {
        H2TestDatabase h2 = h2("time-h2");
        assertTimeSemantics("H2", h2, h2.sessionFactory(SessionMapper.class, ExecutionMapper.class),
                "SELECT CAST(create_time AS VARCHAR) FROM session WHERE id = ?");

    }

    private void assertTimeSemantics(String label, DataSource dataSource, SqlSessionFactory factory,
                                     String rawTimeSql) {
        Instant instant = Instant.now().truncatedTo(ChronoUnit.MILLIS);
        LocalDateTime localDateTime = LocalDateTime.now().truncatedTo(ChronoUnit.MILLIS);
        long sessionId;
        long executionId;
        try (SqlSession session = factory.openSession(true)) {
            SessionMapper sessionMapper = session.getMapper(SessionMapper.class);
            SessionPO sessionPO = SessionPO.builder()
                    .name(label + "-time")
                    .createTime(instant)
                    .updateTime(instant)
                    .build();
            assertEquals(1, sessionMapper.insert(sessionPO), label + "：写会话行必须成功");
            sessionId = sessionPO.getId();
            SessionPO loaded = sessionMapper.selectById(sessionId);
            assertEquals(instant, loaded.getCreateTime(),
                    label + "：Instant 必须按毫秒精度走 UTC 往返（差 8 小时即说明时区口径错了）");

            ExecutionMapper executionMapper = session.getMapper(ExecutionMapper.class);
            ExecutionPO executionPO = new ExecutionPO();
            executionPO.setSessionId(sessionId);
            executionPO.setStatus(1);
            executionPO.setStartedAt(localDateTime);
            executionPO.setCreatedAt(localDateTime);
            executionPO.setUpdatedAt(localDateTime);
            executionPO.setVersion(1L);
            executionPO.setResumeGeneration(0L);
            assertEquals(1, executionMapper.insert(executionPO), label + "：写执行行必须成功");
            executionId = executionPO.getId();
            ExecutionPO loadedExecution = executionMapper.selectById(executionId);
            assertEquals(localDateTime, loadedExecution.getStartedAt(),
                    label + "：LocalDateTime 必须按 JVM 时区折算后往返");
        }
        assertEquals(instant, parseUtc(rawText(dataSource, rawTimeSql, sessionId)),
                label + "：create_time 的落库文本必须等于 UTC 时间戳");

        // H2 的时间列是 timestamp，不是文本：显式断言类型，防止「看着能跑但其实存的是字符串」。
        if ("H2".equals(label)) {
            try (Connection connection = dataSource.getConnection();
                 PreparedStatement query = connection.prepareStatement(
                         "SELECT DATA_TYPE, DATETIME_PRECISION FROM INFORMATION_SCHEMA.COLUMNS"
                                 + " WHERE TABLE_SCHEMA = 'PUBLIC' AND TABLE_NAME = 'SESSION'"
                                 + " AND COLUMN_NAME = 'CREATE_TIME'");
                 ResultSet rows = query.executeQuery()) {
                assertTrue(rows.next(), "H2 上必须能查到 session.create_time 的元数据");
                assertEquals("TIMESTAMP", rows.getString(1), "H2 时间列必须是 TIMESTAMP");
                assertEquals(3, rows.getInt(2), "H2 时间列精度必须是毫秒");
            } catch (SQLException e) {
                throw new IllegalStateException("查询 H2 列元数据失败: " + e.getMessage(), e);
            }
        }
    }

    @Test
    @DisplayName("H2 显式更新时间保留毫秒精度")
    void updateTimeIsRefreshedByExplicitWrite() {
        Instant created = Instant.parse("2026-01-02T03:04:05.678Z");
        Instant touched = Instant.parse("2026-02-03T04:05:06.789Z");

        H2TestDatabase h2 = h2("touch-h2");
        assertExplicitTouch("H2", h2, h2.sessionFactory(SessionMapper.class),
                "SELECT CAST(update_time AS VARCHAR) FROM session WHERE id = ?", created, touched);

    }

    private void assertExplicitTouch(String label, DataSource source, SqlSessionFactory factory, String rawSql,
                                     Instant created, Instant touched) {
        long sessionId;
        try (SqlSession session = factory.openSession(true)) {
            SessionMapper mapper = session.getMapper(SessionMapper.class);
            SessionPO po = SessionPO.builder().name(label + "-touch").createTime(created).updateTime(created).build();
            assertEquals(1, mapper.insert(po), label + "：写会话行必须成功");
            sessionId = po.getId();
        }
        assertEquals(created, parseUtc(rawText(source, rawSql, sessionId)),
                label + "：创建时的 update_time 必须等于创建时间");

        // 与仓储的更新路径同款：条件更新里显式带上 update_time（H2 侧没有触发器兜底）。
        try (Connection connection = source.getConnection();
             PreparedStatement update = connection.prepareStatement(
                     "UPDATE session SET name = ?, update_time = ? WHERE id = ?")) {
            update.setString(1, label + "-touched");
            update.setString(2, touched.toString());
            update.setLong(3, sessionId);
            assertEquals(1, update.executeUpdate(), label + "：条件更新必须命中 1 行");
        } catch (SQLException e) {
            throw new IllegalStateException(label + "：更新失败: " + e.getMessage(), e);
        }

        assertEquals(touched, parseUtc(rawText(source, rawSql, sessionId)),
                label + "：显式写入后 update_time 必须等于新时间（H2 没有触发器，靠的就是这一写）");
    }

    @Test
    @DisplayName("H2 未显式写时间时由 ON UPDATE 刷新")
    void automaticTouchHappensInH2() {
        Instant created = Instant.parse("2026-01-02T03:04:05.678Z");

        H2TestDatabase h2 = h2("auto-h2");
        assertAutomaticTouch("H2", h2, h2.sessionFactory(SessionMapper.class),
                "SELECT CAST(update_time AS VARCHAR) FROM session WHERE id = ?", created);

    }

    private void assertAutomaticTouch(String label, DataSource source, SqlSessionFactory factory, String rawSql,
                                      Instant created) {
        long sessionId;
        try (SqlSession session = factory.openSession(true)) {
            SessionMapper mapper = session.getMapper(SessionMapper.class);
            SessionPO po = SessionPO.builder().name(label + "-auto").createTime(created).updateTime(created).build();
            assertEquals(1, mapper.insert(po), label + "：写会话行必须成功");
            sessionId = po.getId();
        }
        try (Connection connection = source.getConnection();
             PreparedStatement update = connection.prepareStatement(
                     "UPDATE session SET name = ? WHERE id = ?")) {
            update.setString(1, label + "-auto-touched");
            update.setLong(2, sessionId);
            assertEquals(1, update.executeUpdate(), label + "：更新必须命中 1 行（且不写时间列）");
        } catch (SQLException e) {
            throw new IllegalStateException(label + "：更新失败: " + e.getMessage(), e);
        }

        Instant touched = parseUtc(rawText(source, rawSql, sessionId));
        assertNotNull(touched, label + "：update_time 不得为空");
        assertTrue(touched.isAfter(created),
                label + "：未显式写时间列时 update_time 必须自动前进，created=" + created + "，实际=" + touched);
    }

    private static String rawText(DataSource dataSource, String sql, long id) {
        try (Connection connection = dataSource.getConnection();
             PreparedStatement query = connection.prepareStatement(sql)) {
            query.setLong(1, id);
            try (ResultSet rows = query.executeQuery()) {
                assertTrue(rows.next(), "必须能查到该行的原始时间文本: " + sql);
                return rows.getString(1);
            }
        } catch (SQLException e) {
            throw new IllegalStateException("读取原始时间文本失败: " + e.getMessage(), e);
        }
    }

    private H2TestDatabase h2(String prefix) {
        H2TestDatabase database = H2TestDatabase.create(prefix);
        resources.add(database);
        return database;
    }

    private static Instant parseUtc(String text) {
        return LocalDateTime.parse(text.replace(' ', 'T')).toInstant(ZoneOffset.UTC);
    }
}
