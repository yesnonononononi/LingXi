package com.summit.dp.execution;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.dp.execution.application.port.ExecutionActivity;
import com.summit.dp.execution.application.port.ExecutionCheckpointStore;
import com.summit.dp.execution.application.service.ExecutionCleanupService;
import com.summit.dp.execution.application.service.ExecutionReclaimService;
import com.summit.dp.execution.infrastructure.checkpoint.LocalFileCheckpointStore;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.shared.persistence.MyBatisTypeHandlers;
import com.summit.dp.shared.support.SqliteTestDatabase;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.harness.LocalCheckpointMaintenance;
import com.summit.dp.workflow.infrastructure.harness.LocalExecutionRepository;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.*;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 并发读取与清理：一边 {@code findById} 一边清理同一条执行，读到的东西必须完整。
 *
 * <p>清理会删掉「已结束且无引用」的执行的正文文件。若删除与读取没有按 {@code executionId} 互斥，
 * 就会出现「已查到引用、还没来得及打开文件，文件被删了」—— 表现为读抛异常或读到半截内容。
 * 这里把读取的窗口人为放大，再并发清理，把这条竞态变成可复现的断言。</p>
 */
class ConcurrentCheckpointReadAndReclaimTest {

    private static final int ROUNDS = 8;
    private static final String EXECUTION_ID = "305";

    @Test
    @Timeout(120)
    void readingStaysConsistentWhileCleanupReclaimsTheSameExecution() throws Exception {
        SqliteTestDatabase database = SqliteTestDatabase.create("concurrent-read-reclaim");
        Path dataDir = ExecutionRepositoryTestFactory.tempDataDir();
        ObjectMapper mapper = new JsonConfig().objectMapper();
        // 读取窗口放大 2ms：去掉互斥后这里几乎必然踩到「文件已被删」。
        LocalFileCheckpointStore store = new SlowReadCheckpointStore(dataDir.toString(), mapper, 2L);
        try {
            MybatisConfiguration configuration = new MybatisConfiguration();
            configuration.setMapUnderscoreToCamelCase(true);
            MyBatisTypeHandlers.registerAll(configuration);
            configuration.addMapper(ExecutionMapper.class);
            MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
            factory.setDataSource(database);
            factory.setConfiguration(configuration);
            SqlSessionTemplate sql = SqliteTestDatabase.sqlSession(factory.getObject());
            ExecutionMapper executions = sql.getMapper(ExecutionMapper.class);
            ExecutionRepositoryImpl repository = new ExecutionRepositoryImpl(executions);
            LocalCheckpointMaintenance maintenance = new LocalCheckpointMaintenance(store, repository);
            ExecutionActivity idle = executionId -> false;
            DataSourceTransactionManager transactionManager = new DataSourceTransactionManager(database);
            ExecutionReclaimService reclaimer = new ExecutionReclaimService(repository, idle,
                    maintenance, transactionManager);
            ExecutionCleanupService cleanup = new ExecutionCleanupService(repository, reclaimer, maintenance);
            LocalExecutionRepository runtime = ExecutionRepositoryTestFactory.create(executions, mapper, store);

            List<String> violations = new ArrayList<>();
            try (ExecutorService pool = Executors.newFixedThreadPool(2)) {
                for (int round = 0; round < ROUNDS; round++) {
                    String fileId = publish(store, mapper, execution());
                    ExecutionPO row = new ExecutionPO();
                    row.setId(Long.parseLong(EXECUTION_ID));
                    row.setSessionId(10L);
                    row.setVersion(1L);
                    row.setStatus(ExecutionStatusCodes.COMPLETED);
                    row.setSnapshotFile(fileId);
                    executions.insert(row);

                    CountDownLatch start = new CountDownLatch(1);
                    Future<?> reader = pool.submit(() -> readUntilReclaimed(runtime, start, violations));
                    Future<?> cleaner = pool.submit(() -> runCleanup(cleanup, start, violations));
                    start.countDown();
                    reader.get(30, TimeUnit.SECONDS);
                    cleaner.get(30, TimeUnit.SECONDS);
                    assertFalse(fileExists(dataDir, fileId), "清理后正文必须被回收");
                }
            }
            assertTrue(violations.isEmpty(), () -> String.join("\n", violations));
        } finally {
            database.shutdown();
        }
    }

    /** 反复读取，直到行被回收为止；任何一次读到半截内容或抛异常都记一条违规。 */
    private static void readUntilReclaimed(LocalExecutionRepository runtime, CountDownLatch start,
                                           List<String> violations) {
        try {
            start.await(10, TimeUnit.SECONDS);
            long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(400);
            while (System.nanoTime() < deadline) {
                Optional<Execution> restored = runtime.findById(EXECUTION_ID);
                if (restored.isEmpty()) {
                    continue;
                }
                Execution execution = restored.get();
                if (execution.getMessages() == null || execution.getMessages().size() != 2
                        || !"第一段".equals(execution.getMessages().getFirst().text())) {
                    violations.add("读到了不完整的检查点正文: " + execution.getMessages());
                }
            }
        } catch (RuntimeException failure) {
            violations.add("读取检查点时抛异常（典型的「文件被提前删掉」）: " + failure);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    private static void runCleanup(ExecutionCleanupService cleanup, CountDownLatch start, List<String> violations) {
        try {
            start.await(10, TimeUnit.SECONDS);
            cleanup.cleanup();
        } catch (RuntimeException failure) {
            violations.add("清理时抛异常: " + failure);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    private static Execution execution() {
        List<com.summit.core.conversation.message.Message> history =
                List.of(UserMessageEntity.from("第一段"), UserMessageEntity.from("第二段"));
        return Execution.builder().id(EXECUTION_ID).agentId("chatAgent")
                .agentRequest(AgentRequest.builder().executionId(EXECUTION_ID).messages(history).build())
                .executionState(ExecutionState.COMPLETED).messages(List.copyOf(history)).build();
    }

    private static String publish(LocalFileCheckpointStore store, ObjectMapper mapper, Execution execution) {
        ExecutionCheckpointStore.CheckpointWriter writer = store.begin(execution.getId());
        try {
            mapper.writeValue(writer.stream(), execution);
            writer.publish();
            return writer.fileId();
        } catch (java.io.IOException e) {
            throw new IllegalStateException("写入测试检查点失败", e);
        } finally {
            writer.complete();
        }
    }

    private static boolean fileExists(Path dataDir, String fileId) {
        return java.nio.file.Files.isRegularFile(dataDir.resolve("checkpoints")
                .resolve(EXECUTION_ID).resolve(fileId + ".json"));
    }

    /** 把「查引用 → 打开文件」的窗口放大，让竞态可复现。 */
    private static final class SlowReadCheckpointStore extends LocalFileCheckpointStore {

        private final long delayMillis;

        private SlowReadCheckpointStore(String dataDir, ObjectMapper mapper, long delayMillis) {
            super(dataDir, mapper, 0L);
            this.delayMillis = delayMillis;
        }

        @Override
        public <T> T read(String executionId, String fileId, Class<T> type) {
            try {
                Thread.sleep(delayMillis);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            return super.read(executionId, fileId, type);
        }
    }
}
