package com.summit.dp.execution;

import org.springframework.context.ApplicationEventPublisher;
import static org.mockito.Mockito.mock;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.summit.dp.execution.application.service.ExecutionCheckpointService;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.shared.exception.ClientException;
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
import java.time.ZoneId;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

/** 真实持久化守住迁移后的回滚、挂起代际、终态与版本竞争。 */
class ExecutionCheckpointMigrationTest {
    private EmbeddedDatabase database;
    private ExecutionMapper mapper;
    private ExecutionRepositoryImpl repository;
    private ExecutionCheckpointService checkpoints;
    private TransactionTemplate transactions;

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
        mapper = new SqlSessionTemplate(factory.getObject()).getMapper(ExecutionMapper.class);
        repository = new ExecutionRepositoryImpl(mapper);
        checkpoints = new ExecutionCheckpointService(repository, mock(ApplicationEventPublisher.class));
        transactions = new TransactionTemplate(new DataSourceTransactionManager(database));
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    @Test
    void repeatedSuspendedWritesPreserveGenerationAndOwnership() {
        Instant createdAt = Instant.parse("2026-10-01T00:00:00Z");
        checkpoints.save(305L, 405L, ExecutionStatusCodes.CREATED, "created", createdAt, null, null);
        checkpoints.save(305L, 999L, ExecutionStatusCodes.RUNNING, "running", null, createdAt, null);
        checkpoints.save(305L, 999L, ExecutionStatusCodes.SUSPENDED, "suspended", null, null, null);
        checkpoints.save(305L, 999L, ExecutionStatusCodes.SUSPENDED, "decision", null, null, null);
        ExecutionPO row = mapper.selectById(305L);
        assertEquals(1L, row.getResumeGeneration());
        assertEquals(4L, row.getVersion());
        assertEquals(405L, row.getSessionId());
        assertEquals(createdAt, row.getCreatedAt().atZone(ZoneId.systemDefault()).toInstant());
        assertEquals(createdAt, row.getStartedAt().atZone(ZoneId.systemDefault()).toInstant());
        checkpoints.save(305L, null, ExecutionStatusCodes.RUNNING, "resumed", null, null, null);
        checkpoints.save(305L, null, ExecutionStatusCodes.SUSPENDED, "next", null, null, null);
        assertEquals(2L, mapper.selectById(305L).getResumeGeneration());
    }

    @Test
    void rollbackRemovesCheckpointAndDoesNotConsumeGeneration() {
        transactions.executeWithoutResult(status -> {
            checkpoints.save(305L, 405L, ExecutionStatusCodes.CREATED, "created", null, null, null);
            checkpoints.save(305L, null, ExecutionStatusCodes.SUSPENDED, "suspended", null, null, null);
            status.setRollbackOnly();
        });
        assertNull(mapper.selectById(305L));
        checkpoints.save(305L, 405L, ExecutionStatusCodes.CREATED, "retry", null, null, null);
        assertEquals(0L, mapper.selectById(305L).getResumeGeneration());
    }

    @Test
    void terminalCheckpointCannotBeReopened() {
        checkpoints.save(305L, 405L, ExecutionStatusCodes.CREATED, "created", null, null, null);
        checkpoints.save(305L, null, ExecutionStatusCodes.FAILED, "failed", null, null, Instant.now());
        assertThrows(IllegalStateException.class, () -> checkpoints.save(305L, null,
                ExecutionStatusCodes.SUSPENDED, "stale", null, null, null));
        assertEquals("failed", mapper.selectById(305L).getSnapshot());
        assertEquals(2L, mapper.selectById(305L).getVersion());
    }

    @Test
    void concurrentUpdatesAllowOnlyOneVersionToCommit() throws Exception {
        checkpoints.save(305L, 405L, ExecutionStatusCodes.CREATED, "created", null, null, null);
        Execution first = repository.findCheckpointSummary(305L).orElseThrow(ClientException::new);
        Execution second = repository.findCheckpointSummary(305L).orElseThrow(ClientException::new);
        first.changeCheckpoint(ExecutionStatusCodes.SUSPENDED, "first", null, null);
        second.changeCheckpoint(ExecutionStatusCodes.SUSPENDED, "second", null, null);
        CountDownLatch start = new CountDownLatch(1);
        try (ExecutorService workers = Executors.newFixedThreadPool(2)) {
            Future<Boolean> firstResult = workers.submit(() -> updateAfterSignal(first, start));
            Future<Boolean> secondResult = workers.submit(() -> updateAfterSignal(second, start));
            start.countDown();
            assertNotEquals(firstResult.get(5, TimeUnit.SECONDS), secondResult.get(5, TimeUnit.SECONDS));
        }
        assertEquals(2L, mapper.selectById(305L).getVersion());
        assertEquals(1L, mapper.selectById(305L).getResumeGeneration());
    }

    private boolean updateAfterSignal(Execution execution, CountDownLatch start) throws InterruptedException {
        if (!start.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("并发测试启动超时");
        try {
            repository.updateById(execution);
            return true;
        } catch (ClientException conflict) {
            return false;
        }
    }
}
