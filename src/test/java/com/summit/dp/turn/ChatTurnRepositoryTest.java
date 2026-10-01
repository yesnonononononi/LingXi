package com.summit.dp.turn;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.model.ChatTurnStatus;
import com.summit.dp.turn.infrastructure.persistence.mapper.ChatTurnMapper;
import com.summit.dp.turn.infrastructure.persistence.po.ChatTurnPO;
import com.summit.dp.turn.infrastructure.persistence.repository.ChatTurnRepositoryImpl;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * chat_turn 持久化：往返、唯一键、以及**崩溃收尸的状态安全边界**。
 *
 * <p>收尸是一次状态覆写，所以要验证的不是"能写进去"，而是"不该写的绝不写"：
 * WAITING 代表挂起待恢复，误标 FAILED 会让用户再也恢复不了那次执行。</p>
 */
class ChatTurnRepositoryTest {

    private static final long SESSION_ID = 500L;
    private static final long EXECUTION_ID = 9001L;

    private EmbeddedDatabase database;
    private ChatTurnMapper mapper;
    private ChatTurnRepositoryImpl repository;

    @BeforeEach
    void setup() throws Exception {
        database = new EmbeddedDatabaseBuilder().generateUniqueName(true).setType(EmbeddedDatabaseType.H2)
                .addScript("chat-turn-schema.sql").build();
        MybatisConfiguration configuration = new MybatisConfiguration();
        configuration.setMapUnderscoreToCamelCase(false);
        configuration.addMapper(ChatTurnMapper.class);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        SqlSessionFactory sessionFactory = factory.getObject();
        mapper = new SqlSessionTemplate(sessionFactory).getMapper(ChatTurnMapper.class);
        repository = new ChatTurnRepositoryImpl(mapper);
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    private ChatTurn save(long turnId, ChatTurnStatus status, Long executionId) {
        ChatTurn turn = ChatTurn.accept(turnId, SESSION_ID, null, "deepseek-chat", "deepseek");
        turn.attachExecution(executionId);
        if (status == ChatTurnStatus.RUNNING || status == ChatTurnStatus.WAITING) {
            turn.markRunning(Instant.now());
        }
        if (status == ChatTurnStatus.WAITING) {
            turn.markWaiting();
        }
        if (status == ChatTurnStatus.COMPLETED) {
            turn.markCompleted(100L, 50L, 150L, Instant.now());
        }
        repository.save(turn);
        return turn;
    }

    @Test
    @DisplayName("往返完整：状态、模型快照、用量、时间都不丢；未知用量读回仍是 null 而不是 0")
    void roundTripKeepsEveryField() {
        Instant startedAt = Instant.now().minus(20, ChronoUnit.SECONDS);
        ChatTurn turn = ChatTurn.accept(7001L, SESSION_ID, 6001L, "deepseek-chat", "deepseek");
        turn.attachExecution(EXECUTION_ID);
        turn.markRunning(startedAt);
        turn.markCompleted(100L, 50L, 150L, Instant.now());
        repository.save(turn);

        ChatTurn loaded = repository.findByExecutionId(EXECUTION_ID).orElseThrow();

        assertEquals(7001L, loaded.getId());
        assertEquals(SESSION_ID, loaded.getSessionId());
        assertEquals(6001L, loaded.getParentTurnId(), "子委派的主轮次必须存下来");
        assertEquals(ChatTurnStatus.COMPLETED, loaded.getStatus());
        assertEquals("deepseek-chat", loaded.getModelName());
        assertEquals("deepseek", loaded.getModelProvider());
        assertEquals(100L, loaded.getInputTokenCount());
        assertEquals(150L, loaded.getTotalTokenCount());
        assertNotNull(loaded.getStartedAt());
        assertNotNull(loaded.getCompletedAt());
        assertNotNull(loaded.getCreatedAt());

        // 未采集到用量的轮次：读回来必须是 null，绝不能变成 0。
        save(7002L, ChatTurnStatus.ACCEPTED, null);
        ChatTurn reloaded = repository.findById(7002L).orElseThrow();
        assertNull(reloaded.getTotalTokenCount(), "未知用量读回仍是 null");
        assertNull(reloaded.getExecutionId(), "受理时未知执行 ID 的轮次，该列为空是合法状态");
    }

    @Test
    @DisplayName("按执行 ID 批量反查：一次 IN 取回多条，键可对上")
    void batchLookupByExecutionIds() {
        save(7011L, ChatTurnStatus.RUNNING, 9101L);
        save(7012L, ChatTurnStatus.COMPLETED, 9102L);
        save(7013L, ChatTurnStatus.ACCEPTED, null);

        List<ChatTurn> found = repository.findByExecutionIds(List.of(9101L, 9102L));

        assertEquals(2, found.size());
        assertTrue(found.stream().anyMatch(t -> t.getId() == 7011L));
        assertTrue(found.stream().anyMatch(t -> t.getId() == 7012L));
        assertTrue(repository.findByExecutionIds(List.of()).isEmpty());
    }

    @Test
    @DisplayName("execution_id 唯一键生效：一个执行不能挂两个轮次")
    void executionIdIsUnique() {
        save(7021L, ChatTurnStatus.ACCEPTED, 9201L);

        assertThrows(RuntimeException.class, () -> save(7022L, ChatTurnStatus.ACCEPTED, 9201L),
                "一轮一次执行，唯一键必须挡住第二个轮次");
    }

    @Test
    @DisplayName("收尸只命中 ACCEPTED / RUNNING：WAITING 与已终态绝不触碰")
    void reapClosesOnlyUnfinishedTurns() {
        save(7031L, ChatTurnStatus.ACCEPTED, null);
        save(7032L, ChatTurnStatus.RUNNING, 9302L);
        save(7033L, ChatTurnStatus.WAITING, 9303L);
        save(7034L, ChatTurnStatus.COMPLETED, 9304L);

        int reaped = repository.markOrphansFailed(Instant.now());

        assertEquals(2, reaped, "只有 ACCEPTED 与 RUNNING 该被收口");
        // 注意：PO 的 status 是 String（自由文本列），比较要用枚举名。
        assertEquals(ChatTurnStatus.FAILED.name(), mapper.selectById(7031L).getStatus());
        assertEquals(ChatTurnStatus.FAILED.name(), mapper.selectById(7032L).getStatus());
        assertNotNull(mapper.selectById(7031L).getCompletedAt(), "收口必须写结束时间");
        assertEquals(ChatTurnStatus.WAITING.name(), mapper.selectById(7033L).getStatus(),
                "挂起可恢复，误标失败会让「待恢复」入口消失");
        assertEquals(ChatTurnStatus.COMPLETED.name(), mapper.selectById(7034L).getStatus(), "已终态不得改写");
    }

    @Test
    @DisplayName("重复收尸幂等：第二次命中 0 行，不推进结束时间")
    void reapIsIdempotent() {
        save(7041L, ChatTurnStatus.ACCEPTED, null);

        assertEquals(1, repository.markOrphansFailed(Instant.now()));
        Instant first = mapper.selectById(7041L).getCompletedAt();
        assertEquals(0, repository.markOrphansFailed(Instant.now().plusSeconds(60)));
        assertEquals(first, mapper.selectById(7041L).getCompletedAt());
    }

    @Test
    @DisplayName("状态列是自由文本：非法值解析为 null 而不是抛异常把读取打挂")
    void unknownStatusDegradesToNull() {
        ChatTurnPO row = new ChatTurnPO();
        row.setId(7051L);
        row.setSessionId(SESSION_ID);
        row.setStatus("NOT_A_STATUS");
        mapper.insert(row);

        ChatTurn loaded = repository.findById(7051L).orElseThrow();

        assertNull(loaded.getStatus(), "非法状态降级为 null，由展示层处理");
    }
}
