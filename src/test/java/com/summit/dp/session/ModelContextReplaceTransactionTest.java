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
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.repo.SessionContextRepository;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionContextMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionContextPO;
import com.summit.dp.session.infrastructure.persistence.repository.SessionContextRepositoryImpl;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.workflow.application.approval.ToolCallReadinessService;
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
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

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
    @Autowired private ExecutionMapper executions;

    @BeforeEach
    void cleanDatabase() {
        contexts.delete(null);
        executions.delete(null);
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
        List<Message> restored = service.find(sessionId).orElseThrow();
        assertEquals(1, restored.size(), "上下文只应剩最后一次写入的那一条: sessionId=" + sessionId);
        String content = contexts.selectById(sessionId).getContent();
        assertTrue(content != null && content.contains(expectedText),
                "库内正文必须包含最后一次写入的内容: sessionId=" + sessionId);
        assertEquals(1, countOccurrences(content, expectedText),
                "正文只能是最后一次写入的一份，不能拼接或重复: sessionId=" + sessionId);
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

    private static int countOccurrences(String content, String needle) {
        if (content == null || needle.isEmpty()) {
            return 0;
        }
        int count = 0;
        int index = content.indexOf(needle);
        while (index >= 0) {
            count++;
            index = content.indexOf(needle, index + needle.length());
        }
        return count;
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
        ModelContextService modelContextService(ObjectMapper objectMapper, SessionContextRepository repository) {

            return new ModelContextService(objectMapper, repository);
        }

        @Bean
        Path checkpointDataDir() {
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
