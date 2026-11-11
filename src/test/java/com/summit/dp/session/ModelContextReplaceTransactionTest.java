package com.summit.dp.session;

import com.summit.dp.shared.utils.TestTimeouts;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
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
import com.summit.dp.execution.application.service.ExecutionCheckpointService;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.execution.infrastructure.checkpoint.LocalFileCheckpointStore;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.session.application.port.SessionContextStore;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.repo.SessionContextRepository;
import com.summit.dp.session.infrastructure.context.LocalSessionContextFileStore;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionContextMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionContextPO;
import com.summit.dp.session.infrastructure.persistence.repository.SessionContextRepositoryImpl;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.workflow.application.decision.ToolCallReadinessService;
import com.summit.dp.workflow.application.projection.ChatTurnLifecycleProjector;
import com.summit.dp.workflow.application.projection.SessionContextUsageProjector;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.harness.LocalExecutionRepository;
import com.summit.dp.workflow.infrastructure.lifecycle.SubExecutionLifecycle;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.mockito.stubbing.Answer;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.*;
import com.summit.core.agent.ContextSpec;


@SpringJUnitConfig(ModelContextReplaceTransactionTest.Config.class)
class ModelContextReplaceTransactionTest {


    private static final long SESSION_A = 700L;

    private static final long SESSION_B = 701L;

    private static final long SESSION_C = 702L;

    private static final long EXECUTION_ID = 9300000000000001L;

    @Autowired private ModelContextService service;
    @Autowired private SessionContextRepository repository;
    @Autowired private ExecutionRepository executionRepository;
    @Autowired private LocalExecutionRepository runtime;
    @Autowired private SessionContextMapper contexts;
    @Autowired private SessionContextStore store;
    @Autowired private ExecutionMapper executions;
    @Autowired private DataSourceTransactionManager transactionManager;

    @Autowired
    @Qualifier("contextDataDir")
    private Path contextDataDir;

    @BeforeEach
    void cleanDatabase() throws Exception {
        contexts.delete(null);
        executions.delete(null);
        // 正文文件不随库行一起消失，用例之间必须自己清干净，否则上一轮的文件会被当成本轮的孤儿。
        for (long sessionId : new long[]{SESSION_A, SESSION_B, SESSION_C}) {
            clearSessionFiles(sessionId);
        }
    }

    /**
     * 回滚一致性守卫：{@code replace} 会被包在外层事务里，回滚后库内引用必须还是旧正文，
     * 本次新写的文件必须被回收。
     *
     * <p>这条断言就是「文件名恒定」方案的翻红点：恒定文件名下磁盘内容已经是新的，
     * 库里引用却回滚回旧的，读到的是错的历史。</p>
     */
    @Test
    @Timeout(TestTimeouts.HANG_GUARD)
    void rolledBackReplaceKeepsTheOldBodyAndDropsTheNewFile() throws Exception {
        service.replace(SESSION_A, messages("旧上下文"));
        String oldBodyId = contexts.selectById(SESSION_A).getSnapshotFile();
        assertNotNull(oldBodyId);

        assertThrows(IllegalStateException.class, () -> new TransactionTemplate(transactionManager)
                .executeWithoutResult(status -> {
                    service.replace(SESSION_A, messages("会被回滚的上下文"));
                    throw new IllegalStateException("事务回滚");
                }));

        assertEquals(oldBodyId, contexts.selectById(SESSION_A).getSnapshotFile(), "回滚后引用必须还是旧正文");
        assertEquals("旧上下文", service.find(SESSION_A).orElseThrow().get(0).text(), "读到的必须仍是旧正文");
        assertEquals(1, bodyFileCount(SESSION_A), "回滚掉的那份新文件必须被删掉，不能留孤儿");
    }

    private void clearSessionFiles(long sessionId) throws Exception {
        Path directory = contextDataDir.resolve("session-context").resolve(Long.toString(sessionId));
        if (!Files.isDirectory(directory)) {
            return;
        }
        try (Stream<Path> files = Files.list(directory)) {
            for (Path file : files.toList()) {
                Files.deleteIfExists(file);
            }
        }
    }

    /**
     * 外层事务提交后回收旧文件：事务内的替换同样不能让旧正文留在盘上，
     * 否则每轮都攒一份再也读不到的正文。
     */
    @Test
    @Timeout(TestTimeouts.HANG_GUARD)
    void committedReplaceInsideOuterTransactionDeletesTheSupersededFile() throws Exception {
        service.replace(SESSION_B, messages("提交前上下文"));
        String oldBodyId = contexts.selectById(SESSION_B).getSnapshotFile();
        assertNotNull(oldBodyId);

        new TransactionTemplate(transactionManager).executeWithoutResult(status ->
                service.replace(SESSION_B, messages("提交后上下文")));

        String newBodyId = contexts.selectById(SESSION_B).getSnapshotFile();
        assertNotEquals(oldBodyId, newBodyId, "每次替换都是新正文标识");
        assertEquals("提交后上下文", service.find(SESSION_B).orElseThrow().get(0).text());
        assertFalse(Files.exists(contextDataDir.resolve("session-context")
                .resolve(Long.toString(SESSION_B)).resolve(oldBodyId + ".jsonl")), "提交后旧文件必须删除");
        assertEquals(1, bodyFileCount(SESSION_B), "任何时刻都只该留一份正文");
    }

    /** 会话目录里现存正文文件的份数：正常任何时候都只有一份。 */
    private long bodyFileCount(long sessionId) throws Exception {
        Path directory = contextDataDir.resolve("session-context").resolve(Long.toString(sessionId));
        if (!Files.isDirectory(directory)) {
            return 0L;
        }
        try (Stream<Path> files = Files.list(directory)) {
            return files.filter(path -> path.getFileName().toString().endsWith(".jsonl")).count();
        }
    }


    @Test
    @Timeout(TestTimeouts.HANG_GUARD)
    void independentSessionsCommitWithoutSnapshotConflict() throws Exception {
        service.replace(SESSION_A, messages("A 初始上下文"));
        service.replace(SESSION_B, messages("B 初始上下文"));
        assertEquals(1L, contexts.selectById(SESSION_A).getVersion());
        assertEquals(1L, contexts.selectById(SESSION_B).getVersion());

        CountDownLatch bHasReadStaleSnapshot = new CountDownLatch(1);
        CountDownLatch aHasCommitted = new CountDownLatch(1);
        AtomicInteger bSummaryReads = new AtomicInteger();

        doAnswer((Answer<Object>) invocation -> {
            Object result = invocation.callRealMethod();
            if (Long.valueOf(SESSION_B).equals(invocation.<Long>getArgument(0))
                    && "context-b".equals(Thread.currentThread().getName())
                    && bSummaryReads.incrementAndGet() == 1) {
                bHasReadStaleSnapshot.countDown();
                awaitQuietly(aHasCommitted, 30);
            }
            return result;
        }).when(repository).findSummary(anyLong());

        try (ExecutorService pool = Executors.newSingleThreadExecutor(runnable -> new Thread(runnable, "context-b"))) {
            Future<?> writerB = pool.submit(() -> {
                service.replace(SESSION_B, messages("B 最后一次写入"));
                return null;
            });
            assertTrue(bHasReadStaleSnapshot.await(30, TimeUnit.SECONDS), "B 必须先在旧快照上读到摘要");

            service.replace(SESSION_A, messages("A 最后一次写入"));
            aHasCommitted.countDown();
            writerB.get(60, TimeUnit.SECONDS);
        }

        assertEquals(1, bSummaryReads.get(), "H2 不同记录的写入不应触发快照冲突重试");
        assertEquals(2L, contexts.selectById(SESSION_A).getVersion(), "A 的版本必须前进到 2");
        assertEquals(2L, contexts.selectById(SESSION_B).getVersion(), "B 的版本必须前进到 2");

        assertContextContent(SESSION_A, "A 最后一次写入");
        assertContextContent(SESSION_B, "B 最后一次写入");
    }


    @Test
    @Timeout(TestTimeouts.HANG_GUARD)
    void contextReplaceAndCheckpointSaveInterleaveAndBothCommit() throws Exception {
        service.replace(SESSION_C, messages("C 初始上下文"));
        seedExecution(EXECUTION_ID);
        assertEquals(1L, executions.selectById(EXECUTION_ID).getVersion());

        CountDownLatch saveHasReadStaleSnapshot = new CountDownLatch(1);
        CountDownLatch replaceHasCommitted = new CountDownLatch(1);
        AtomicInteger saveSummaryReads = new AtomicInteger();

        doAnswer((Answer<Object>) invocation -> {
            Object result = invocation.callRealMethod();
            if ("checkpoint-saver".equals(Thread.currentThread().getName())
                    && saveSummaryReads.incrementAndGet() == 1) {
                saveHasReadStaleSnapshot.countDown();
                awaitQuietly(replaceHasCommitted, 30);
            }
            return result;
        }).when(executionRepository).findCheckpointSummary(anyLong());

        try (ExecutorService pool = Executors.newSingleThreadExecutor(
                runnable -> new Thread(runnable, "checkpoint-saver"))) {
            Future<?> saver = pool.submit(() -> {
                runtime.save(execution(EXECUTION_ID));
                return null;
            });
            assertTrue(saveHasReadStaleSnapshot.await(30, TimeUnit.SECONDS), "保存必须先读到旧快照");
            service.replace(SESSION_C, messages("C 最后一次写入"));
            replaceHasCommitted.countDown();
            saver.get(60, TimeUnit.SECONDS);
        }

        assertEquals(1, saveSummaryReads.get(), "H2 不同记录的写入不应触发快照冲突重试");
        assertEquals(2L, contexts.selectById(SESSION_C).getVersion(), "上下文版本必须前进到 2");
        assertContextContent(SESSION_C, "C 最后一次写入");
        assertEquals(2L, executions.selectById(EXECUTION_ID).getVersion(), "检查点版本必须前进到 2");
        assertNotNull(executions.selectById(EXECUTION_ID).getSnapshotFile(), "保存成功后必须指向新正文文件");
        assertNotNull(runtime.findById(Long.toString(EXECUTION_ID)).orElse(null), "保存后必须还能按引用读出正文");
    }


    @Test
    @Timeout(TestTimeouts.HANG_GUARD)
    void independentFirstWritesCommitWithoutSnapshotConflict() throws Exception {
        CountDownLatch insertHasReadStaleSnapshot = new CountDownLatch(1);
        CountDownLatch otherSessionCommitted = new CountDownLatch(1);
        AtomicInteger summaryReads = new AtomicInteger();
        doAnswer((Answer<Object>) invocation -> {
            Object result = invocation.callRealMethod();
            if (Long.valueOf(SESSION_B).equals(invocation.<Long>getArgument(0))
                    && summaryReads.incrementAndGet() == 1) {
                insertHasReadStaleSnapshot.countDown();
                awaitQuietly(otherSessionCommitted, 30);
            }
            return result;
        }).when(repository).findSummary(anyLong());

        try (ExecutorService pool = Executors.newSingleThreadExecutor(runnable -> new Thread(runnable, "insert-b"))) {
            Future<?> firstWrite = pool.submit(() -> {
                service.replace(SESSION_B, messages("B 首写"));
                return null;
            });
            assertTrue(insertHasReadStaleSnapshot.await(30, TimeUnit.SECONDS), "首写必须先读到空的摘要行");

            service.replace(SESSION_A, messages("A 首写"));
            otherSessionCommitted.countDown();
            firstWrite.get(60, TimeUnit.SECONDS);
        }

        assertEquals(1, summaryReads.get(), "H2 不同记录的写入不应触发快照冲突重试");
        SessionContextPO row = contexts.selectById(SESSION_B);
        assertNotNull(row, "重试成功后必须落库一行");

        assertEquals(1L, row.getVersion(), "首写落库的版本必须是 1");
        assertContextContent(SESSION_B, "B 首写");
    }


    private void assertContextContent(long sessionId, String expectedText) {
        SessionContextPO row = contexts.selectById(sessionId);
        assertNull(row.getContent(), "正文必须搬出库，库里不得再留 CLOB: sessionId=" + sessionId);
        assertNotNull(row.getSnapshotFile(), "库内必须留下正文标识: sessionId=" + sessionId);

        List<Message> restored = service.find(sessionId).orElseThrow();
        assertEquals(1, restored.size(), "上下文只应剩最后一次写入的那一条: sessionId=" + sessionId);
        assertEquals(expectedText, restored.get(0).text());

        // 正文文件里也只能有一份：写入是整笔替换，不是追加。
        List<Message> onDisk = store.read(sessionId, row.getSnapshotFile());
        assertEquals(1, onDisk.size(), "正文文件只能有最后一次写入的一份，不能追加: sessionId=" + sessionId);
        assertEquals(expectedText, onDisk.get(0).text());
    }

    private void seedExecution(long id) {
        ExecutionPO row = new ExecutionPO();
        row.setId(id);
        row.setSessionId(SESSION_C);
        row.setVersion(1L);
        row.setStatus(com.summit.dp.execution.ExecutionStatusCodes.SUSPENDED);
        executions.insert(row);
    }

    private static Execution execution(long id) {
        List<Message> history = new ArrayList<>(List.of(UserMessageEntity.from("并发保存用例正文")));
        AgentRequest request = AgentRequest.builder()
                .executionId(Long.toString(id))
                .contextSpec(ContextSpec.builder().context(new ArrayList<>(history)).build())
                .runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(Map.of(ExecutionAttributes.SESSION_ID, Long.toString(SESSION_C)))
                        .build())
                .build();
        return Execution.builder()
                .id(Long.toString(id))
                .agentId("chatAgent")
                .agentRequest(request)
                .executionState(ExecutionState.SUSPENDED)
                .messages(history)
                .build();
    }

    private static List<Message> messages(String text) {
        return List.of(UserMessageEntity.from(text));
    }

    private static void awaitQuietly(CountDownLatch latch, int seconds) {
        try {
            if (!latch.await(seconds, TimeUnit.SECONDS)) {
                throw new IllegalStateException("等待对端提交超时");
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("等待被中断", interrupted);
        }
    }


    @Configuration
    static class Config {
        @Bean
        SessionExecutionRegistry executionRegistry() { return new SessionExecutionRegistry(); }


        @Bean(destroyMethod = "shutdown")
        H2TestDatabase database() {
            return H2TestDatabase.create("ModelContextReplaceTransactionTest");
        }


        @Bean
        PlatformTransactionManager transactionManager(H2TestDatabase database) {
            return new DataSourceTransactionManager(database);
        }

        @Bean
        ObjectMapper objectMapper() {
            return new JsonConfig().objectMapper();
        }

        @Bean
        SqlSessionTemplate sql(H2TestDatabase database) {
            return H2TestDatabase.sqlSession(
                    database.sessionFactory(SessionContextMapper.class, ExecutionMapper.class));
        }

        @Bean
        SessionContextMapper sessionContextMapper(SqlSessionTemplate sql) {
            return sql.getMapper(SessionContextMapper.class);
        }

        @Bean
        ExecutionMapper executionMapper(SqlSessionTemplate sql) {
            return sql.getMapper(ExecutionMapper.class);
        }

        @Bean
        SessionContextRepository sessionContextRepository(SessionContextMapper sessionContextMapper) {

            return spy(new SessionContextRepositoryImpl(sessionContextMapper));
        }

        @Bean
        SessionContextStore sessionContextStore(Path contextDataDir, ObjectMapper objectMapper) {
            return new LocalSessionContextFileStore(contextDataDir.toString(), objectMapper);
        }

        @Bean
        ModelContextService modelContextService(SessionContextRepository repository, SessionContextStore store) {
            return new ModelContextService(repository, store);
        }

        @Bean
        Path checkpointDataDir() {
            return ExecutionRepositoryTestFactory.tempDataDir();
        }

        /** 上下文正文与检查点各用各的目录：两者都按数据目录布局，混用会让用例互相干扰。 */
        @Bean
        Path contextDataDir() {
            return ExecutionRepositoryTestFactory.tempDataDir();
        }

        @Bean
        LocalFileCheckpointStore checkpointStore(Path checkpointDataDir, ObjectMapper objectMapper) {
            return new LocalFileCheckpointStore(checkpointDataDir.toString(), objectMapper);
        }

        @Bean
        ExecutionRepository executionRepository(ExecutionMapper executionMapper) {

            return spy(new ExecutionRepositoryImpl(executionMapper));
        }

        @Bean
        ExecutionCheckpointService checkpointService(ExecutionRepository executionRepository) {
            return new ExecutionCheckpointService(executionRepository, mock(ApplicationEventPublisher.class));
        }

        @Bean
        LocalExecutionRepository runtime(ExecutionCheckpointService checkpointService, ObjectMapper objectMapper,
                                        LocalFileCheckpointStore checkpointStore) {

            return ExecutionRepositoryTestFactory.create(checkpointService, objectMapper, checkpointStore,
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
