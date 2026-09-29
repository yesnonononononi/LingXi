package com.summit.dp.toolcall;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.infrastructure.persistence.mapper.ToolCallMapper;
import com.summit.dp.toolcall.infrastructure.persistence.repository.ToolCallRepositoryImpl;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;

/**
 * {@code tool_call} 表的持久化回归：PO + Mapper + RepositoryImpl 的整行读写与事务回滚。
 *
 * <p>由旧 {@code CommandApprovalPersistenceTest} 演进而来：证明「状态推进必须经充血模型，
 * 再整行落库」在真实数据库往返中成立，且未提交的状态变更随事务回滚而消失。</p>
 */
class ToolCallPersistenceTest {

    private EmbeddedDatabase database;
    private ToolCallRepositoryImpl repository;
    private TransactionTemplate transactions;

    @BeforeEach
    void setup() throws Exception {
        database = new EmbeddedDatabaseBuilder().generateUniqueName(true).setType(EmbeddedDatabaseType.H2)
                .addScript("tool-call-schema.sql").build();
        MybatisConfiguration configuration = new MybatisConfiguration();
        configuration.setMapUnderscoreToCamelCase(true);
        configuration.addMapper(ToolCallMapper.class);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        SqlSessionFactory sessionFactory = factory.getObject();
        SqlSessionTemplate session = new SqlSessionTemplate(sessionFactory);
        repository = new ToolCallRepositoryImpl(session.getMapper(ToolCallMapper.class));
        transactions = new TransactionTemplate(new DataSourceTransactionManager(database));
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    @Test
    void roundTripsAllColumnsIncludingJsonPayloads() {
        ToolCall promise = ToolCall.builder()
                .id("call_100")
                .conversationId(1L)
                .executionId(11L)
                .toolName("create_plan")
                .type(ToolCallType.PROMISE)
                .status(ToolCallStatus.PENDING)
                .title("重构计划")
                .content("{\"kind\":\"PLAN\",\"title\":\"重构计划\",\"text\":\"# 步骤\"}")
                .rawInput("{\"args\":{\"title\":\"重构计划\"}}")
                .metaData("{\"_meta\":{\"schemaVersion\":1,\"executionId\":\"11\"}}")
                .createdAt(Instant.now())
                .updatedAt(Instant.now())
                .build();
        repository.save(promise);

        ToolCall found = repository.findById("call_100").orElseThrow();
        assertEquals("call_100", found.getId());
        assertEquals(1L, found.getConversationId());
        assertEquals(11L, found.getExecutionId());
        assertEquals(ToolCallType.PROMISE, found.getType());
        assertEquals(ToolCallStatus.PENDING, found.getStatus());
        assertTrue(found.isApprovalPending());
        assertEquals("重构计划", found.getTitle());
        assertTrue(found.getContent().contains("PLAN"));
        assertTrue(repository.existsById("call_100"));
    }

    @Test
    void batchQueryFetchesDedupIdsInOneRoundTrip() {
        repository.save(pending("call_a", 5L, 50L));
        repository.save(pending("call_b", 5L, 50L));
        repository.save(pending("call_c", 6L, 60L));

        List<ToolCall> found = repository.listByIds(List.of("call_a", "call_c", "call_a"));
        assertEquals(2, found.size());
        assertTrue(repository.listByIds(List.of()).isEmpty());
        assertEquals(2L, repository.countByConversationId(5L));
    }

    @Test
    void completingIsTerminalAndIdempotent() {
        ToolCall toolCall = pending("call_t", 7L, 70L);
        repository.save(toolCall);

        ToolCall live = repository.findById("call_t").orElseThrow();
        assertTrue(live.complete("{\"outcome\":\"APPROVED\"}"));
        repository.updateById(live);

        ToolCall terminal = repository.findById("call_t").orElseThrow();
        assertTrue(terminal.isCompleted());
        // 第二次 complete 幂等：不改状态、不落库。
        assertFalse(terminal.complete("{\"outcome\":\"REJECTED\"}"));
        assertEquals("{\"outcome\":\"APPROVED\"}", repository.findById("call_t").orElseThrow().getRawOutput());
    }

    @Test
    void bindSessionMessageBackfillsAnchor() {
        repository.save(pending("call_anchor", 8L, 80L));
        repository.bindSessionMessage("call_anchor", 909L);
        assertEquals(909L, repository.findById("call_anchor").orElseThrow().getSessionMessageId());
        // 空值保护：不做任何写入，也不抛异常。
        assertDoesNotThrow(() -> repository.bindSessionMessage("call_anchor", null));
        assertEquals(909L, repository.findById("call_anchor").orElseThrow().getSessionMessageId());
    }

    @Test
    void deleteByConversationIdsCascades() {
        repository.save(pending("call_d1", 9L, 90L));
        repository.save(pending("call_d2", 9L, 90L));
        repository.save(pending("call_d3", 10L, 100L));

        assertEquals(2, repository.deleteByConversationIds(List.of(9L)));
        assertTrue(repository.listByConversationId(9L).isEmpty());
        assertEquals(1, repository.listByConversationId(10L).size());
    }

    @Test
    void statusChangeRollsBackWithTransaction() {
        repository.save(pending("call_r", 12L, 120L));

        assertThrows(IllegalStateException.class, () -> transactions.executeWithoutResult(status -> {
            Optional<ToolCall> current = repository.findById("call_r");
            ToolCall toolCall = current.orElseThrow();
            toolCall.complete("{\"outcome\":\"APPROVED\"}");
            repository.updateById(toolCall);
            throw new IllegalStateException("transaction failed");
        }));

        ToolCall restored = repository.findById("call_r").orElseThrow();
        assertTrue(restored.isPending());
        assertNull(restored.getRawOutput());
    }

    private static ToolCall pending(String id, long conversationId, long executionId) {
        return ToolCall.builder()
                .id(id)
                .conversationId(conversationId)
                .executionId(executionId)
                .toolName("command")
                .type(ToolCallType.PROMISE)
                .status(ToolCallStatus.PENDING)
                .title("命令审批")
                .content("{\"kind\":\"COMMAND\",\"command\":\"echo hi\"}")
                .rawInput("{\"args\":{\"command\":\"echo hi\"}}")
                .createdAt(Instant.now())
                .updatedAt(Instant.now())
                .build();
    }
}
