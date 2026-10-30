package com.summit.dp.execution;

import com.summit.dp.shared.persistence.MyBatisTypeHandlers;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.summit.dp.shared.support.SqliteTestDatabase;
import com.summit.dp.execution.application.port.ExecutionActivity;
import com.summit.dp.execution.application.service.ExecutionCleanupService;
import com.summit.dp.execution.application.service.ExecutionReclaimService;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionPO;
import com.summit.dp.turn.infrastructure.persistence.mapper.ChatTurnMapper;
import com.summit.dp.turn.infrastructure.persistence.po.ChatTurnPO;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 大快照在真实文件库上的回收：每条快照单独提交，引用保护与回滚开销都要成立。 */
class ExecutionCleanupFileStorageTest {
    @Test
    @Timeout(60)
    void cleanupLargeSnapshotsInFileDatabasePreservesReferencedHistory() throws Exception {
        SqliteTestDatabase database = SqliteTestDatabase.create("cleanup-file");
        try {
            MybatisConfiguration configuration = new MybatisConfiguration();
            configuration.setMapUnderscoreToCamelCase(true);
            MyBatisTypeHandlers.registerAll(configuration);
            configuration.addMapper(ExecutionMapper.class);
            configuration.addMapper(SessionMapper.class);
            configuration.addMapper(ChatTurnMapper.class);
            MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
            factory.setDataSource(database);
            factory.setConfiguration(configuration);
            SqlSessionTemplate sql = SqliteTestDatabase.sqlSession(factory.getObject());
            ExecutionMapper executions = sql.getMapper(ExecutionMapper.class);
            String snapshot = "x".repeat(512 * 1024);
            for (long id = 1L; id <= 240L; id++) {
                ExecutionPO row = new ExecutionPO();
                row.setId(id);
                row.setVersion(1L);
                row.setSessionId(10L);
                row.setStatus(ExecutionStatusCodes.COMPLETED);
                row.setSnapshot(snapshot);
                executions.insert(row);
            }
            ExecutionPO history = new ExecutionPO();
            history.setId(1000L);
            history.setVersion(1L);
            history.setSessionId(10L);
            history.setStatus(ExecutionStatusCodes.COMPLETED);
            history.setSnapshot(snapshot);
            executions.insert(history);
            sql.getMapper(SessionMapper.class).insert(SessionPO.builder().id(10L).name("历史保护").build());
            sql.getMapper(ChatTurnMapper.class).insert(ChatTurnPO.builder()
                    .id(20L).sessionId(10L).executionId(1000L).status("COMPLETED").build());
            ExecutionRepositoryImpl repository = new ExecutionRepositoryImpl(executions);
            AtomicInteger committed = new AtomicInteger();
            ExecutionActivity activity = executionId -> {
                assertTrue(TransactionSynchronizationManager.isActualTransactionActive());
                assertEquals(Long.parseLong(executionId) - 1, committed.get(), "下一条回收前必须提交上一条");
                TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                    @Override public void afterCommit() { committed.incrementAndGet(); }
                });
                return false;
            };
            DataSourceTransactionManager transactionManager = new DataSourceTransactionManager(database);
            ExecutionReclaimService reclaimer = new ExecutionReclaimService(repository, activity, transactionManager);
            ExecutionCleanupService service = new ExecutionCleanupService(repository, reclaimer);

            assertEquals(240L, service.preview().executionCount());
            ExecutionCleanupService.CleanupResult result = new TransactionTemplate(transactionManager)
                    .execute(status -> service.cleanup());
            assertNotNull(result);
            assertEquals(240L, result.deletedCount());
            assertEquals(240, committed.get());
            assertEquals(0L, service.preview().executionCount());
            assertEquals(1L, executions.selectCount(null));
            assertEquals(snapshot, executions.selectById(1000L).getSnapshot());
        } finally {
            database.shutdown();
        }
    }
}
