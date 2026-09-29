package com.summit.dp.execution;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.summit.core.agent.ExecutionState;
import com.summit.dp.execution.application.service.impl.ExecutionQueryServiceImpl;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/** 通过真实 Mapper 验证状态查询、轻量映射及事务回滚。 */
class ExecutionQueryServiceTest {

    private EmbeddedDatabase database;
    private ExecutionMapper mapper;
    private ExecutionRepositoryImpl repository;
    private ExecutionQueryServiceImpl service;

    @BeforeEach
    void setup() throws Exception {
        database = new EmbeddedDatabaseBuilder().generateUniqueName(true).setType(EmbeddedDatabaseType.H2)
                .addScript("execution-status-schema.sql").build();
        MybatisConfiguration configuration = new MybatisConfiguration();
        // 自定义查询的字段映射必须独立于全局驼峰开关。
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

    @Test
    void emptyInputDoesNotReachPersistence() {
        ExecutionMapper unusedMapper = mock(ExecutionMapper.class);
        ExecutionRepositoryImpl emptyRepository = new ExecutionRepositoryImpl(unusedMapper);
        ExecutionQueryServiceImpl emptyService = new ExecutionQueryServiceImpl(emptyRepository);
        assertTrue(emptyService.latestStatesBySession(null).isEmpty());
        assertTrue(emptyService.latestStatesBySession(List.of()).isEmpty());
        assertTrue(emptyRepository.findLatestBySessionAndStatus(null).isEmpty());
        assertTrue(emptyRepository.findLatestBySessionAndStatus(List.of()).isEmpty());
        verifyNoInteractions(unusedMapper);
    }

    @Test
    void missingSessionsAreAbsent() {
        assertTrue(service.latestStatesBySession(List.of(99L)).isEmpty());
    }

    @Test
    void oldTerminalAndActiveStatesSurviveLongHistories() {
        insert(1L, 3);
        insert(2L, 2);
        for (int index = 0; index < 15; index++) {
            insert(1L, 2);
            insert(2L, 3);
        }
        insert(3L, 1);

        Map<Long, List<ExecutionState>> states = service.latestStatesBySession(List.of(1L, 2L, 99L));

        assertEquals(2, states.size());
        assertEquals(List.of(ExecutionState.SUSPENDED, ExecutionState.COMPLETED), states.get(1L));
        assertEquals(List.of(ExecutionState.COMPLETED, ExecutionState.SUSPENDED), states.get(2L));
    }

    @Test
    void latestExecutionPerStatusIsOrderedAndDoesNotLoadSnapshot() {
        for (int status = 0; status <= 5; status++) {
            insert(1L, status);
        }
        long newestId = insert(1L, 1);

        List<Execution> executions = repository.findLatestBySessionAndStatus(List.of(1L));

        assertEquals(6, executions.size());
        assertEquals(newestId, executions.getFirst().getId());
        for (Execution execution : executions) {
            assertEquals(1L, execution.getSessionId());
            assertEquals(LocalDateTime.of(2026, 9, 28, 12, 0), execution.getCreatedAt());
            assertNull(execution.getSnapshot());
            assertNull(execution.getUpdatedAt());
        }
        assertEquals(List.of(ExecutionState.RUNNING, ExecutionState.CANCELLED, ExecutionState.FAILED,
                ExecutionState.COMPLETED, ExecutionState.SUSPENDED, ExecutionState.CREATED),
                service.latestStatesBySession(List.of(1L)).get(1L));
    }

    @Test
    void stateQueryDoesNotRetainRolledBackExecutions() {
        TransactionTemplate transaction = new TransactionTemplate(new DataSourceTransactionManager(database));
        transaction.executeWithoutResult(status -> {
            insert(1L, 1);
            assertEquals(List.of(ExecutionState.RUNNING), service.latestStatesBySession(List.of(1L)).get(1L));
            status.setRollbackOnly();
        });
        assertTrue(service.latestStatesBySession(List.of(1L)).isEmpty());
    }

    @ParameterizedTest
    @NullSource
    @ValueSource(ints = {-1, 6})
    void unknownStatusCannotBePresentedAsIdle(Integer status) {
        Execution execution = mock(Execution.class);
        when(execution.getId()).thenReturn(1L);
        when(execution.getSessionId()).thenReturn(1L);
        when(execution.getStatus()).thenReturn(status);
        ExecutionRepository invalidRepository = mock(ExecutionRepository.class);
        when(invalidRepository.findLatestBySessionAndStatus(any())).thenReturn(List.of(execution));
        ExecutionQueryServiceImpl invalidService = new ExecutionQueryServiceImpl(invalidRepository);

        assertThrows(IllegalStateException.class, () -> invalidService.latestStatesBySession(List.of(1L)));
    }

    private long insert(long sessionId, int status) {
        ExecutionPO po = new ExecutionPO();
        po.setSessionId(sessionId);
        po.setStatus(status);
        po.setSnapshot("snapshot-must-not-be-loaded");
        po.setCreatedAt(LocalDateTime.of(2026, 9, 28, 12, 0));
        mapper.insert(po);
        return po.getId();
    }
}
