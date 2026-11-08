package com.summit.dp.execution;

import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import org.springframework.transaction.support.TransactionTemplate;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.TokenUsageEntity;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.compact.ContextAttachmentProvider;
import com.summit.core.runtime.loop.ContextUsageReporter;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.tool.ToolExecuteCommand;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecutionManager;
import com.summit.core.tool.ToolRegistry;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.execution.application.service.ExecutionCheckpointService;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.execution.infrastructure.checkpoint.LocalFileCheckpointStore;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.shared.persistence.MyBatisTypeHandlers;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.workflow.application.decision.ToolCallReadinessService;
import com.summit.dp.workflow.application.input.InputWakeupService;
import com.summit.dp.workflow.application.projection.ChatTurnLifecycleProjector;
import com.summit.dp.workflow.application.projection.SessionContextUsageProjector;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.harness.LocalExecutionRepository;
import com.summit.dp.workflow.infrastructure.lifecycle.SubExecutionLifecycle;
import com.summit.runtime.agent.AgentConfig;
import com.summit.runtime.context.RuntimeContext;
import com.summit.runtime.conversation.DefaultConversationManager;
import com.summit.runtime.conversation.DefaultTokenizer;
import com.summit.runtime.loop.BoundaryChecker;
import com.summit.runtime.loop.DefaultExecutionController;
import com.summit.runtime.loop.DefaultLoopInterceptor;
import com.summit.runtime.loop.DefaultLoopInterceptorProcessor;
import com.summit.runtime.loop.DefaultRuntimeLifeStyleManager;
import com.summit.runtime.loop.RuntimeProcessorTemplate;
import com.summit.runtime.model.DefaultChatModelInvoker;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.*;


@SpringJUnitConfig(ConcurrentCheckpointSaveTransactionTest.Config.class)
class ConcurrentCheckpointSaveTransactionTest {

    private static final long SESSION_ID = 500L;
    private static final long FIRST_ID = 9000000000000001L;
    private static final long SECOND_ID = 9000000000000002L;

    @Autowired private ExecutionRepository repository;
    @Autowired private LocalExecutionRepository runtime;
    @Autowired private LocalFileCheckpointStore checkpointStore;
    @Autowired private ExecutionMapper executions;
    @Autowired private Path dataDir;

    @Autowired private H2TestDatabase database;
    @Autowired private PlatformTransactionManager transactionManager;

    @BeforeEach
    void setUp() {
        executions.delete(null);
    }

    @Test
    void ordinaryModelRoundsDoNotIncreaseH2CheckpointWrites() {
        for (int rounds : List.of(1, 4)) {
            long id = rounds == 1 ? FIRST_ID : SECOND_ID;
            Execution source = execution(id, ExecutionState.CREATED);
            runtime.save(source);
            AtomicInteger calls = new AtomicInteger();
            RuntimeEventPublisher events = new RuntimeEventPublisher(List.of());
            DefaultRuntimeLifeStyleManager lifecycle = new DefaultRuntimeLifeStyleManager(events);
            DefaultTokenizer tokenizer = new DefaultTokenizer();
            DefaultConversationManager conversations = new DefaultConversationManager(ContextAttachmentProvider.NONE);
            ToolExecutionManager tools = new ToolExecutionManager() {
                public List<ToolExecuteResult> execute(ToolExecuteCommand command) {
                    return List.of(ToolExecuteResult.success("读取完成"));
                }
                public ToolRegistry toolRegistry() { return new ToolRegistry(List.of()); }
            };
            new RuntimeProcessorTemplate(RuntimeContext.builder().conversationManager(conversations)
                    .executionRepository(runtime)
                    .executionControl(new DefaultExecutionController(() -> null, runtime, events, lifecycle))
                    .runtimeLifeStyleManager(lifecycle).runtimeEventPublisher(events)
                    .loopInterceptorProcessor(new DefaultLoopInterceptorProcessor(List.of(new DefaultLoopInterceptor())))
                    .runtimeBoundaryChecker(new BoundaryChecker(AgentConfig.builder().maxIterations(5).build(),
                            tokenizer, conversations, null, null))
                    .toolExecutionManager(tools)
                    .invoker(new DefaultChatModelInvoker(request -> ChatResponseEntity.builder()
                            .aiMessageEntity(AiMessageEntity.builder().text("执行结果")
                                    .toolCalls(calls.incrementAndGet() < rounds
                                            ? List.of(new ToolCallRequest("read", ToolCatalog.READ_FILE, 0, "{}"))
                                            : List.of()).build())
                            .tokenUsage(TokenUsageEntity.of(3, 2, 1)).build()))
                    .usage(new ContextUsageReporter(tokenizer, 100_000, events, 1)).build()).execute(source);

            Execution restored = runtime.findById(source.getId()).orElseThrow();
            assertEquals(ExecutionState.COMPLETED, restored.getExecutionState());
            assertEquals(rounds, restored.getMessages().stream().filter(AiMessageEntity.class::isInstance).count());
            assertEquals(rounds * 3, restored.getTokenUsage().getTotalTokens());
        }

        assertEquals(executions.selectById(FIRST_ID).getVersion(), executions.selectById(SECOND_ID).getVersion(),
                "普通轮次增加时不应增加 H2 检查点更新，最终上下文仍须完整保存");
    }

    @Test
    void interruptedCancellationCommitsToH2AndReleasesTheControlSlot() {
        Execution source = execution(FIRST_ID, ExecutionState.CREATED);
        runtime.save(source);
        ExecutionControlSignal signal = runtime.register(source.getId());
        source.startChecked();
        runtime.save(source);
        runtime.requireCancel(source.getId());
        source.cancelChecked();

        Thread.currentThread().interrupt();
        try {
            assertDoesNotThrow(() -> runtime.save(source));
            assertDoesNotThrow(() -> runtime.unregister(signal));
            assertTrue(Thread.currentThread().isInterrupted(), "收尾不能吞掉停止信号");
        } finally {
            Thread.interrupted();
        }

        assertFalse(runtime.isActive(source.getId()));
        assertEquals(ExecutionState.CANCELLED, runtime.findById(source.getId()).orElseThrow().getExecutionState());
        assertNotNull(executions.selectById(FIRST_ID).getCompletedAt());
    }


    @Test
    void sameRowLockTimeoutRetriesWholeSaveAndKeepsCheckpointConsistent() throws Exception {
        runtime.save(execution(FIRST_ID, ExecutionState.CREATED));
        String original = executions.selectById(FIRST_ID).getSnapshotFile();
        database.execute("SET DEFAULT_LOCK_TIMEOUT 100");
        CountDownLatch locked = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch committed = new CountDownLatch(1);
        AtomicInteger reads = new AtomicInteger();
        doAnswer(invocation -> {
            if (reads.incrementAndGet() == 2) {
                release.countDown();
                await(committed);
            }
            return invocation.callRealMethod();
        }).when(repository).findCheckpointSummary(FIRST_ID);

        try (ExecutorService pool = Executors.newSingleThreadExecutor()) {
            Future<?> holder = pool.submit(() -> {
                new TransactionTemplate(transactionManager).executeWithoutResult(status -> {
                    executions.update(null, new LambdaUpdateWrapper<ExecutionPO>()
                            .eq(ExecutionPO::getId, FIRST_ID).set(ExecutionPO::getStatus, 1));
                    locked.countDown();
                    await(release);
                });
                committed.countDown();
            });
            try {
                assertTrue(locked.await(15, TimeUnit.SECONDS));
                runtime.save(execution(FIRST_ID, ExecutionState.SUSPENDED));
            } finally {
                release.countDown();
            }
            holder.get(15, TimeUnit.SECONDS);
        } finally {
            database.execute("SET DEFAULT_LOCK_TIMEOUT 2000");
        }
        assertEquals(2, reads.get(), "真实锁超时后必须在新事务里重新读取摘要");
        ExecutionPO saved = executions.selectById(FIRST_ID);
        assertEquals(2L, saved.getVersion());
        assertNotEquals(original, saved.getSnapshotFile());
        assertFalse(Files.exists(checkpointFile(FIRST_ID, original)));
        assertTrue(Files.isRegularFile(checkpointFile(FIRST_ID, saved.getSnapshotFile())));
        assertEquals(ExecutionState.SUSPENDED, runtime.findById(Long.toString(FIRST_ID))
                .orElseThrow().getExecutionState());
    }

    @Test
    void concurrentSavesOnDifferentExecutionsCommitWithoutLockConflict() throws Exception {
        runtime.save(execution(FIRST_ID, ExecutionState.CREATED));
        runtime.save(execution(SECOND_ID, ExecutionState.CREATED));
        String firstOriginalFile = executions.selectById(FIRST_ID).getSnapshotFile();
        String secondOriginalFile = executions.selectById(SECOND_ID).getSnapshotFile();
        assertEquals(1L, executions.selectById(FIRST_ID).getVersion());
        assertEquals(1L, executions.selectById(SECOND_ID).getVersion());

        CountDownLatch secondReadStaleSnapshot = new CountDownLatch(1);
        CountDownLatch firstCommitted = new CountDownLatch(1);
        AtomicInteger secondReads = new AtomicInteger();

        doAnswer(invocation -> {
            Object result = invocation.callRealMethod();
            if (invocation.<Long>getArgument(0) == SECOND_ID && secondReads.incrementAndGet() == 1) {
                secondReadStaleSnapshot.countDown();
                await(firstCommitted);
            }
            return result;
        }).when(repository).findCheckpointSummary(anyLong());

        try (ExecutorService pool = Executors.newSingleThreadExecutor()) {
            Future<?> second = pool.submit(() -> runtime.save(execution(SECOND_ID, ExecutionState.SUSPENDED)));
            assertTrue(secondReadStaleSnapshot.await(15, TimeUnit.SECONDS), "B 必须先在旧快照上读到摘要");

            runtime.save(execution(FIRST_ID, ExecutionState.COMPLETED));
            firstCommitted.countDown();
            second.get(30, TimeUnit.SECONDS);
        }

        assertEquals(1, secondReads.get(), "H2 不同行写入不应因旧读取被迫重试");
        assertEquals(2L, executions.selectById(FIRST_ID).getVersion(), "A 的版本必须前进到 2");
        assertEquals(2L, executions.selectById(SECOND_ID).getVersion(), "B 的版本必须前进到 2");
        String firstFile = executions.selectById(FIRST_ID).getSnapshotFile();
        String secondFile = executions.selectById(SECOND_ID).getSnapshotFile();
        assertNotEquals(firstOriginalFile, firstFile, "本次保存必须发布新文件");
        assertNotEquals(secondOriginalFile, secondFile, "本次保存必须发布新文件");

        assertTrue(Files.notExists(checkpointFile(FIRST_ID, firstOriginalFile)), "A 的旧正文应在提交后删除");
        assertTrue(Files.notExists(checkpointFile(SECOND_ID, secondOriginalFile)), "B 的旧正文应在提交后删除");

        assertTrue(Files.isRegularFile(checkpointFile(FIRST_ID, firstFile)));
        assertTrue(Files.isRegularFile(checkpointFile(SECOND_ID, secondFile)));
        assertNotNull(runtime.findById(Long.toString(SECOND_ID)).orElse(null), "保存后必须还能按引用读出正文");
        assertEquals(ExecutionState.SUSPENDED, runtime.findById(Long.toString(SECOND_ID)).orElseThrow()
                .getExecutionState(), "重试成功后落库的必须是最新状态");
    }


    @Test
    void repeatedSavesKeepAdvancingVersionAndReclaimPreviousFile() throws Exception {
        runtime.save(execution(FIRST_ID, ExecutionState.CREATED));
        String previous = executions.selectById(FIRST_ID).getSnapshotFile();
        for (int expectedVersion = 2; expectedVersion <= 4; expectedVersion++) {
            runtime.save(execution(FIRST_ID, expectedVersion % 2 == 0
                    ? ExecutionState.SUSPENDED : ExecutionState.RUNNING));
            assertEquals((long) expectedVersion, executions.selectById(FIRST_ID).getVersion());
            String current = executions.selectById(FIRST_ID).getSnapshotFile();
            assertTrue(Files.isRegularFile(checkpointFile(FIRST_ID, current)));
            assertTrue(Files.notExists(checkpointFile(FIRST_ID, previous)), "上一份正文必须被回收");
            previous = current;
        }
    }

    private Path checkpointFile(long executionId, String fileId) {
        return dataDir.resolve("checkpoints").resolve(Long.toString(executionId)).resolve(fileId + ".json");
    }

    private static Execution execution(long executionId, ExecutionState state) {
        List<Message> messages = List.of(UserMessageEntity.from("并发保存用例"));
        AgentRequest request = AgentRequest.builder()
                .executionId(Long.toString(executionId))
                .messages(messages)
                .runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(Map.of(com.summit.dp.execution.ExecutionAttributes.SESSION_ID,
                                Long.toString(SESSION_ID)))
                        .build())
                .build();
        return Execution.builder()
                .id(Long.toString(executionId))
                .executionState(state)
                .agentRequest(request)
                .messages(messages)
                .build();
    }

    private static void await(CountDownLatch latch) {
        try {
            if (!latch.await(30, TimeUnit.SECONDS)) {
                throw new IllegalStateException("等待 A 提交超时");
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("等待被中断", interrupted);
        }
    }

    @Configuration
    static class Config {
        @Bean
        InputWakeupService inputWakeups() { return mock(InputWakeupService.class); }

        @Bean
        SessionExecutionRegistry executionRegistry() { return new SessionExecutionRegistry(); }

        @Bean(destroyMethod = "shutdown")
        H2TestDatabase database() {
            return H2TestDatabase.create("ConcurrentCheckpointSaveTransactionTest");
        }

        @Bean
        PlatformTransactionManager transactionManager(H2TestDatabase database) {
            return new DataSourceTransactionManager(database);
        }

        @Bean
        Path checkpointDataDir() {
            return ExecutionRepositoryTestFactory.tempDataDir();
        }

        @Bean
        ObjectMapper objectMapper() {
            return new JsonConfig().objectMapper();
        }

        @Bean
        SqlSessionTemplate sql(H2TestDatabase database) throws Exception {
            MybatisConfiguration configuration = new MybatisConfiguration();
            configuration.setMapUnderscoreToCamelCase(true);
            MyBatisTypeHandlers.registerAll(configuration);
            configuration.addMapper(ExecutionMapper.class);
            MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
            factory.setDataSource(database);
            factory.setConfiguration(configuration);
            return H2TestDatabase.sqlSession(factory.getObject());
        }

        @Bean
        ExecutionRepository executionRepository(SqlSessionTemplate sql) {

            return spy(new ExecutionRepositoryImpl(executionMapper(sql)));
        }

        @Bean
        ExecutionMapper executionMapper(SqlSessionTemplate sql) {
            return sql.getMapper(ExecutionMapper.class);
        }

        @Bean
        LocalFileCheckpointStore checkpointStore(Path checkpointDataDir, ObjectMapper objectMapper) {
            return new LocalFileCheckpointStore(checkpointDataDir.toString(), objectMapper, 0L);
        }

        @Bean
        ExecutionCheckpointService checkpointService(ExecutionRepository executionRepository) {
            return new ExecutionCheckpointService(executionRepository, mock(org.springframework.context.ApplicationEventPublisher.class));
        }

        @Bean
        LocalExecutionRepository runtime(ExecutionCheckpointService checkpointService, ObjectMapper objectMapper,
                                         LocalFileCheckpointStore checkpointStore) {

            return new LocalExecutionRepository(checkpointService, objectMapper, checkpointStore,
                    ExecutionRepositoryTestFactory.projectionProvider(), ExecutionRepositoryTestFactory.mailReceipts());
        }

        @SuppressWarnings("unchecked")
        private static <T> ObjectProvider<T> provider(T service) {
            ObjectProvider<T> provider = mock(ObjectProvider.class);
            when(provider.getObject()).thenReturn(service);
            return provider;
        }
    }
}
