package com.summit.dp.execution;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
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

import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * execution 表**投影读**的持久化回归。
 *
 * <p>这里守的是「只取一列 / 一行」的三个查询：选错列、漏状态条件、把排序写反，编译器一声不吭，
 * 调用方只会拿到错误的会话或错误的执行 —— 只有真打一次 H2 才拦得住。</p>
 */
class ExecutionRepositoryQueryTest {

    private static final long ROOT_SESSION_ID = 700L;
    private static final long CHILD_SESSION_ID = 701L;

    private EmbeddedDatabase database;
    private ExecutionRepository repository;
    private ExecutionMapper mapper;

    @BeforeEach
    void setup() throws Exception {
        database = new EmbeddedDatabaseBuilder().generateUniqueName(true).setType(EmbeddedDatabaseType.H2)
                .addScript("execution-status-schema.sql").build();
        MybatisConfiguration configuration = new MybatisConfiguration();
        configuration.setMapUnderscoreToCamelCase(true);
        configuration.addMapper(ExecutionMapper.class);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        SqlSessionFactory sessionFactory = factory.getObject();
        mapper = new SqlSessionTemplate(sessionFactory).getMapper(ExecutionMapper.class);
        repository = new ExecutionRepositoryImpl(mapper);
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    @Test
    @DisplayName("归属查询：回读会话列；执行行不存在返回空而不是猜一个会话")
    void findSessionIdReadsOwnerAndMissesMissingRow() {
        long executionId = insert(ROOT_SESSION_ID, ExecutionStatusCodes.RUNNING);

        assertEquals(Optional.of(ROOT_SESSION_ID), repository.findSessionId(executionId));
        assertTrue(repository.findSessionId(executionId + 999L).isEmpty(), "不存在的执行必须返回空");
    }

    @Test
    @DisplayName("可恢复执行：只认 SUSPENDED，且取 id 最大的那条")
    void findLatestSuspendedIdKeepsSuspendedOnlyAndPicksNewest() {
        long older = insert(ROOT_SESSION_ID, ExecutionStatusCodes.SUSPENDED);
        long newer = insert(ROOT_SESSION_ID, ExecutionStatusCodes.SUSPENDED);
        insert(ROOT_SESSION_ID, ExecutionStatusCodes.RUNNING);

        assertEquals(Optional.of(newer), repository.findLatestSuspendedId(ROOT_SESSION_ID),
                "必须取最近一次挂起，运行中的那条不能顶上来");
        assertTrue(older < newer);

        // 只有运行中的执行 ⇒ 没有可恢复边界，返回空。漏掉状态条件会让这条变红。
        long runningOnly = insert(CHILD_SESSION_ID, ExecutionStatusCodes.RUNNING);
        assertTrue(runningOnly > 0L);
        assertTrue(repository.findLatestSuspendedId(CHILD_SESSION_ID).isEmpty(),
                "会话里没有挂起执行时必须返回空");
    }

    @Test
    @DisplayName("未终结执行：只回 CREATED/RUNNING/SUSPENDED，且只认给定会话")
    void findUnfinishedBySessionsKeepsNonTerminalOfGivenSessions() {
        insert(ROOT_SESSION_ID, ExecutionStatusCodes.CREATED);
        insert(ROOT_SESSION_ID, ExecutionStatusCodes.COMPLETED);
        insert(CHILD_SESSION_ID, ExecutionStatusCodes.SUSPENDED);
        insert(999L, ExecutionStatusCodes.RUNNING);

        List<Execution> unfinished = repository.findUnfinishedBySessions(List.of(ROOT_SESSION_ID, CHILD_SESSION_ID));

        assertEquals(List.of(ExecutionStatusCodes.CREATED, ExecutionStatusCodes.SUSPENDED),
                unfinished.stream().map(Execution::getStatus).sorted().toList(),
                "只保留三种未终结状态，且不能跨会话泄漏");
        assertEquals(List.of(), repository.findUnfinishedBySessions(List.of()));
        assertEquals(List.of(), repository.findUnfinishedBySessions(null));
    }

    /** 直接落行，绕过检查点保存：本用例只验证读投影，不需要真实框架执行对象。 */
    private long insert(long sessionId, int status) {
        ExecutionPO row = new ExecutionPO();
        row.setSessionId(sessionId);
        row.setStatus(status);
        row.setVersion(1L);
        row.setResumeGeneration(0L);
        row.setSnapshot("{}");
        row.setCreatedAt(LocalDateTime.now());
        row.setUpdatedAt(LocalDateTime.now());
        mapper.insert(row);
        return row.getId();
    }
}
