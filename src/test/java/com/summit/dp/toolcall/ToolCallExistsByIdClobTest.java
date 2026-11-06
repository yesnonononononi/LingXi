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
 * {@code existsById} 的存在性判定不得读出 CLOB 列。
 *
 * <p>登记器的幂等预检每轮工具调用都会走一次，而 {@code tool_call} 有 4 个 CLOB：
 * 一旦用 {@code selectById} 判定存在性，每轮都要为「整段文件内容 / 命令输出」付一次
 * H2 临时 LOB 写放大。本用例钉住的是<b>实际下发的 SQL</b>，不是方法返回值的形状。</p>
 */
class ToolCallExistsByIdClobTest {

    private static final String EXISTING_ID = "call_exists";

    private H2TestDatabase database;
    private SqlCaptureInterceptor capture;
    private ToolCallRepositoryImpl repository;

    @BeforeEach
    void setup() throws Exception {
        database = H2TestDatabase.create("ToolCallExistsByIdClobTest");
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
        repository.save(heavyRow(EXISTING_ID, 1L));
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    @Test
    @DisplayName("存在性判定走 COUNT(*)：SQL 不含 content/raw_input/raw_output/meta_data")
    void existsByIdNeverSelectsClobColumns() {
        // 前提：这一行确实带着大 CLOB —— 否则「没读 CLOB」的断言可能是空的。
        // 用仓储整行读回（不直接查业务表），随后 clear 再把被测调用单独量一遍。
        ToolCall stored = repository.findById(EXISTING_ID).orElseThrow();
        assertTrue(stored.getRawOutput().length() > 256,
                "前提：raw_output 必须超过 H2 的行内阈值，否则不会触发临时 LOB");

        capture.clear();
        assertTrue(repository.existsById(EXISTING_ID), "已存在的调用必须判定为存在");
        List<String> queries = capture.queries();
        assertEquals(1, queries.size(), "存在性判定只应下发一条查询，实际: " + queries);
        String sql = SqlCaptureInterceptor.normalize(queries.getFirst());
        assertTrue(sql.replace(" ", "").contains("selectcount(*)"),
                "存在性判定必须走 COUNT(*)，实际: " + sql);
        for (String clob : List.of("content", "raw_input", "raw_output", "meta_data")) {
            assertFalse(sql.contains(clob), "存在性判定的 SQL 不得命中 CLOB 列 " + clob + "，实际: " + sql);
        }

        // 正对照（金丝雀）：同一条记录走全量读时 SQL 必然带上这几个 CLOB 列 ——
        // 证明上面的「不含」断言确实能因列被读出来而变红。
        capture.clear();
        assertTrue(repository.findById(EXISTING_ID).isPresent());
        String full = SqlCaptureInterceptor.normalize(capture.queries().getFirst());
        for (String clob : List.of("content", "raw_input", "raw_output", "meta_data")) {
            assertTrue(full.contains(clob), "金丝雀失效：全量读的 SQL 竟然不含 " + clob + "，实际: " + full);
        }
    }

    @Test
    @DisplayName("不存在的 id 与空 id 都返回 false，空 id 不下发查询")
    void missingIdReturnsFalse() {
        capture.clear();
        assertFalse(repository.existsById("call_missing"));
        assertEquals(1, capture.queries().size(), "不存在的 id 仍应查一次库");

        capture.clear();
        assertFalse(repository.existsById(null));
        assertEquals(0, capture.queries().size(), "空 id 必须直接短路，不下发查询");
    }

    /** 四个 CLOB 都塞满超过 256 字节的内容，确保 H2 会为它们各自触发 LOB 落盘。 */
    private static ToolCall heavyRow(String id, long conversationId) {
        String heavy = "输出正文".repeat(2000);
        return ToolCall.builder()
                .id(id)
                .conversationId(conversationId)
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
