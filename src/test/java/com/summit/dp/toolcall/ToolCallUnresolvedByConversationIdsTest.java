package com.summit.dp.toolcall;

import com.baomidou.mybatisplus.annotation.DbType;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.plugins.MybatisPlusInterceptor;
import com.baomidou.mybatisplus.extension.plugins.inner.PaginationInnerInterceptor;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.shared.support.SqlCaptureInterceptor;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.infrastructure.persistence.mapper.ToolCallMapper;
import com.summit.dp.toolcall.infrastructure.persistence.repository.ToolCallRepositoryImpl;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 多会话未决卡片必须一次 {@code IN} 查完，且只返回未决槽位。
 *
 * <p>bootstrap 原先按会话树逐个 {@code listByConversationId} 再在内存里过滤，会话树有多少节点
 * 就查多少次；谓词下推后一次查完。本用例在真库上同时钉住「一次查询」与「过滤口径」——
 * 只断言方法被调用，只会漏掉「谓词写错把已完成卡片也带出来」这一半。</p>
 */
class ToolCallUnresolvedByConversationIdsTest {

    private static final long SESSION_A = 10L;
    private static final long SESSION_B = 11L;
    /** 不属于本次 IN 的会话：它的未决卡片绝不能被带出来。 */
    private static final long OTHER_SESSION = 12L;

    private H2TestDatabase database;
    private SqlCaptureInterceptor capture;
    private ToolCallRepositoryImpl repository;

    @BeforeEach
    void setup() throws Exception {
        database = H2TestDatabase.create("ToolCallUnresolvedByConversationIdsTest");
        capture = new SqlCaptureInterceptor();
        MybatisConfiguration configuration = database.configuration(ToolCallMapper.class);
        configuration.addInterceptor(capture);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        MybatisPlusInterceptor plugins = new MybatisPlusInterceptor();
        plugins.addInnerInterceptor(new PaginationInnerInterceptor(DbType.H2));
        factory.setPlugins(plugins);
        SqlSessionFactory sessionFactory = factory.getObject();
        repository = new ToolCallRepositoryImpl(
                H2TestDatabase.sqlSession(sessionFactory).getMapper(ToolCallMapper.class),
                new ObjectMapper(), ToolCallPersistenceTest.buildCardAvailabilityPolicy());

        repository.save(row("a-preparing", SESSION_A, ToolCallStatus.PREPARING));
        repository.save(row("a-pending", SESSION_A, ToolCallStatus.PENDING));
        repository.save(row("b-in-progress", SESSION_B, ToolCallStatus.IN_PROGRESS));
        // 已收尾与「非 PROMISE」都不是未决槽位。
        repository.save(row("a-completed", SESSION_A, ToolCallStatus.COMPLETED));
        repository.save(row("a-execute", SESSION_B, ToolCallStatus.PENDING).toBuilder()
                .type(ToolCallType.EXECUTE).build());
        repository.save(row("other-pending", OTHER_SESSION, ToolCallStatus.PENDING));
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    @Test
    @DisplayName("多会话一次 IN：只返回未决 PROMISE，且只下发一条查询")
    void returnsOnlyUnresolvedAcrossSessionsInOneQuery() {
        capture.clear();
        List<ToolCall> unresolved = repository.listUnresolvedByConversationIds(List.of(SESSION_A, SESSION_B));

        assertEquals(List.of("a-pending", "a-preparing", "b-in-progress"),
                unresolved.stream().map(ToolCall::getId).sorted().toList(),
                "只应有 PROMISE 且非 completed 的槽位");
        assertEquals(1, capture.queries().size(), "整棵会话树只应查一次，实际: " + capture.queries());
        String sql = SqlCaptureInterceptor.normalize(capture.queries().getFirst());
        assertTrue(sql.contains("in ("), "必须是一次 IN 查询，实际: " + sql);
        assertTrue(sql.contains("conversation_id"), "实际: " + sql);
        assertTrue(sql.contains("status in"), "状态过滤必须下推到 SQL，实际: " + sql);
    }

    @Test
    @DisplayName("空集合与 null 直接返回空列表，不下发查询")
    void emptyIdsShortCircuit() {
        capture.clear();
        assertTrue(repository.listUnresolvedByConversationIds(List.of()).isEmpty());
        assertTrue(repository.listUnresolvedByConversationIds(null).isEmpty());
        assertEquals(0, capture.queries().size());
    }

    private static ToolCall row(String id, long conversationId, ToolCallStatus status) {
        return ToolCall.builder()
                .id(id)
                .conversationId(conversationId)
                .executionId(conversationId * 100)
                .toolName("require_choice")
                .type(ToolCallType.PROMISE)
                .status(status)
                .title("选择")
                .content("{\"kind\":\"CHOICE\",\"question\":\"选一个\"}")
                .rawInput("{\"args\":{}}")
                .createdAt(Instant.now())
                .updatedAt(Instant.now())
                .build();
    }
}
