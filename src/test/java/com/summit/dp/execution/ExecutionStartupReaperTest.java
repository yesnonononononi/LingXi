package com.summit.dp.execution;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.summit.dp.execution.infrastructure.config.ExecutionStartupReaper;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.mock;

/**
 * 启动执行收尸钩子（{@code ExecutionStartupReaper}）回归：
 * 进程崩溃重启后，遗留的 CREATED / RUNNING 执行由启动钩子收口为 FAILED，
 * SUSPENDED（待恢复）与终态行不受影响，收口幂等可重复执行。
 */
class ExecutionStartupReaperTest {

    private static final int STATUS_CREATED = 0;
    private static final int STATUS_RUNNING = 1;
    private static final int STATUS_SUSPENDED = 2;
    private static final int STATUS_COMPLETED = 3;
    private static final int STATUS_FAILED = 4;

    private EmbeddedDatabase database;
    private ExecutionMapper mapper;
    private ExecutionRepositoryImpl repository;

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
        SqlSessionTemplate session = new SqlSessionTemplate(sessionFactory);
        mapper = session.getMapper(ExecutionMapper.class);
        repository = new ExecutionRepositoryImpl(mapper);
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    @Test
    @DisplayName("崩溃收口：仅 CREATED / RUNNING 收口为 FAILED，SUSPENDED 与终态不动")
    void reapsOnlyCreatedAndRunning() {
        long createdId = insertExecution(101L, STATUS_CREATED);
        long runningId = insertExecution(102L, STATUS_RUNNING);
        long suspendedId = insertExecution(103L, STATUS_SUSPENDED);
        long completedId = insertExecution(104L, STATUS_COMPLETED);

        new ExecutionStartupReaper(repository).onApplicationEvent(mock(ApplicationReadyEvent.class));

        assertEquals(STATUS_FAILED, repository.findById(createdId).orElseThrow().getStatus(),
                "CREATED 应被收口为 FAILED");
        assertEquals(STATUS_FAILED, repository.findById(runningId).orElseThrow().getStatus(),
                "RUNNING 应被收口为 FAILED");
        assertEquals(STATUS_SUSPENDED, repository.findById(suspendedId).orElseThrow().getStatus(),
                "SUSPENDED（待恢复）不应被触碰");
        assertEquals(STATUS_COMPLETED, repository.findById(completedId).orElseThrow().getStatus(),
                "COMPLETED 终态不应被触碰");
    }

    @Test
    @DisplayName("幂等：重复触发不抛异常，第二次收口 0 行")
    void idempotentRepeat() {
        long createdId = insertExecution(201L, STATUS_CREATED);
        long runningId = insertExecution(202L, STATUS_RUNNING);

        ExecutionStartupReaper reaper = new ExecutionStartupReaper(repository);
        assertDoesNotThrow(() -> {
            reaper.onApplicationEvent(mock(ApplicationReadyEvent.class));
            reaper.onApplicationEvent(mock(ApplicationReadyEvent.class));
        });

        assertEquals(STATUS_FAILED, repository.findById(createdId).orElseThrow().getStatus());
        assertEquals(STATUS_FAILED, repository.findById(runningId).orElseThrow().getStatus());
        assertEquals(0, repository.markOrphanRunsFailed(), "已全部收口，重复收口应命中 0 行");
    }

    /** 仅写入本测试关心的列，其余列取表默认值；回填并返回自增主键。 */
    private long insertExecution(long sessionId, int status) {
        ExecutionPO po = new ExecutionPO();
        po.setSessionId(sessionId);
        po.setStatus(status);
        mapper.insert(po);
        return po.getId();
    }
}
