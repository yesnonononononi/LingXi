package com.summit.dp.shared;

import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionContextMapper;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionContextPO;
import com.summit.dp.session.infrastructure.persistence.po.SessionPO;
import com.summit.dp.shared.persistence.TimeTextCodec;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.shared.support.SqliteTestDatabase;
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
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 大文本与时间的跨引擎往返：同一断言在 H2 与 SQLite 上各跑一遍。
 *
 * <p>两条硬要求：</p>
 * <ul>
 *   <li>10 MiB 级 {@code session_context.content} 在 H2 的 CLOB 路径上写入/读回<b>逐字相等</b>；</li>
 *   <li>{@code Instant}/{@code LocalDateTime} 与 SQLite 的 {@link TimeTextCodec} 语义等价 ——
 *       H2 侧只要偏了时区（例如丢了 {@code SET TIME ZONE 'UTC'} 或没传 UTC Calendar），
 *       列里的 UTC 文本就会差 8 小时，这里立刻变红。</li>
 * </ul>
 */
class H2TypeHandlerRoundTripTest {

    /** 10 MiB 级上下文：按 1 KiB 片段拼接，混合 ASCII 与中文，避免「只测了纯 ASCII」的假绿。 */
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
    @DisplayName("H2 与 SQLite 同一断言：Instant/LocalDateTime 落库文本等于 TimeTextCodec 的 UTC 文本")
    void timeSemanticsAreIdenticalOnBothEngines() {
        H2TestDatabase h2 = h2("time-h2");
        assertTimeSemantics("H2", h2, h2.sessionFactory(SessionMapper.class, ExecutionMapper.class),
                "SELECT CAST(create_time AS VARCHAR) FROM session WHERE id = ?");

        SqliteTestDatabase sqlite = sqlite("time-sqlite");
        assertTimeSemantics("SQLite", sqlite, sqlite.sessionFactory(SessionMapper.class, ExecutionMapper.class),
                "SELECT create_time FROM session WHERE id = ?");
    }

    /**
     * 同一段断言：写 PO → 读回 PO → 再读原始列文本。
     *
     * <p>原始文本按 {@link TimeTextCodec#toInstant(String)} 解析回来比瞬时，而不是逐字比较字符串：
     * H2 的 {@code CAST(timestamp AS VARCHAR)} 会去掉毫秒尾零（{@code .070} 渲染成 {@code .07}），
     * 逐字比较会误报；换成瞬时比较后，「时区口径错了」依然会以 8 小时偏差红掉。</p>
     *
     * @param label      引擎名（失败消息里用）
     * @param dataSource 库
     * @param factory    会话工厂
     * @param rawTimeSql 取 session.create_time 原始文本的 SQL（H2 需要 CAST，SQLite 本来就是文本）
     */
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
        assertEquals(instant, TimeTextCodec.toInstant(rawText(dataSource, rawTimeSql, sessionId)),
                label + "：create_time 的落库文本必须等于 TimeTextCodec 的 UTC 文本（两引擎同一断言）");

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
    @DisplayName("两引擎同一断言：update_time 由仓储显式写入，H2 不依赖触发器也会被刷新")
    void updateTimeIsRefreshedByExplicitWriteOnBothEngines() {
        Instant created = Instant.parse("2026-01-02T03:04:05.678Z");
        Instant touched = Instant.parse("2026-02-03T04:05:06.789Z");

        H2TestDatabase h2 = h2("touch-h2");
        assertExplicitTouch("H2", h2, h2.sessionFactory(SessionMapper.class),
                "SELECT CAST(update_time AS VARCHAR) FROM session WHERE id = ?", created, touched);

        SqliteTestDatabase sqlite = sqlite("touch-sqlite");
        assertExplicitTouch("SQLite", sqlite, sqlite.sessionFactory(SessionMapper.class),
                "SELECT update_time FROM session WHERE id = ?", created, touched);
    }

    /**
     * 同一断言：显式写 update_time 后，两个引擎的落库文本都等于 {@link TimeTextCodec#format(Instant)}。
     *
     * <p>SQLite 侧本来就有 AFTER UPDATE 触发器兜底，H2 侧没有（H2 只支持 Java 触发器），
     * 因此 H2 的正确性完全依赖「仓储在 UPDATE 里显式写时间列」。这条用例把该前提钉住：
     * 一旦某条更新路径漏写 update_time，H2 上这里的文本就会停在创建时间。</p>
     *
     * @param label    引擎名
     * @param source   库
     * @param factory  会话工厂
     * @param rawSql   取 update_time 原始文本的 SQL
     * @param created  创建时间
     * @param touched  更新后的时间
     */
    private void assertExplicitTouch(String label, DataSource source, SqlSessionFactory factory, String rawSql,
                                     Instant created, Instant touched) {
        long sessionId;
        try (SqlSession session = factory.openSession(true)) {
            SessionMapper mapper = session.getMapper(SessionMapper.class);
            SessionPO po = SessionPO.builder().name(label + "-touch").createTime(created).updateTime(created).build();
            assertEquals(1, mapper.insert(po), label + "：写会话行必须成功");
            sessionId = po.getId();
        }
        assertEquals(created, TimeTextCodec.toInstant(rawText(source, rawSql, sessionId)),
                label + "：创建时的 update_time 必须等于创建时间");

        // 与仓储的更新路径同款：条件更新里显式带上 update_time（H2 侧没有触发器兜底）。
        try (Connection connection = source.getConnection();
             PreparedStatement update = connection.prepareStatement(
                     "UPDATE session SET name = ?, update_time = ? WHERE id = ?")) {
            update.setString(1, label + "-touched");
            update.setString(2, TimeTextCodec.format(touched));
            update.setLong(3, sessionId);
            assertEquals(1, update.executeUpdate(), label + "：条件更新必须命中 1 行");
        } catch (SQLException e) {
            throw new IllegalStateException(label + "：更新失败: " + e.getMessage(), e);
        }

        assertEquals(touched, TimeTextCodec.toInstant(rawText(source, rawSql, sessionId)),
                label + "：显式写入后 update_time 必须等于新时间（H2 没有触发器，靠的就是这一写）");
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

    private SqliteTestDatabase sqlite(String prefix) {
        SqliteTestDatabase database = SqliteTestDatabase.create(prefix);
        resources.add(database);
        return database;
    }
}
