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
import com.summit.dp.toolcall.domain.model.ToolCallBlockView;
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
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 单块推送的只读投影只读装配块真正用到的列。
 *
 * <p>{@code content} / {@code raw_input} / {@code meta_data} 三个 CLOB 在装配工具块时一个都用不到，
 * 读它们等于给每次工具收尾白加一次 H2 临时 LOB 写放大。这里在真库上断言：<b>下发的 SQL 不含这三列</b>，
 * 且投影里 {@code rawOutput} 有值 —— 后者证明裁剪没有连 {@code raw_output} 一起丢掉
 * （工具块的成败状态就来自它）。</p>
 */
class ToolCallFindForBlockUpsertClobTest {

    private static final String TOOL_CALL_ID = "call_block";

    private H2TestDatabase database;
    private SqlCaptureInterceptor capture;
    private ToolCallRepositoryImpl repository;

    @BeforeEach
    void setup() throws Exception {
        database = H2TestDatabase.create("ToolCallFindForBlockUpsertClobTest");
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
        repository.save(heavyRow());
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    @Test
    @DisplayName("投影 SQL 含 raw_output，不含 content/raw_input/meta_data；投影里对应的 CLOB 为 null")
    void projectionSkipsUnusedClobs() {
        // 前提：三列在库里确实有大内容，否则「读出来是 null」可能只是因为库里本来就没有。
        for (String column : List.of("content", "raw_input", "meta_data")) {
            assertTrue(Integer.parseInt(database.queryString(
                            "SELECT LENGTH(" + column + ") FROM tool_call WHERE id = '" + TOOL_CALL_ID + "'")) > 256,
                    "前提：" + column + " 必须超过 256 字节");
        }

        capture.clear();
        Optional<ToolCallBlockView> projection = repository.findForBlockUpsert(TOOL_CALL_ID);

        assertTrue(projection.isPresent(), "已存在的调用必须能投影出来");
        assertEquals(1, capture.queries().size(), "只应下发一条查询，实际: " + capture.queries());
        String sql = SqlCaptureInterceptor.normalize(capture.queries().getFirst());
        assertTrue(sql.contains("raw_output"), "工具块状态依赖 raw_output，必须保留，实际: " + sql);
        for (String clob : List.of("content", "raw_input", "meta_data")) {
            assertFalse(sql.contains(clob), "投影不得命中 " + clob + "，实际: " + sql);
        }

        ToolCallBlockView row = projection.get();
        assertNotNull(row.rawOutput(), "raw_output 必须读到：工具块的成败状态由它决定");
        assertEquals(TOOL_CALL_ID, row.id());
        assertEquals(7L, row.conversationId());
        assertEquals("read_file", row.toolName());
        assertEquals(ToolCallType.EXECUTE, row.type());
        assertEquals(ToolCallStatus.COMPLETED, row.status());
        assertEquals(4L, row.version());
    }

    @Test
    @DisplayName("行不存在与空 id：返回空，不抛异常")
    void missingRowYieldsEmpty() {
        capture.clear();
        assertTrue(repository.findForBlockUpsert("call_missing").isEmpty());
        assertEquals(1, capture.queries().size());

        capture.clear();
        assertTrue(repository.findForBlockUpsert(null).isEmpty());
        assertEquals(0, capture.queries().size(), "空 id 必须直接短路");
    }

    private static ToolCall heavyRow() {
        String heavy = "输出正文".repeat(2000);
        return ToolCall.builder()
                .id(TOOL_CALL_ID)
                .conversationId(7L)
                .executionId(70L)
                .toolName("read_file")
                .type(ToolCallType.EXECUTE)
                .status(ToolCallStatus.COMPLETED)
                .title("读文件")
                .content(heavy)
                .rawInput(heavy)
                .rawOutput("{\"outcome\":\"SUCCEEDED\",\"output\":\"" + heavy + "\"}")
                .metaData(heavy)
                .version(4L)
                .createdAt(Instant.now())
                .updatedAt(Instant.now())
                .build();
    }
}
