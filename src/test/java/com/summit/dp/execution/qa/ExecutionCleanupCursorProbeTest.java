package com.summit.dp.execution.qa;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.application.service.ExecutionCleanupService;
import com.summit.dp.execution.application.service.ExecutionReclaimService;
import com.summit.dp.execution.infrastructure.checkpoint.LocalFileCheckpointStore;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.shared.support.SqliteTestDatabase;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.harness.LocalCheckpointMaintenance;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 复核 R4 的独立后端探针：只剩孤儿文件时清理入口照样能跑，且跨调用能把文件扫干净。
 *
 * <p>与既有 {@code ExecutionCleanupTest} 的分工：那边断言预览标志位，这里直接数目录 ——
 * 「预览说还要扫描」不算证据，<b>真的第二轮把剩下的孤儿收掉</b>才算。第三条是观察项：
 * 只要还有受保护执行的检查点目录在，{@code filesNeedScan} 就恒为 true。</p>
 */
class ExecutionCleanupCursorProbeTest {

    /** 清理入口单次请求的执行目录预算；孤儿目录数要盖过它才能逼出第二轮。 */
    private static final int SINGLE_RUN_DIRECTORY_BUDGET = 400;

    @Test
    @Timeout(240)
    void orphanOnlyDirectoriesAreReclaimedAcrossTwoRunsWithoutAnyReclaimableRow() throws Exception {
        SqliteTestDatabase database = SqliteTestDatabase.create("qa-cursor-probe");
        Path dataDir = Files.createTempDirectory("lingxi-qa-cursor-");
        try {
            ExecutionMapper executions = SqliteTestDatabase
                    .sqlSession(database.sessionFactory(ExecutionMapper.class))
                    .getMapper(ExecutionMapper.class);
            ObjectMapper mapper = new JsonConfig().objectMapper();
            LocalFileCheckpointStore store = new LocalFileCheckpointStore(dataDir.toString(), mapper);
            ExecutionRepositoryImpl repository = new ExecutionRepositoryImpl(executions);
            LocalCheckpointMaintenance maintenance = new LocalCheckpointMaintenance(store, repository);
            ExecutionCleanupService service = new ExecutionCleanupService(repository,
                    new ExecutionReclaimService(repository, executionId -> false, maintenance,
                            new DataSourceTransactionManager(database)),
                    maintenance);

            int total = SINGLE_RUN_DIRECTORY_BUDGET + 1;
            for (int index = 0; index < total; index++) {
                Path directory = Files.createDirectories(dataDir.resolve("checkpoints")
                        .resolve(Integer.toString(700000 + index)));
                Files.writeString(directory.resolve("66666666666666666666666666666666.json"), "{\"orphan\":true}");
            }

            ExecutionCleanupService.Preview before = service.preview();
            assertEquals(0L, before.executionCount(), "没有任何可回收的数据库行");
            assertTrue(before.filesNeedScan(), "只剩孤儿文件时文件侧必须报告需扫描（否则按钮被禁）");

            service.cleanup();
            List<String> afterFirst = store.listExecutionIds(null, 500);
            assertEquals(total - SINGLE_RUN_DIRECTORY_BUDGET, afterFirst.size(),
                    "一轮只清掉本次目录预算内的孤儿，剩下的必须留着等第二轮");
            assertTrue(store.hasUnscannedFiles(), "还有孤儿目录时，界面必须还能再发起一轮");

            service.cleanup();
            assertTrue(store.listExecutionIds(null, 500).isEmpty(), "第二轮必须把剩下的孤儿目录收干净");
            assertFalse(service.preview().filesNeedScan(), "文件侧干净后才允许禁用按钮");
        } finally {
            database.shutdown();
            deleteQuietly(dataDir);
        }
    }

    /**
     * 观察项（不算缺陷，供产品/工程判断文案）：受保护执行的检查点目录永远算「需扫描」。
     *
     * <p>{@code hasUnscannedFiles} 只看有没有数字执行目录与 {@code .part}，不看引用；
     * 于是「历史里还有被保护的执行」时预览恒报文件侧需扫描，按钮一直可用，点下去是空转，
     * 界面文案「磁盘上还有检查点文件待扫描」在此时是误导的。</p>
     */
    @Test
    @Timeout(120)
    void protectedCheckpointDirectoryKeepsFilesNeedScanTrueEvenWithNothingToReclaim() throws Exception {
        SqliteTestDatabase database = SqliteTestDatabase.create("qa-cursor-protected");
        Path dataDir = Files.createTempDirectory("lingxi-qa-protected-");
        try {
            ExecutionMapper executions = SqliteTestDatabase
                    .sqlSession(database.sessionFactory(ExecutionMapper.class))
                    .getMapper(ExecutionMapper.class);
            ObjectMapper mapper = new JsonConfig().objectMapper();
            LocalFileCheckpointStore store = new LocalFileCheckpointStore(dataDir.toString(), mapper);
            ExecutionRepositoryImpl repository = new ExecutionRepositoryImpl(executions);
            LocalCheckpointMaintenance maintenance = new LocalCheckpointMaintenance(store, repository);
            ExecutionCleanupService service = new ExecutionCleanupService(repository,
                    new ExecutionReclaimService(repository, executionId -> false, maintenance,
                            new DataSourceTransactionManager(database)),
                    maintenance);

            String fileId = publish(store, mapper, 800001L);
            ExecutionPO row = new ExecutionPO();
            row.setId(800001L);
            row.setSessionId(10L);
            row.setVersion(1L);
            row.setStatus(ExecutionStatusCodes.SUSPENDED);
            row.setSnapshotFile(fileId);
            executions.insert(row);

            ExecutionCleanupService.Preview preview = service.preview();
            assertEquals(0L, preview.executionCount(), "挂起中的执行不可回收");
            assertTrue(preview.filesNeedScan(), "受保护执行的目录也算「需扫描」——这正是观察项");

            ExecutionCleanupService.CleanupResult result = service.cleanup();
            assertEquals(0L, result.deletedCount());
            assertTrue(service.preview().filesNeedScan(),
                    "受保护执行还在，filesNeedScan 就恒为 true：按钮会一直可用，点下去是空转");
            assertTrue(Files.isRegularFile(fileOf(dataDir, 800001L, fileId)), "受保护正文不能被删");
        } finally {
            database.shutdown();
            deleteQuietly(dataDir);
        }
    }

    private static String publish(LocalFileCheckpointStore store, ObjectMapper mapper, long executionId)
            throws Exception {
        var writer = store.begin(Long.toString(executionId));
        try {
            mapper.writeValue(writer.stream(), java.util.Map.of("id", Long.toString(executionId)));
            writer.publish();
            return writer.fileId();
        } finally {
            writer.complete();
        }
    }

    private static Path fileOf(Path dataDir, long executionId, String fileId) {
        return dataDir.resolve("checkpoints").resolve(Long.toString(executionId)).resolve(fileId + ".json");
    }

    private static void deleteQuietly(Path directory) {
        try (var paths = Files.walk(directory)) {
            paths.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                try {
                    Files.deleteIfExists(path);
                } catch (Exception ignored) {
                    // 系统临时目录兜底清理。
                }
            });
        } catch (Exception ignored) {
            // 同上。
        }
    }
}
