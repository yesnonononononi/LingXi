package com.summit.dp.toolcall;

import com.baomidou.mybatisplus.annotation.DbType;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.plugins.MybatisPlusInterceptor;
import com.baomidou.mybatisplus.extension.plugins.inner.PaginationInnerInterceptor;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.shared.exception.ClientException;
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
 * TOOL 行锚点回填必须是窄更新：不读、不写 4 个 CLOB，且必须推进版本号。
 *
 * <p>回填在每次模型响应落库时都会发生，原实现「findById 读 4 个 CLOB + updateById 全量写回」
 * 让一次锚点回填付两遍 H2 临时 LOB 写放大。本类同时钉住另一半语义：版本号自增不能丢 ——
 * 丢了之后，持有旧快照的写入方就不会在乐观锁上失败，锚点会被悄悄覆盖。</p>
 */
class ToolCallBindSessionMessageNarrowUpdateTest {

    private static final String TOOL_CALL_ID = "call_anchor";
    private static final long SESSION_MESSAGE_ID = 909L;

    private H2TestDatabase database;
    private SqlCaptureInterceptor capture;
    private ToolCallRepositoryImpl repository;

    @BeforeEach
    void setup() throws Exception {
        database = H2TestDatabase.create("ToolCallBindSessionMessageNarrowUpdateTest");
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
        repository.save(heavyRow(TOOL_CALL_ID));
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    @Test
    @DisplayName("回填锚点：UPDATE 只写 session_message_id/updated_at/version，不含任何 CLOB 列")
    void bindUpdatesOnlyNarrowColumns() {
        assertHeavyClobsPresent();

        capture.clear();
        repository.bindSessionMessage(TOOL_CALL_ID, SESSION_MESSAGE_ID);

        List<String> updates = capture.updates();
        assertEquals(1, updates.size(), "回填锚点只应下发一条 UPDATE，实际: " + updates);
        String sql = SqlCaptureInterceptor.normalize(updates.getFirst());
        for (String clob : List.of("content", "raw_input", "raw_output", "meta_data")) {
            assertFalse(sql.contains(clob), "锚点回填的 SQL 不得命中 CLOB 列 " + clob + "，实际: " + sql);
        }
        assertTrue(sql.contains("session_message_id"), "必须写入锚点列，实际: " + sql);
        // 版本号自增不能退化成「写死某个版本值」：那会让旧快照的冲突检测失效。
        assertTrue(sql.contains("version = version + 1"), "必须保留 version 自增，实际: " + sql);
        // 原实现的第一步是 findById（读 4 个 CLOB），窄更新不应再发这条查询。
        assertTrue(capture.queries().isEmpty(), "锚点回填不应再查一次整行，实际: " + capture.queries());

        ToolCall bound = repository.findById(TOOL_CALL_ID).orElseThrow();
        assertEquals(SESSION_MESSAGE_ID, bound.getSessionMessageId());
        assertEquals(2L, bound.getVersion(), "回填必须把版本推进 1");
    }

    @Test
    @DisplayName("重复回填同一消息：不产生实际变更（版本不再增长）")
    void repeatedBindIsNoOp() {
        repository.bindSessionMessage(TOOL_CALL_ID, SESSION_MESSAGE_ID);
        repository.bindSessionMessage(TOOL_CALL_ID, SESSION_MESSAGE_ID);

        ToolCall bound = repository.findById(TOOL_CALL_ID).orElseThrow();
        assertEquals(SESSION_MESSAGE_ID, bound.getSessionMessageId());
        assertEquals(2L, bound.getVersion(), "同值重复回填不得再次推进版本");
    }

    @Test
    @DisplayName("换一个锚点仍可回填：条件允许覆盖成另一个 session_message_id")
    void rebindToAnotherMessageStillApplies() {
        repository.bindSessionMessage(TOOL_CALL_ID, SESSION_MESSAGE_ID);
        repository.bindSessionMessage(TOOL_CALL_ID, 910L);

        ToolCall rebound = repository.findById(TOOL_CALL_ID).orElseThrow();
        assertEquals(910L, rebound.getSessionMessageId());
        assertEquals(3L, rebound.getVersion(), "两次真实变更应各推进一次版本");
    }

    @Test
    @DisplayName("并发冲突：回填推进版本后，持有旧版本的 updateById 必须失败")
    void staleModelConflictsAfterBind() {
        ToolCall stale = repository.findById(TOOL_CALL_ID).orElseThrow();
        assertEquals(1L, stale.getVersion(), "前提：旧快照版本为 1");

        repository.bindSessionMessage(TOOL_CALL_ID, SESSION_MESSAGE_ID);

        stale.complete("{\"outcome\":\"APPROVED\"}");
        assertThrows(ClientException.class, () -> repository.updateById(stale),
                "版本已被回填推进，旧快照的整行更新必须撞乐观锁");

        ToolCall current = repository.findById(TOOL_CALL_ID).orElseThrow();
        assertEquals(SESSION_MESSAGE_ID, current.getSessionMessageId(), "锚点不能被旧快照覆盖");
        assertEquals(2L, current.getVersion());
        assertEquals(ToolCallStatus.IN_PROGRESS, current.getStatus(), "旧快照的结论也不能落库");
    }

    /** 前提校验：这一行确实带着超过行内阈值的大 CLOB，否则「没碰 CLOB」的断言没有意义。 */
    private void assertHeavyClobsPresent() {
        String lengths = database.queryString(
                "SELECT LENGTH(raw_output) || '/' || LENGTH(content) || '/' || LENGTH(raw_input)"
                        + " || '/' || LENGTH(meta_data) FROM tool_call WHERE id = '" + TOOL_CALL_ID + "'");
        for (String length : lengths.split("/")) {
            assertTrue(Integer.parseInt(length) > 256, "前提：四个 CLOB 都必须超过 256 字节，实际: " + lengths);
        }
    }

    private static ToolCall heavyRow(String id) {
        String heavy = "输出正文".repeat(2000);
        return ToolCall.builder()
                .id(id)
                .conversationId(1L)
                .executionId(10L)
                .toolName("read_file")
                .type(ToolCallType.EXECUTE)
                .status(ToolCallStatus.IN_PROGRESS)
                .title("读文件")
                .content(heavy)
                .rawInput(heavy)
                .rawOutput(heavy)
                .metaData(heavy)
                .createdAt(Instant.now())
                .updatedAt(Instant.now())
                .build();
    }
}
