package com.summit.dp.shared;

import cn.hutool.core.util.IdUtil;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMessageMapper;
import com.summit.dp.email.infrastructure.persistence.po.EmailMessagePO;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionResumeTaskMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionResumeTaskPO;
import com.summit.dp.shared.config.SqliteSchemaInitializer;
import com.summit.dp.shared.support.SqliteTestDatabase;
import com.summit.dp.turn.infrastructure.persistence.mapper.ChatTurnMapper;
import com.summit.dp.turn.infrastructure.persistence.po.ChatTurnPO;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 真实 SQLite 原型门槛：新库 + 文件库上把「换库后必须有」的行为逐条钉死。
 *
 * <p>这里刻意不用 {@code :memory:}：WAL、跨连接写锁、重启可打开这些正是上线风险所在，
 * 内存库会把它们全部掩盖。每条断言都能因为一处真实回退（方言、时间格式、唯一约束、
 * 类型处理器）而变红。</p>
 */
class SqlitePrototypeTest {

    private SqliteTestDatabase database;
    private SqlSessionTemplate sql;

    @BeforeEach
    void setUp() {
        database = SqliteTestDatabase.create("prototype");
        sql = SqliteTestDatabase.sqlSession(database.sessionFactory(ExecutionMapper.class,
                ExecutionResumeTaskMapper.class, ChatTurnMapper.class, EmailMessageMapper.class));
    }

    @AfterEach
    void tearDown() {
        database.shutdown();
    }

    @Test
    @DisplayName("Windows 上 JNI 能加载，驱动与内核版本对得上，库文件真实落在磁盘上")
    void nativeDriverLoadsAndReportsRealSqliteVersion() throws Exception {
        try (Connection connection = database.getConnection()) {
            assertEquals("SQLite", connection.getMetaData().getDatabaseProductName());
            try (Statement statement = connection.createStatement();
                 ResultSet rows = statement.executeQuery("select sqlite_version()")) {
                assertTrue(rows.next());
                String kernel = rows.getString(1);
                assertTrue(kernel.startsWith("3."), "SQLite 内核版本异常: " + kernel);
            }
        }
        // 文件库：主文件在磁盘上，且库确实是 WAL 模式（只查 pragma，不依赖 -wal 文件是否尚在——
        // 最后一次连接关闭时 SQLite 会 checkpoint 并删掉空的 -wal）
        assertTrue(java.nio.file.Files.exists(database.databaseFile()), "库文件必须真实存在");
        try (Connection connection = database.getConnection();
             Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery("PRAGMA journal_mode")) {
            assertTrue(rows.next());
            assertEquals("wal", rows.getString(1).toLowerCase(java.util.Locale.ROOT),
                    "WAL 模式必须生效（否则并发读会被写阻塞）");
        } catch (Exception e) {
            throw new IllegalStateException("读取 journal_mode 失败", e);
        }
    }

    @Test
    @DisplayName("版本化初始化重复执行幂等：第二次 0 个脚本，版本表只有一行")
    void schemaInitializationIsIdempotent() {
        assertEquals(0, new SqliteSchemaInitializer().initialize(database), "重复初始化不应该再执行脚本");
        assertEquals("1", database.queryString("SELECT COUNT(*) FROM schema_version"),
                "版本表必须恰好登记一个版本");
        assertEquals("1", database.queryString(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'checklist'"));
        assertEquals("1", database.queryString(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'session_message'"));
    }

    @Test
    @DisplayName("MyBatis-Plus 分页在 SQLite 方言下真的追加 LIMIT/OFFSET 并回填 total")
    void paginationUsesSqliteDialect() {
        EmailMessageMapper messages = sql.getMapper(EmailMessageMapper.class);
        for (int index = 0; index < 5; index++) {
            messages.insert(EmailMessagePO.builder().id(IdUtil.getSnowflakeNextId()).emailId(1L)
                    .senderId(2L).content("消息" + index).status("PENDING")
                    .createAt(Instant.parse("2026-10-01T0" + index + ":00:00Z"))
                    .updateAt(Instant.parse("2026-10-01T0" + index + ":00:00Z")).build());
        }
        Page<EmailMessagePO> page = messages.selectPage(new Page<>(2, 2),
                Wrappers.<EmailMessagePO>lambdaQuery()
                        .eq(EmailMessagePO::getEmailId, 1L)
                        .orderByAsc(EmailMessagePO::getCreateAt));
        assertEquals(5L, page.getTotal(), "total 必须由 COUNT 查询回填");
        assertEquals(2, page.getRecords().size(), "第二页只能取两条（方言错时会全量返回）");
        assertEquals("消息2", page.getRecords().get(0).getContent(), "OFFSET 必须生效");
        assertEquals("消息3", page.getRecords().get(1).getContent());
    }

    @Test
    @DisplayName("雪花 ID 以 Long 落库，按字符串回读仍然命中同一行（前后端字符串契约不变）")
    void snowflakeIdRoundTripsThroughStringLookup() {
        long snowflake = IdUtil.getSnowflakeNextId();
        ExecutionMapper executions = sql.getMapper(ExecutionMapper.class);
        ExecutionPO row = new ExecutionPO();
        row.setId(snowflake);
        row.setVersion(1L);
        row.setSessionId(77L);
        row.setStatus(1);
        row.setSnapshot("checkpoint");
        assertEquals(1, executions.insert(row));

        ExecutionPO loaded = executions.selectById(Long.valueOf(String.valueOf(snowflake)));
        assertNotNull(loaded, "按字符串解析回来的 id 必须能查到同一行");
        assertEquals(snowflake, loaded.getId());
        assertEquals(String.valueOf(snowflake), String.valueOf(loaded.getId()),
                "对外仍是十进制字符串，前端契约不变");
        // AUTOINCREMENT 表：显式插入雪花 id 后，自增分配的 id 不得撞上已占用的号段
        ExecutionPO auto = new ExecutionPO();
        auto.setVersion(1L);
        auto.setSessionId(78L);
        auto.setStatus(1);
        assertEquals(1, executions.insert(auto));
        assertNotNull(auto.getId());
        assertFalse(auto.getId().equals(snowflake));
    }

    @Test
    @DisplayName("LocalDateTime 毫秒精度往返：写进毫秒、读回毫秒，且默认值也按 UTC 文本落库")
    void localDateTimeKeepsMillisecondPrecision() {
        ExecutionMapper executions = sql.getMapper(ExecutionMapper.class);
        ExecutionPO row = new ExecutionPO();
        row.setId(IdUtil.getSnowflakeNextId());
        row.setVersion(1L);
        row.setSessionId(90L);
        row.setStatus(1);
        LocalDateTime written = LocalDateTime.of(2026, 10, 1, 8, 30, 45, 123_456_789);
        row.setStartedAt(written);
        row.setCreatedAt(written);
        assertEquals(1, executions.insert(row));

        ExecutionPO loaded = executions.selectById(row.getId());
        LocalDateTime expected = written.truncatedTo(ChronoUnit.MILLIS);
        assertEquals(expected, loaded.getStartedAt(), "毫秒必须原样读回");
        assertEquals(expected, loaded.getCreatedAt());
        // 本地时间按 JVM 时区折算成同一时刻（不是简单丢弃时区信息）
        assertEquals(expected.atZone(ZoneId.systemDefault()).toInstant(),
                loaded.getStartedAt().atZone(ZoneId.systemDefault()).toInstant());
        // 时间列在库里是定宽 UTC 文本，字典序即时间序
        String stored = database.queryString(
                "SELECT started_at FROM execution WHERE id = " + row.getId());
        assertTrue(stored.matches("\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}\\.\\d{3}"),
                "时间列必须是定宽毫秒文本，实际=" + stored);
    }

    @Test
    @DisplayName("乐观版本条件更新：两个线程同时改同一行，只有一方成功")
    @Timeout(30)
    void optimisticVersionUpdateOnlyLetsOneWriterWin() throws Exception {
        ExecutionResumeTaskMapper tasks = sql.getMapper(ExecutionResumeTaskMapper.class);
        long id = IdUtil.getSnowflakeNextId();
        ExecutionResumeTaskPO row = new ExecutionResumeTaskPO();
        row.setId(id);
        row.setExecutionId(11L);
        row.setGeneration(1L);
        row.setState("READY");
        row.setVersion(1L);
        row.setCreatedAt(LocalDateTime.now());
        row.setUpdatedAt(LocalDateTime.now());
        assertEquals(1, tasks.insert(row));

        CountDownLatch start = new CountDownLatch(1);
        try (ExecutorService workers = Executors.newFixedThreadPool(2)) {
            Future<Integer> first = workers.submit(() -> claimAfterSignal(tasks, id, start));
            Future<Integer> second = workers.submit(() -> claimAfterSignal(tasks, id, start));
            start.countDown();
            List<Integer> results = List.of(first.get(20, TimeUnit.SECONDS), second.get(20, TimeUnit.SECONDS));
            assertEquals(1, results.stream().filter(changed -> changed == 1).count(),
                    "并发领取只能有一方生效，实际=" + results);
        }
        ExecutionResumeTaskPO loaded = tasks.selectById(id);
        assertEquals(2L, loaded.getVersion(), "版本只允许前进一次");
        assertEquals("CLAIMED", loaded.getState());
    }

    private int claimAfterSignal(ExecutionResumeTaskMapper tasks, long id, CountDownLatch start)
            throws InterruptedException {
        assertTrue(start.await(20, TimeUnit.SECONDS), "并发用例启动超时");
        return tasks.update(Wrappers.<ExecutionResumeTaskPO>lambdaUpdate()
                .set(ExecutionResumeTaskPO::getState, "CLAIMED")
                .set(ExecutionResumeTaskPO::getVersion, 2L)
                .eq(ExecutionResumeTaskPO::getId, id)
                .eq(ExecutionResumeTaskPO::getVersion, 1L));
    }

    @Test
    @DisplayName("重复消息追加：唯一键由库侧裁决，第二次插入必须失败")
    void duplicateMessageAppendIsRejectedByUniqueIndex() {
        EmailMessageMapper messages = sql.getMapper(EmailMessageMapper.class);
        Instant now = Instant.parse("2026-10-01T00:00:00Z");
        EmailMessagePO first = EmailMessagePO.builder().id(IdUtil.getSnowflakeNextId()).emailId(5L)
                .senderId(6L).dedupKey("dedup-1").content("第一次通知").status("PENDING")
                .createAt(now).updateAt(now).build();
        assertEquals(1, messages.insert(first));

        EmailMessagePO duplicated = EmailMessagePO.builder().id(IdUtil.getSnowflakeNextId()).emailId(5L)
                .senderId(6L).dedupKey("dedup-1").content("重复通知").status("PENDING")
                .createAt(now).updateAt(now).build();
        assertThrows(DuplicateKeyException.class, () -> messages.insert(duplicated),
                "唯一键冲突必须抛 DuplicateKeyException（业务靠它判定「已投过」）");
        assertEquals("1", database.queryString(
                "SELECT COUNT(*) FROM email_message WHERE dedup_key = 'dedup-1'"));
    }

    @Test
    @DisplayName("嵌套事务：同连接 savepoint 可用（内层回滚只回滚内层），REQUIRES_NEW 在外层写库期间写会失败")
    @Timeout(60)
    void nestedTransactionsBehaveAsSqliteAllows() {
        DataSourceTransactionManager transactionManager = new DataSourceTransactionManager(database);
        TransactionTemplate required = new TransactionTemplate(transactionManager);
        TransactionTemplate nested = new TransactionTemplate(transactionManager);
        nested.setPropagationBehavior(TransactionDefinition.PROPAGATION_NESTED);
        ChatTurnMapper turns = sql.getMapper(ChatTurnMapper.class);

        required.executeWithoutResult(status -> {
            turns.insert(turn(1L, "外层"));
            // 同一连接上的 savepoint 嵌套：内层回滚只丢内层写入，外层保留。
            nested.executeWithoutResult(inner -> {
                turns.insert(turn(2L, "内层-回滚"));
                inner.setRollbackOnly();
            });
            turns.insert(turn(3L, "外层-第二个"));
        });
        assertEquals("2", database.queryString("SELECT COUNT(*) FROM chat_turn"),
                "内层回滚应只撤销自己那一行");
        assertEquals("0", database.queryString("SELECT COUNT(*) FROM chat_turn WHERE id = 2"));

        // REQUIRES_NEW 会在外层仍持有写锁时另开连接写同一文件：SQLite 只允许一个写者，
        // 因此这里必须以 SQLITE_BUSY 失败（业务不得这样嵌套，见方案单元 2）。
        DriverManagerDataSource second = new DriverManagerDataSource();
        second.setDriverClassName("org.sqlite.JDBC");
        second.setUrl("jdbc:sqlite:" + database.databaseFile().toAbsolutePath().toString().replace('\\', '/')
                + "?journal_mode=WAL&synchronous=FULL&busy_timeout=150");
        SqlSessionTemplate secondSession = SqliteTestDatabase.sqlSession(secondSqlSession(second));
        TransactionTemplate requiresNew = new TransactionTemplate(new DataSourceTransactionManager(second));
        requiresNew.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        required.executeWithoutResult(status -> {
            turns.insert(turn(4L, "外层持锁"));
            assertThrows(DataAccessException.class,
                    () -> requiresNew.executeWithoutResult(inner -> secondSession.getMapper(ChatTurnMapper.class)
                            .insert(turn(5L, "REQUIRES_NEW 写"))),
                    "外层已写库时，新连接再写必须以锁失败告终，而不是排队等死");
        });
        assertEquals("0", database.queryString("SELECT COUNT(*) FROM chat_turn WHERE id = 5"));
    }

    private static org.apache.ibatis.session.SqlSessionFactory secondSqlSession(DriverManagerDataSource second) {
        com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean factory =
                new com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean();
        factory.setDataSource(second);
        com.baomidou.mybatisplus.core.MybatisConfiguration configuration =
                new com.baomidou.mybatisplus.core.MybatisConfiguration();
        configuration.setMapUnderscoreToCamelCase(true);
        com.summit.dp.shared.persistence.MyBatisTypeHandlers.registerAll(configuration);
        configuration.addMapper(ChatTurnMapper.class);
        factory.setConfiguration(configuration);
        try {
            return factory.getObject();
        } catch (Exception e) {
            throw new IllegalStateException("第二连接 SqlSessionFactory 创建失败", e);
        }
    }

    private static ChatTurnPO turn(long id, String errorReason) {
        return ChatTurnPO.builder().id(id).sessionId(500L).status("ACCEPTED")
                .errorReason(errorReason)
                .createdAt(Instant.parse("2026-10-01T00:00:00Z"))
                .updatedAt(Instant.parse("2026-10-01T00:00:00Z")).build();
    }
}
