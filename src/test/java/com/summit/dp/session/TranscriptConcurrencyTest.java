package com.summit.dp.session;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.dp.session.application.convert.TranscriptRecordAssembler;
import com.summit.dp.session.application.service.ConversationTranscriptService;
import com.summit.dp.session.application.service.TranscriptReplayMatcher;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMapper;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMessageMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionMessagePO;
import com.summit.dp.session.infrastructure.persistence.po.SessionPO;
import com.summit.dp.session.infrastructure.persistence.repository.SessionMessageRepositoryImpl;
import com.summit.dp.shared.config.JsonConfig;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;

/**
 * C-1 的真并发回归：两个线程用**各自的事务**同时提交同一 responseId。
 *
 * <p><b>为什么要真库真事务</b>：旧实现是「先查再插」的 check-then-act。用 mock 测不出来 ——
 * mock 没有并发、没有事务，{@code findByResponseId} 返回什么完全由测试摆布，两条路径永远「看起来」都对。
 * 只有真 H2 + 两个真连接，才能让两个线程真的同时进入临界区，暴露竞态。</p>
 *
 * <p><b>断言必须在事务之外</b>：H2（MODE=MySQL）下事务内唯一键冲突会把事务标成 rollback-only，
 * 在事务内断言会读到未提交/已回滚的中间态而**假绿**。这里落库完成后另开连接统计行数。</p>
 *
 * <p>锁会话行后，后到线程会阻塞在 {@code SELECT ... FOR UPDATE}，等先到线程提交后才继续；
 * 此时它读到先到线程刚落库的 AI 行 —— 内容一致则幂等返回，因此最终**恰好一行**，
 * 且没有任何 {@code DuplicateKeyException} 泄漏到调用方。</p>
 */
class TranscriptConcurrencyTest {

    private static final long SESSION_ID = 4242L;
    private static final long TURN_ID = 900900L;
    private static final String RESPONSE_ID = "9007199254740993";

    private EmbeddedDatabase database;
    private DataSource dataSource;
    private ConversationTranscriptService service;

    @BeforeEach
    void setup() throws Exception {
        database = new EmbeddedDatabaseBuilder().generateUniqueName(true).setType(EmbeddedDatabaseType.H2)
                .addScript("session-response-id-concurrency-schema.sql")
                .build();
        dataSource = database;
        try (Connection connection = dataSource.getConnection(); Statement statement = connection.createStatement()) {
            statement.execute("INSERT INTO session (id, root_session_id, name) VALUES (" + SESSION_ID + ", 0, '并发会话')");
        }

        MybatisConfiguration configuration = new MybatisConfiguration();
        configuration.addMapper(SessionMapper.class);
        configuration.addMapper(SessionMessageMapper.class);
        MapperBuilderAssistant assistant = new MapperBuilderAssistant(configuration, "test");
        TableInfoHelper.initTableInfo(assistant, SessionPO.class);
        TableInfoHelper.initTableInfo(assistant, SessionMessagePO.class);

        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(dataSource);
        factory.setConfiguration(configuration);
        SqlSessionFactory sessionFactory = factory.getObject();
        SqlSessionTemplate template = new SqlSessionTemplate(sessionFactory);

        TranscriptRecordAssembler assembler = new TranscriptRecordAssembler(new JsonConfig().objectMapper());
        TranscriptReplayMatcher matcher = new TranscriptReplayMatcher(new JsonConfig().objectMapper());
        service = new ConversationTranscriptService(
                new SessionMessageRepositoryImpl(template.getMapper(SessionMessageMapper.class),
                        template.getMapper(SessionMapper.class)),
                mock(ToolCallRepository.class), assembler, matcher);
    }

    @AfterEach
    void tearDown() {
        if (database != null) database.shutdown();
    }

    /**
     * 并发同身份同内容 → 恰好落一行，无异常外泄。
     *
     * <p>回归「先查再插」：把锁删掉后，两线程会双双通过检查再一起插入，一个撞唯一索引抛错，
     * 于是本用例在「无异常」断言上变红。</p>
     */
    @Test
    @DisplayName("并发提交同一 responseId（同内容）→ 只落一行，且无异常外泄")
    void concurrentSameContentLandsExactlyOneRow() throws Exception {
        int threads = 8;
        CountDownLatch startGate = new CountDownLatch(1);
        AtomicInteger leakedErrors = new AtomicInteger();
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        TransactionTemplate tx = new TransactionTemplate(new DataSourceTransactionManager(dataSource));

        try {
            List<Future<?>> futures = new java.util.ArrayList<>();
            for (int i = 0; i < threads; i++) {
                futures.add(pool.submit(() -> {
                    try {
                        startGate.await();
                        // 每个线程独立事务：并发性来自「各自开事务、各自走 锁→查→插」的完整临界区。
                        tx.executeWithoutResult(status -> service.appendRound(SESSION_ID, null, TURN_ID,
                                AiMessageEntity.builder().text("相同答案").build(),
                                List.of(ToolMessageEntity.builder().id("call_x").name("read_file").text("内容").build()),
                                RESPONSE_ID));
                    } catch (Exception error) {
                        leakedErrors.incrementAndGet();
                    }
                }));
            }
            startGate.countDown();
            for (Future<?> future : futures) future.get(30, TimeUnit.SECONDS);
        } finally {
            pool.shutdownNow();
        }

        assertEquals(0, leakedErrors.get(), "并发同内容重复提交不得向调用方泄漏异常");
        // 事务外统计：恰好一行 AI，恰好一工具行（工具行随 AI 同事务落库，不重复）。
        assertEquals(1L, countByType("AI"), "同一 responseId 的 AI 行必须恰好一行");
        assertEquals(1L, countByType("TOOL"), "工具行不得随并发重复产生");
    }

    /**
     * 并发同身份**不同内容** → 必须有且只有一次失败被暴露（内容漂移不能被静默吞）。
     *
     * <p>回归「查到已存在就 return，不比对内容」：那种实现下两个线程都成功、行数也不多，
     * 漂移被完全掩盖 —— 本用例会因 {@code leakedErrors == 0} 而变红。</p>
     */
    @Test
    @DisplayName("并发提交同一 responseId（内容漂移）→ 至少一次被拒绝，不静默吞")
    void concurrentDriftingContentIsRejected() throws Exception {
        int threads = 4;
        CountDownLatch startGate = new CountDownLatch(1);
        AtomicInteger rejected = new AtomicInteger();
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        TransactionTemplate tx = new TransactionTemplate(new DataSourceTransactionManager(dataSource));

        try {
            List<Future<?>> futures = new java.util.ArrayList<>();
            for (int i = 0; i < threads; i++) {
                int index = i;
                futures.add(pool.submit(() -> {
                    try {
                        startGate.await();
                        tx.executeWithoutResult(status -> service.appendRound(SESSION_ID, null, TURN_ID,
                                AiMessageEntity.builder().text("内容-" + index).build(), List.of(), RESPONSE_ID));
                    } catch (Exception error) {
                        rejected.incrementAndGet();
                    }
                }));
            }
            startGate.countDown();
            for (Future<?> future : futures) future.get(30, TimeUnit.SECONDS);
        } finally {
            pool.shutdownNow();
        }

        // 首到者成功，其余同为「已存在但内容不同」→ 被拒绝。至少一个失败必须被暴露。
        assertTrue(rejected.get() >= 1, "内容漂移必须被拒绝并暴露，而不是静默丢弃");
        assertEquals(1L, countByType("AI"), "无论拒绝多少次，最终仍只落一行");
    }

    private long countByType(String type) throws Exception {
        // 事务之外、独立连接：读到的是已提交的最终态。
        try (Connection connection = dataSource.getConnection();
             Statement statement = connection.createStatement();
             ResultSet resultSet = statement.executeQuery(
                     "SELECT COUNT(*) FROM session_message WHERE type = '" + type + "'")) {
            resultSet.next();
            return resultSet.getLong(1);
        }
    }
}
