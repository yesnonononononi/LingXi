package com.summit.dp.execution;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.execution.application.port.ExecutionActivity;
import com.summit.dp.execution.application.port.ExecutionCheckpointStore;
import com.summit.dp.execution.application.service.ExecutionCleanupService;
import com.summit.dp.execution.application.service.ExecutionReclaimService;
import com.summit.dp.execution.infrastructure.checkpoint.LocalFileCheckpointStore;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionPO;
import com.summit.dp.shared.persistence.MyBatisTypeHandlers;
import com.summit.dp.shared.support.SqliteTestDatabase;
import com.summit.dp.turn.infrastructure.persistence.mapper.ChatTurnMapper;
import com.summit.dp.turn.infrastructure.persistence.po.ChatTurnPO;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.harness.LocalCheckpointMaintenance;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

/** 大快照在真实文件库上的回收：每条快照单独提交，引用保护与回滚开销都要成立。 */
class ExecutionCleanupFileStorageTest {
    @Test
    @Timeout(60)
    void cleanupKeepsReferencedHistoryAndCommitsPerExecution() throws Exception {
        SqliteTestDatabase database = SqliteTestDatabase.create("cleanup-file");
        Path dataDir = ExecutionRepositoryTestFactory.tempDataDir();
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
            ObjectMapper mapper = new JsonConfig().objectMapper();
            LocalFileCheckpointStore store = new LocalFileCheckpointStore(dataDir.toString(), mapper);
            // 正文在文件里：每条历史行都指向自己那份真实文件，清理要连文件一起收掉。
            Map<Long, String> files = new java.util.HashMap<>();
            for (long id = 1L; id <= 240L; id++) {
                String fileId = publish(store, mapper, id);
                files.put(id, fileId);
                ExecutionPO row = new ExecutionPO();
                row.setId(id);
                row.setVersion(1L);
                row.setSessionId(10L);
                row.setStatus(ExecutionStatusCodes.COMPLETED);
                row.setSnapshotFile(fileId);
                executions.insert(row);
            }
            String historyFile = publish(store, mapper, 1000L);
            ExecutionPO history = new ExecutionPO();
            history.setId(1000L);
            history.setVersion(1L);
            history.setSessionId(10L);
            history.setStatus(ExecutionStatusCodes.COMPLETED);
            history.setSnapshotFile(historyFile);
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
            LocalCheckpointMaintenance maintenance = new LocalCheckpointMaintenance(store, repository);
            ExecutionReclaimService reclaimer = new ExecutionReclaimService(repository, activity,
                    maintenance, transactionManager);
            ExecutionCleanupService service = new ExecutionCleanupService(repository, reclaimer, maintenance);

            assertEquals(240L, service.preview().executionCount());
            ExecutionCleanupService.CleanupResult result = new TransactionTemplate(transactionManager)
                    .execute(status -> service.cleanup());
            assertNotNull(result);
            assertEquals(240L, result.deletedCount());
            assertEquals(240, committed.get());
            assertEquals(0L, service.preview().executionCount());
            assertEquals(1L, executions.selectCount(null));
            assertEquals(historyFile, executions.selectById(1000L).getSnapshotFile());
            // 库行与文件一起消失；被引用的那份正文必须还在。
            for (Map.Entry<Long, String> entry : files.entrySet()) {
                assertFalse(store.isInFlight(String.valueOf(entry.getKey()), entry.getValue()));
                assertFalse(fileExists(dataDir, entry.getKey(), entry.getValue()),
                        "已结束且无引用的执行，其正文文件必须被回收: id=" + entry.getKey());
            }
            assertTrue(fileExists(dataDir, 1000L, historyFile), "仍有历史重发引用的正文必须保留");
        } finally {
            database.shutdown();
        }
    }

    /** 走存储端口发布一份真实正文文件，返回库内该存的权威文件标识。 */
    private static String publish(LocalFileCheckpointStore store, ObjectMapper mapper, long executionId)
            throws Exception {
        ExecutionCheckpointStore.CheckpointWriter writer = store.begin(Long.toString(executionId));
        try {
            mapper.writeValue(writer.stream(), Map.of("id", String.valueOf(executionId)));
            writer.publish();
            return writer.fileId();
        } finally {
            writer.complete();
        }
    }

    private static boolean fileExists(Path dataDir, long executionId, String fileId) {
        return java.nio.file.Files.isRegularFile(dataDir.resolve("checkpoints")
                .resolve(Long.toString(executionId)).resolve(fileId + ".json"));
    }
}
