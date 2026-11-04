package com.summit.dp.execution;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.execution.application.port.ExecutionCheckpointStore;
import com.summit.dp.execution.application.service.ExecutionReclaimService;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.infrastructure.checkpoint.LocalFileCheckpointStore;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.shared.utils.TestTimeouts;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.harness.LocalCheckpointMaintenance;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.spy;

/**
 * 清理入口的「先删库行、再删文件」顺序守卫。
 *
 * <p><b>为什么需要单独守</b>：库是唯一权威。若先删文件，一旦删行失败/回滚，库里就留下一条
 * 「指向不存在正文」的执行，恢复与历史重发会直接读空；反过来最坏只是垃圾文件，可由孤儿回收兜底。
 * 这个顺序用日志和注释都证明不了，只能靠变异：把文件删除挪到事务之前，这个用例必须变红。</p>
 */
class ReclaimFileOrderingTest {

    private static final long EXECUTION_ID = 100L;

    /** 删文件的那一刻，库行必须已经不在了（删除事务已提交）。 */
    @Test
    @Timeout(TestTimeouts.HANG_GUARD)
    void checkpointFileIsDeletedOnlyAfterTheRowDeletionIsCommitted() throws Exception {
        H2TestDatabase database = H2TestDatabase.create("reclaim-order");
        Path dataDir = ExecutionRepositoryTestFactory.tempDataDir();
        try {
            ExecutionMapper executions = H2TestDatabase
                    .sqlSession(database.sessionFactory(ExecutionMapper.class))
                    .getMapper(ExecutionMapper.class);
            ObjectMapper mapper = new JsonConfig().objectMapper();
            LocalFileCheckpointStore store = new LocalFileCheckpointStore(dataDir.toString(), mapper);
            String fileId = publish(store, mapper);
            insertRow(executions, fileId);

            ExecutionRepositoryImpl repository = new ExecutionRepositoryImpl(executions);
            List<String> violations = new ArrayList<>();
            LocalCheckpointMaintenance maintenance = new LocalCheckpointMaintenance(store, repository) {
                @Override
                public boolean deleteFile(String executionId, String fileIdToDelete) {
                    if (executions.selectById(Long.parseLong(executionId)) != null) {
                        violations.add("库行还在就把正文文件删了（顺序反了）: executionId=" + executionId);
                    }
                    return super.deleteFile(executionId, fileIdToDelete);
                }
            };
            ExecutionReclaimService reclaimer = new ExecutionReclaimService(repository, executionId -> false,
                    maintenance, new DataSourceTransactionManager(database));

            Execution candidate = repository.findCheckpointSummary(EXECUTION_ID).orElseThrow();
            assertTrue(reclaimer.reclaim(candidate), "已结束且无引用的执行必须被回收");

            assertTrue(violations.isEmpty(), () -> String.join("\n", violations));
            assertNull(executions.selectById(EXECUTION_ID));
            assertFalse(fileExists(dataDir, fileId), "提交后正文文件必须被回收");
        } finally {
            database.shutdown();
        }
    }

    /** 删行回滚时，库行与它的正文文件都必须完好 —— 这正是不许先删文件的理由。 */
    @Test
    @Timeout(TestTimeouts.HANG_GUARD)
    void rollbackKeepsBothTheRowAndItsCheckpointFile() throws Exception {
        H2TestDatabase database = H2TestDatabase.create("reclaim-order-rollback");
        Path dataDir = ExecutionRepositoryTestFactory.tempDataDir();
        try {
            ExecutionMapper executions = H2TestDatabase
                    .sqlSession(database.sessionFactory(ExecutionMapper.class))
                    .getMapper(ExecutionMapper.class);
            ObjectMapper mapper = new JsonConfig().objectMapper();
            LocalFileCheckpointStore store = new LocalFileCheckpointStore(dataDir.toString(), mapper);
            String fileId = publish(store, mapper);
            insertRow(executions, fileId);

            ExecutionRepositoryImpl repository = spy(new ExecutionRepositoryImpl(executions));
            doAnswer(invocation -> {
                invocation.callRealMethod();
                throw new IllegalStateException("模拟删除事务失败");
            }).when(repository).deleteReclaimable(anyLong(), anyLong());
            ExecutionReclaimService reclaimer = new ExecutionReclaimService(repository, executionId -> false,
                    new LocalCheckpointMaintenance(store, repository),
                    new DataSourceTransactionManager(database));

            Execution candidate = repository.findCheckpointSummary(EXECUTION_ID).orElseThrow();
            assertThrows(IllegalStateException.class, () -> reclaimer.reclaim(candidate));

            assertNotNull(executions.selectById(EXECUTION_ID), "删行回滚后库行必须还在");
            assertTrue(fileExists(dataDir, fileId), "删行回滚后正文文件必须还在，否则库内引用成了断链");
            assertEquals(fileId, executions.selectById(EXECUTION_ID).getSnapshotFile());
        } finally {
            database.shutdown();
        }
    }

    private static String publish(LocalFileCheckpointStore store, ObjectMapper mapper) throws Exception {
        ExecutionCheckpointStore.CheckpointWriter writer = store.begin(Long.toString(EXECUTION_ID));
        try {
            mapper.writeValue(writer.stream(), java.util.Map.of("id", Long.toString(EXECUTION_ID)));
            writer.publish();
            return writer.fileId();
        } finally {
            writer.complete();
        }
    }

    private static void insertRow(ExecutionMapper executions, String fileId) {
        ExecutionPO row = new ExecutionPO();
        row.setId(EXECUTION_ID);
        row.setSessionId(10L);
        row.setVersion(1L);
        row.setStatus(ExecutionStatusCodes.COMPLETED);
        row.setSnapshotFile(fileId);
        executions.insert(row);
    }

    private static boolean fileExists(Path dataDir, String fileId) {
        return Files.isRegularFile(dataDir.resolve("checkpoints")
                .resolve(Long.toString(EXECUTION_ID)).resolve(fileId + ".json"));
    }
}
