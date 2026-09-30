package com.summit.dp.execution;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.summit.dp.execution.application.service.ExecutionQueryService;
import com.summit.dp.execution.application.service.impl.ExecutionQueryServiceImpl;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
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
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 执行摘要的批量装配（2026-09-30 改造）。
 *
 * <p>用真实 Mapper + H2 验证两件事：<b>一次 IN 查询取回全部摘要字段</b>（不是 N+1），
 * 以及 <b>不加载 snapshot</b> —— 检查点是 LONGTEXT，历史列表一次可能装几十个执行，
 * 为展示几个数字把检查点全读进内存是不可接受的。</p>
 */
class ExecutionSummaryQueryTest {

    private static final long SESSION_ID = 11L;

    private EmbeddedDatabase database;
    private ExecutionMapper mapper;
    private ExecutionRepositoryImpl repository;
    private ExecutionQueryServiceImpl service;

    @BeforeEach
    void setup() throws Exception {
        database = new EmbeddedDatabaseBuilder().generateUniqueName(true).setType(EmbeddedDatabaseType.H2)
                .addScript("execution-status-schema.sql").build();
        MybatisConfiguration configuration = new MybatisConfiguration();
        // 与生产一致：自定义查询的字段映射必须独立于全局驼峰开关。
        configuration.setMapUnderscoreToCamelCase(false);
        configuration.addMapper(ExecutionMapper.class);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        SqlSessionFactory sessionFactory = factory.getObject();
        SqlSessionTemplate session = new SqlSessionTemplate(sessionFactory);
        mapper = session.getMapper(ExecutionMapper.class);
        repository = new ExecutionRepositoryImpl(mapper);
        service = new ExecutionQueryServiceImpl(repository);
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    private void insert(long id, int status, String modelName, String modelProvider,
                        Long inputTokens, Long outputTokens, Long totalTokens,
                        LocalDateTime startedAt, LocalDateTime completedAt) {
        ExecutionPO row = new ExecutionPO();
        row.setId(id);
        row.setSessionId(SESSION_ID);
        row.setStatus(status);
        row.setModelName(modelName);
        row.setModelProvider(modelProvider);
        row.setInputTokenCount(inputTokens);
        row.setOutputTokenCount(outputTokens);
        row.setTotalTokenCount(totalTokens);
        row.setStartedAt(startedAt);
        row.setCompletedAt(completedAt);
        // 故意塞入大字符串：摘要查询若把 snapshot 一起读出来，本测试就会在断言处暴露。
        row.setSnapshot("{\"marker\":\"" + "x".repeat(2048) + "\"}");
        mapper.insert(row);
    }

    @Test
    @DisplayName("按执行 id 批量装配摘要：状态、模型快照、用量、起止时间一次取回")
    void assemblesSummariesInOneBatch() {
        LocalDateTime started = LocalDateTime.of(2026, 9, 30, 10, 0);
        LocalDateTime completed = LocalDateTime.of(2026, 9, 30, 10, 0, 30);
        insert(701L, 3, "deepseek-chat", "deepseek", 120L, 30L, 150L, started, completed);
        insert(702L, 4, null, null, null, null, null, null, null);

        Map<Long, ExecutionQueryService.ExecutionSummary> summaries =
                service.summariesByIds(List.of(701L, 702L));

        assertEquals(2, summaries.size());

        ExecutionQueryService.ExecutionSummary done = summaries.get(701L);
        assertEquals(701L, done.executionId());
        assertEquals(SESSION_ID, done.sessionId(), "会话归属必须带出来，供装配时校验");
        assertEquals("COMPLETED", done.status());
        assertEquals("deepseek-chat", done.modelName());
        assertEquals("deepseek", done.modelProvider());
        assertEquals(120L, done.inputTokens());
        assertEquals(30L, done.outputTokens());
        assertEquals(150L, done.totalTokens());
        assertEquals(toInstant(started), done.startedAt());
        assertEquals(toInstant(completed), done.completedAt());

        ExecutionQueryService.ExecutionSummary failed = summaries.get(702L);
        assertEquals("FAILED", failed.status());
        assertNull(failed.modelName());
        // 未采集到的用量必须是 null，不能被读成 0 —— 前端据此显示「暂无统计」。
        assertNull(failed.inputTokens());
        assertNull(failed.outputTokens());
        assertNull(failed.totalTokens());
        assertNull(failed.startedAt(), "没跑起来的执行没有开始时间");
    }

    @Test
    @DisplayName("摘要投影不加载 snapshot：历史列表不得把恢复检查点读进内存")
    void summaryProjectionSkipsSnapshot() {
        insert(711L, 3, "m", "p", 1L, 2L, 3L, LocalDateTime.now(), LocalDateTime.now());

        List<Execution> rows = repository.findSummariesByIds(List.of(711L));

        assertEquals(1, rows.size());
        assertNull(rows.getFirst().getSnapshot(), "摘要投影必须排除 snapshot 列");
        assertEquals("m", rows.getFirst().getModelName());
    }

    @Test
    @DisplayName("空入参不查库；不存在的执行直接缺席，由调用方按摘要缺失降级")
    void emptyInputAndUnknownIdsDegradeQuietly() {
        assertTrue(service.summariesByIds(null).isEmpty());
        assertTrue(service.summariesByIds(List.of()).isEmpty());
        assertTrue(repository.findSummariesByIds(List.of()).isEmpty());

        insert(721L, 3, "m", "p", 1L, 2L, 3L, LocalDateTime.now(), LocalDateTime.now());
        Map<Long, ExecutionQueryService.ExecutionSummary> summaries =
                service.summariesByIds(List.of(721L, 999_999L));
        assertEquals(1, summaries.size(), "不存在的执行 id 不应凭空造出一条摘要");
        assertTrue(summaries.containsKey(721L));
    }

    /** 库列是无时区的 {@code DATETIME}，按本机时区解释 —— 与写入侧同一口径。 */
    private static Instant toInstant(LocalDateTime value) {
        return value.atZone(ZoneId.systemDefault()).toInstant();
    }
}
