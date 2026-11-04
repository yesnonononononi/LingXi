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
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.shared.utils.TestTimeouts;
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

/**
 * 大快照在真实文件库上的回收：每条快照单独提交，引用保护与回滚开销都要成立。
 *
 * <p><b>时间口径（重要）：</b>本类原来挂 {@code @Timeout(60)}，本意是防挂死，实际上兼职成了
 * 「清理必须在 60 秒内跑完」的性能断言 —— 于是同一份 diff 的 CI 前一次用 30.16s 绿、后一次
 * 60.05s 红（runner 慢了 1.32×，DB 重的类慢到 1.96×，细节见 {@link TestTimeouts} 类头部）。
 * 现在闸门只剩 {@code TestTimeouts.HANG_GUARD}（防挂死，放宽到机器速度无关）；
 * 「清理/写入是否退化成 O(n²)」这条<b>能力没有丢</b>，改用循环内的<b>自校准相对增长守卫</b>来守：
 * 容器快慢只等比放大前后两段的耗时，比值不变，所以不会再随机红。</p>
 */
class ExecutionCleanupFileStorageTest {

    /** 逐条写入的历史行数（沿用原用例规模，不得下调）。 */
    private static final int TOTAL_ROWS = 240;

    /** 四分位窗口行数：前 1/4 与后 1/4 各 60 行，用来对比「早期写入」与「晚期写入」的单次开销。 */
    private static final int QUARTILE_ROWS = TOTAL_ROWS / 4;

    /**
     * 增长容许倍数：后 1/4 的典型单次耗时 ≤ 前 1/4 的 3 倍。
     *
     * <p>定标理由：正常实现里每次插入都是「发布一份正文文件 + 一条 INSERT」，开销与<b>已插行数</b>
     * 无关，实测比值接近 1（含 JIT 预热的运行里早期反而更慢，比值 &lt; 1）。留到 3 倍是为了吸收
     * H2 页分裂、GC 抖动、文件系统抖动这类与行数无关的噪声；而真正的 O(n²)（每条插入要扫一遍
     * 已插行 / 索引退化成线性扫描）会让单次开销随行数<b>线性</b>上升：前 1/4 中位数的样本约在第
     * 30 行、后 1/4 约在第 210 行，比值约 7 倍，稳过 3 倍闸门。</p>
     */
    private static final long GROWTH_ALLOWANCE = 3L;

    @Test
    @Timeout(TestTimeouts.HANG_GUARD)
    void cleanupKeepsReferencedHistoryAndCommitsPerExecution() throws Exception {
        H2TestDatabase database = H2TestDatabase.create("cleanup-file");
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
            SqlSessionTemplate sql = H2TestDatabase.sqlSession(factory.getObject());
            ExecutionMapper executions = sql.getMapper(ExecutionMapper.class);
            ObjectMapper mapper = new JsonConfig().objectMapper();
            LocalFileCheckpointStore store = new LocalFileCheckpointStore(dataDir.toString(), mapper);
            // 正文在文件里：每条历史行都指向自己那份真实文件，清理要连文件一起收掉。
            Map<Long, String> files = new java.util.HashMap<>();
            // 增长守卫采样：前 1/4 与后 1/4 各记一份逐次耗时，用来算相对增长（不引入绝对秒数）。
            long[] firstQuartileNanos = new long[QUARTILE_ROWS];
            long[] lastQuartileNanos = new long[QUARTILE_ROWS];
            for (long id = 1L; id <= TOTAL_ROWS; id++) {
                long startedAtNanos = System.nanoTime();
                String fileId = publish(store, mapper, id);
                files.put(id, fileId);
                ExecutionPO row = new ExecutionPO();
                row.setId(id);
                row.setVersion(1L);
                row.setSessionId(10L);
                row.setStatus(ExecutionStatusCodes.COMPLETED);
                row.setSnapshotFile(fileId);
                executions.insert(row);
                long elapsedNanos = System.nanoTime() - startedAtNanos;
                if (id <= QUARTILE_ROWS) {
                    firstQuartileNanos[(int) (id - 1L)] = elapsedNanos;
                } else if (id > TOTAL_ROWS - QUARTILE_ROWS) {
                    lastQuartileNanos[(int) (id - TOTAL_ROWS + QUARTILE_ROWS - 1L)] = elapsedNanos;
                }
            }
            // 自校准的相对增长守卫（替代原先兼职性能闸门的 @Timeout(60)）：
            // 后 1/4 的典型单次耗时相对前 1/4 的增长，超过 GROWTH_ALLOWANCE 倍就说明
            // 「逐条写入的开销随行数上升」= 整体退化成 O(n²)。机器快慢只等比放大两段，比值不变。
            long firstTypicalNanos = median(firstQuartileNanos);
            long lastTypicalNanos = median(lastQuartileNanos);
            assertTrue(firstTypicalNanos > 0L,
                    "增长守卫的采样必须取到非零耗时，否则这条守卫是假绿");
            assertTrue(lastTypicalNanos <= firstTypicalNanos * GROWTH_ALLOWANCE,
                    () -> "逐条写入的开销随行数增长过快（疑似 O(n^2)，即整体退化成平方级）：前 1/4 典型耗时 "
                            + nanosToMillis(firstTypicalNanos) + "ms，后 1/4 典型耗时 "
                            + nanosToMillis(lastTypicalNanos) + "ms，比值 "
                            + String.format("%.2f", (double) lastTypicalNanos / firstTypicalNanos)
                            + " 超过容许的 " + GROWTH_ALLOWANCE + " 倍");
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

            assertEquals(TOTAL_ROWS, service.preview().executionCount());
            ExecutionCleanupService.CleanupResult result = new TransactionTemplate(transactionManager)
                    .execute(status -> service.cleanup());
            assertNotNull(result);
            assertEquals(TOTAL_ROWS, result.deletedCount());
            assertEquals(TOTAL_ROWS, committed.get());
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

    /** 取样本中位数：单次 GC 停顿只会抬高个别样本，污染不了中位数，比总和稳得多。 */
    private static long median(long[] samples) {
        long[] sorted = samples.clone();
        java.util.Arrays.sort(sorted);
        return sorted[sorted.length / 2];
    }

    private static String nanosToMillis(long nanos) {
        return String.format("%.2f", nanos / 1_000_000d);
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
