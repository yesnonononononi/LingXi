package com.summit.dp.execution.qa;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionRepositoryTestFactory;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.application.service.ExecutionCheckpointService;
import com.summit.dp.execution.infrastructure.checkpoint.LocalFileCheckpointStore;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.shared.utils.TestTimeouts;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.workflow.application.decision.ToolCallReadinessService;
import com.summit.dp.workflow.application.projection.ChatTurnLifecycleProjector;
import com.summit.dp.workflow.application.projection.SessionContextUsageProjector;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.harness.LocalExecutionRepository;
import com.summit.dp.workflow.infrastructure.lifecycle.SubExecutionLifecycle;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.mockito.stubbing.Answer;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.*;


class ConcurrentSaveRetryProbeTest {

    private static final String EXECUTION_A = "920001";
    private static final String EXECUTION_B = "920002";

    @Test
    @Timeout(TestTimeouts.HANG_GUARD)
    void independentH2WritersBothCommitWithoutSnapshotRetry() throws Exception {
        H2TestDatabase database = H2TestDatabase.create("qa-save-retry");
        Path dataDir = Files.createTempDirectory("lingxi-qa-save-retry-");
        try {
            ObjectMapper mapper = new JsonConfig().objectMapper();
            ExecutionMapper executions = H2TestDatabase
                    .sqlSession(database.sessionFactory(ExecutionMapper.class))
                    .getMapper(ExecutionMapper.class);
            seed(executions, Long.parseLong(EXECUTION_A));
            seed(executions, Long.parseLong(EXECUTION_B));

            ExecutionRepositoryImpl realRepository = new ExecutionRepositoryImpl(executions);
            ExecutionRepositoryImpl spiedRepository = spy(realRepository);
            CountDownLatch bHasReadStaleRow = new CountDownLatch(1);
            CountDownLatch aHasCommitted = new CountDownLatch(1);
            AtomicBoolean bReadCount = new AtomicBoolean(false);
            AtomicBoolean bArmed = new AtomicBoolean(true);
            doAnswer((Answer<Object>) invocation -> {
                Object result = invocation.callRealMethod();
                // B 的第一次读：此时它的事务快照已经定型，放 A 去提交，再让 B 在同一事务里写。
                if ("probe-b".equals(Thread.currentThread().getName()) && bArmed.compareAndSet(true, false)) {
                    bReadCount.set(true);
                    bHasReadStaleRow.countDown();
                    awaitQuietly(aHasCommitted, 15);
                }
                return result;
            }).when(spiedRepository).findCheckpointSummary(anyLong());

            ExecutionCheckpointService checkpointService = new ExecutionCheckpointService(spiedRepository,
                    mock(ApplicationEventPublisher.class));
            LocalFileCheckpointStore store = new LocalFileCheckpointStore(dataDir.toString(), mapper);
            LocalExecutionRepository repository = new LocalExecutionRepository(checkpointService, mapper, store,
                    ExecutionRepositoryTestFactory.projectionProvider(), ExecutionRepositoryTestFactory.mailReceipts());
            // 与 Spring 注入的是同一个字段：只有它是真实事务管理器时，保存才会「自己拥有事务」并逐次重试。
            injectTransactionManager(repository, new DataSourceTransactionManager(database));

            Execution executionA = execution(EXECUTION_A, "A 的正文");
            Execution executionB = execution(EXECUTION_B, "B 的正文");
            try (ExecutorService poolA = Executors.newSingleThreadExecutor(runnable -> new Thread(runnable, "probe-a"));
                 ExecutorService poolB = Executors.newSingleThreadExecutor(runnable -> new Thread(runnable, "probe-b"))) {
                Future<?> writerA = poolA.submit(() -> {
                    assertTrue(bHasReadStaleRow.await(15, TimeUnit.SECONDS), "B 必须先读到旧快照");
                    repository.save(executionA);
                    aHasCommitted.countDown();
                    return null;
                });
                Future<?> writerB = poolB.submit(() -> {
                    repository.save(executionB);
                    return null;
                });
                writerA.get(60, TimeUnit.SECONDS);
                writerB.get(60, TimeUnit.SECONDS);
            }

            assertTrue(bReadCount.get(), "交错没有生效（B 没走到被拦截的那次读），用例失去意义");
            assertEquals(2L, executions.selectById(Long.parseLong(EXECUTION_A)).getVersion(),
                    "A 必须提交成功并推进一个版本");
            assertEquals(2L, executions.selectById(Long.parseLong(EXECUTION_B)).getVersion(),
                    "B 必须在 BUSY_SNAPSHOT 之后换新事务重放成功，而不是丢版本");
            for (String executionId : List.of(EXECUTION_A, EXECUTION_B)) {
                String fileId = executions.selectById(Long.parseLong(executionId)).getSnapshotFile();
                assertNotNull(fileId);
                Execution restored = store.read(executionId, fileId, Execution.class);
                assertEquals(1, restored.getMessages().size(), "库内引用的正文必须可读: id=" + executionId);
            }
            long readsOfB = org.mockito.Mockito.mockingDetails(spiedRepository).getInvocations().stream()
                    .filter(invocation -> "findCheckpointSummary".equals(invocation.getMethod().getName()))
                    .filter(invocation -> Long.valueOf(Long.parseLong(EXECUTION_B))
                            .equals(invocation.getArgument(0)))
                    .count();
            assertEquals(1L, readsOfB, "H2 不同行写入无需重试");
        } finally {
            database.shutdown();
            deleteQuietly(dataDir);
        }
    }


    @Test
    @Timeout(TestTimeouts.HANG_GUARD)
    void nonLockFailureIsNotRetried() throws Exception {
        H2TestDatabase database = H2TestDatabase.create("qa-save-noretry");
        Path dataDir = Files.createTempDirectory("lingxi-qa-save-noretry-");
        try {
            ObjectMapper mapper = new JsonConfig().objectMapper();
            ExecutionMapper executions = H2TestDatabase
                    .sqlSession(database.sessionFactory(ExecutionMapper.class))
                    .getMapper(ExecutionMapper.class);
            ExecutionRepositoryImpl spiedRepository = spy(new ExecutionRepositoryImpl(executions));
            LocalFileCheckpointStore store = new LocalFileCheckpointStore(dataDir.toString(), mapper);
            LocalExecutionRepository repository = new LocalExecutionRepository(
                    new ExecutionCheckpointService(spiedRepository, mock(ApplicationEventPublisher.class)),
                    mapper, store,
                    ExecutionRepositoryTestFactory.projectionProvider(), ExecutionRepositoryTestFactory.mailReceipts());
            injectTransactionManager(repository, new DataSourceTransactionManager(database));

            assertThrows(RuntimeException.class, () -> repository.save(execution("920009", "没有这一行")));
            long reads = org.mockito.Mockito.mockingDetails(spiedRepository).getInvocations().stream()
                    .filter(invocation -> "findCheckpointSummary".equals(invocation.getMethod().getName()))
                    .count();
            assertEquals(1L, reads, "业务失败不重试：摘要只允许读一次，实际=" + reads);
            // 整笔失败后本次新文件必须被删掉：目录里不能留下孤儿。
            Path directory = dataDir.resolve("checkpoints").resolve("920009");
            try (Stream<Path> paths = Files.list(directory)) {
                assertEquals(0L, paths.count(), "整笔保存失败后不许留下正文文件");
            }
        } finally {
            database.shutdown();
            deleteQuietly(dataDir);
        }
    }


    @Test
    @Timeout(TestTimeouts.HANG_GUARD)
    void callerTransactionPathJoinsTheCallerTransactionAndRollsBackAtomically() throws Exception {
        H2TestDatabase database = H2TestDatabase.create("qa-save-caller-tx");
        Path dataDir = Files.createTempDirectory("lingxi-qa-caller-tx-");
        try {
            ObjectMapper mapper = new JsonConfig().objectMapper();
            ExecutionMapper executions = H2TestDatabase
                    .sqlSession(database.sessionFactory(ExecutionMapper.class))
                    .getMapper(ExecutionMapper.class);
            long id = Long.parseLong(EXECUTION_A);
            seed(executions, id);
            ExecutionRepositoryImpl spiedRepository = spy(new ExecutionRepositoryImpl(executions));
            LocalFileCheckpointStore store = new LocalFileCheckpointStore(dataDir.toString(), mapper);
            LocalExecutionRepository repository = new LocalExecutionRepository(
                    new ExecutionCheckpointService(spiedRepository, mock(ApplicationEventPublisher.class)),
                    mapper, store,
                    ExecutionRepositoryTestFactory.projectionProvider(), ExecutionRepositoryTestFactory.mailReceipts());
            injectTransactionManager(repository, new DataSourceTransactionManager(database));

            Execution execution = execution(EXECUTION_A, "受理阶段正文");
            TransactionTemplate caller = new TransactionTemplate(new DataSourceTransactionManager(database));
            assertThrows(IllegalStateException.class, () -> caller.executeWithoutResult(status -> {
                repository.save(execution);
                throw new IllegalStateException("受理后续步骤失败，整笔回滚");
            }));

            ExecutionPO row = executions.selectById(id);
            assertEquals(1L, row.getVersion(), "调用方事务回滚后版本必须回到原值");
            assertEquals(null, row.getSnapshotFile(), "调用方事务回滚后不许留下指向不存在正文的引用");
            Path directory = dataDir.resolve("checkpoints").resolve(EXECUTION_A);
            try (Stream<Path> paths = Files.list(directory)) {
                assertEquals(0L, paths.count(), "回滚后本次发布的正文必须被清掉");
            }
            long reads = org.mockito.Mockito.mockingDetails(spiedRepository).getInvocations().stream()
                    .filter(invocation -> "findCheckpointSummary".equals(invocation.getMethod().getName()))
                    .count();
            assertEquals(1L, reads, "加入调用方事务的路径不重试，实际读次数=" + reads);
        } finally {
            database.shutdown();
            deleteQuietly(dataDir);
        }
    }

    private static void injectTransactionManager(LocalExecutionRepository repository,
                                                 DataSourceTransactionManager transactionManager) throws Exception {
        Field field = LocalExecutionRepository.class.getDeclaredField("transactionManager");
        field.setAccessible(true);
        field.set(repository, transactionManager);
    }

    private static void seed(ExecutionMapper executions, long id) {
        ExecutionPO row = new ExecutionPO();
        row.setId(id);
        row.setSessionId(10L);
        row.setVersion(1L);
        row.setStatus(ExecutionStatusCodes.SUSPENDED);
        executions.insert(row);
    }

    private static Execution execution(String executionId, String text) {
        List<Message> history = List.of(UserMessageEntity.from(text));
        AgentRequest request = AgentRequest.builder().executionId(executionId)
                .messages(new java.util.ArrayList<>(history))
                .runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(Map.of(ExecutionAttributes.SESSION_ID, "10")).build()).build();
        return Execution.builder().id(executionId).agentId("chatAgent").agentRequest(request)
                .executionState(ExecutionState.SUSPENDED).messages(new java.util.ArrayList<>(history)).build();
    }

    private static void awaitQuietly(CountDownLatch latch, int seconds) {
        try {
            latch.await(seconds, TimeUnit.SECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    private static void deleteQuietly(Path directory) {
        try (Stream<Path> paths = Files.walk(directory)) {
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
