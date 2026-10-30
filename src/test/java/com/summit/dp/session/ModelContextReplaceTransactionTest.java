package com.summit.dp.session;

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
import com.summit.dp.shared.support.SqliteTestDatabase;
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
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.when;

/**
 * 复核 R6：会话上下文替换的「读摘要 → 写正文」在真实事务并发下会收到
 * {@code SQLITE_BUSY_SNAPSHOT}，必须整笔换新事务重试。
 *
 * <p><b>被守的缺陷</b>（真实事故证据：
 * {@code docs/qa/first-oom-desktop-pet-replay-2026-10-31.md} 的
 * 「新发现：上下文事务并发冲突，仍需修复」）：
 * {@code CannotAcquireLockException: SQLITE_BUSY_SNAPSHOT} at
 * {@code ModelContextService.replace(ModelContextService.java:55)}。</p>
 *
 * <p><b>为什么原实现必然失败</b>：SQLite 的事务在第一次读时固定快照。B 在自己的事务里
 * {@code findSummary} 之后，A 提交了写入，B 再写就立刻 {@code SQLITE_BUSY_SNAPSHOT}；
 * 在同一个已过期的读事务里重试 UPDATE（或 INSERT）永远不会成功，必须整笔丢弃、
 * 用全新事务重新读一遍。{@code busy_timeout} 对「读锁升写锁」不生效，扩容堆也不行。</p>
 *
 * <p><b>装配为什么必须走 Spring</b>：{@link ModelContextService} 的事务管理器是容器注入的字段，
 * {@code new} 出来的实例没有事务基础设施 —— 「new 服务并发通过」不能代表生产路径。
 * 这里用真实的 {@link DataSourceTransactionManager} bean + 真实 SQLite 文件库（WAL，
 * 与生产同参数）；只有「读摘要」这一处被 spy 拦住，用来插入确定性屏障。</p>
 */
@SpringJUnitConfig(ModelContextReplaceTransactionTest.Config.class)
class ModelContextReplaceTransactionTest {

    /** 会话 A：主线程在被守会话读到旧快照之后提交它。 */
    private static final long SESSION_A = 700L;
    /** 会话 B：先在旧快照上读摘要，随后写入，必须靠整笔重试成功。 */
    private static final long SESSION_B = 701L;
    /** 会话 C：与检查点保存混合并发时被替换上下文的一方。 */
    private static final long SESSION_C = 702L;
    /** 与上下文替换混合并发的执行。 */
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

    /**
     * 两个会话并发替换上下文：B 读到旧快照、A 先提交、B 再写 —— 两笔都必须提交成功。
     *
     * <p>去掉重试（把 {@code TransactionRetryTemplate.DEFAULT_MAX_ATTEMPTS} 改成 1）时，
     * B 会抛 {@code CannotAcquireLockException: SQLITE_BUSY_SNAPSHOT}，用例直接变红。</p>
     */
    @Test
    @Timeout(120)
    void concurrentReplacesOnTwoSessionsBothCommitThroughRetry() throws Exception {
        service.replace(SESSION_A, messages("A 初始上下文"));
        service.replace(SESSION_B, messages("B 初始上下文"));
        assertEquals(1L, contexts.selectById(SESSION_A).getVersion());
        assertEquals(1L, contexts.selectById(SESSION_B).getVersion());

        CountDownLatch bHasReadStaleSnapshot = new CountDownLatch(1);
        CountDownLatch aHasCommitted = new CountDownLatch(1);
        AtomicInteger bSummaryReads = new AtomicInteger();
        // 只在 B 的「第一次」摘要读取上做文章：真实方法先执行（快照就此定型），再卡住等 A 提交，
        // 之后 B 在同一事务里写必然撞 SQLITE_BUSY_SNAPSHOT。重试走第二次读取（不再卡住）。
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
            // A 在 B 占着旧快照时提交：这正是事故现场里 B 必然收到 BUSY_SNAPSHOT 的交错。
            service.replace(SESSION_A, messages("A 最后一次写入"));
            aHasCommitted.countDown();
            writerB.get(60, TimeUnit.SECONDS);
        }

        assertEquals(2, bSummaryReads.get(),
                "B 的第二次读取必须来自重试开出的新事务（去掉重试这里只会读到 1 次）");
        assertEquals(2L, contexts.selectById(SESSION_A).getVersion(), "A 的版本必须前进到 2");
        assertEquals(2L, contexts.selectById(SESSION_B).getVersion(), "B 的版本必须前进到 2");
        // 内容必须是「最后一次写入」——重试成功后落库的不能是旧入参或半截结果。
        assertContextContent(SESSION_A, "A 最后一次写入");
        assertContextContent(SESSION_B, "B 最后一次写入");
    }

    /**
     * 上下文替换与执行检查点保存混合并发：一方先读到旧快照，另一方提交后再写。
     *
     * <p>两个入口用的是同一个共享重试工具，所以这里同时守住「另一个入口不会以别的时序再复发」。</p>
     */
    @Test
    @Timeout(120)
    void contextReplaceAndCheckpointSaveInterleaveAndBothCommit() throws Exception {
        service.replace(SESSION_C, messages("C 初始上下文"));
        seedExecution(EXECUTION_ID);
        assertEquals(1L, executions.selectById(EXECUTION_ID).getVersion());

        CountDownLatch saveHasReadStaleSnapshot = new CountDownLatch(1);
        CountDownLatch replaceHasCommitted = new CountDownLatch(1);
        AtomicInteger saveSummaryReads = new AtomicInteger();
        // 保存线程读到旧快照后卡住，等上下文替换提交完再写 —— 保存必须靠整笔重试成功。
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

        assertEquals(2, saveSummaryReads.get(), "保存的第二次读取必须来自重试开出的新事务");
        assertEquals(2L, contexts.selectById(SESSION_C).getVersion(), "上下文版本必须前进到 2");
        assertContextContent(SESSION_C, "C 最后一次写入");
        assertEquals(2L, executions.selectById(EXECUTION_ID).getVersion(), "检查点版本必须前进到 2");
        assertNotNull(executions.selectById(EXECUTION_ID).getSnapshotFile(), "保存成功后必须指向新正文文件");
        assertNotNull(runtime.findById(Long.toString(EXECUTION_ID)).orElse(null), "保存后必须还能按引用读出正文");
    }

    /** 首次写入（库里还没有该会话的行）同样走整笔重试：INSERT 也会撞快照冲突。 */
    @Test
    @Timeout(120)
    void firstWriteInsertPathAlsoRetriesOnStaleSnapshot() throws Exception {
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
            // 另一会话在 B 的读快照之后提交，使 B 的快照过期。
            service.replace(SESSION_A, messages("A 首写"));
            otherSessionCommitted.countDown();
            firstWrite.get(60, TimeUnit.SECONDS);
        }

        assertEquals(2, summaryReads.get(), "首写路径也必须整笔重试（去掉重试这里只会读到 1 次）");
        SessionContextPO row = contexts.selectById(SESSION_B);
        assertNotNull(row, "重试成功后必须落库一行");
        // create 从 0 起、changeContent 自增 1：与 DDL 的 DEFAULT 1 语义对齐。
        assertEquals(1L, row.getVersion(), "首写落库的版本必须是 1");
        assertContextContent(SESSION_B, "B 首写");
    }

    /**
     * 断言某会话的上下文确实只剩最后一次写入的那一份。
     *
     * <p>消息对象来自框架、没有值语义，因此比对「落库正文」而不是比 {@code List<Message>} 相等：
     * 断言要看的是「写入结果是哪一份」，而不是 Java 对象身份。</p>
     */
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
                .messages(new ArrayList<>(history))
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

    /** 与生产一致的装配：真实文件库 + 真实事务管理器 bean + 被 spy 的仓储（仅插入屏障）。 */
    @Configuration
    static class Config {

        @Bean(destroyMethod = "shutdown")
        SqliteTestDatabase database() {
            return SqliteTestDatabase.create("ModelContextReplaceTransactionTest");
        }

        /** 生产 bean：Spring 装配的 {@link DataSourceTransactionManager}。 */
        @Bean
        PlatformTransactionManager transactionManager(SqliteTestDatabase database) {
            return new DataSourceTransactionManager(database);
        }

        @Bean
        ObjectMapper objectMapper() {
            return new JsonConfig().objectMapper();
        }

        @Bean
        SqlSessionTemplate sql(SqliteTestDatabase database) {
            return SqliteTestDatabase.sqlSession(
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
            // spy 只为在「读到旧快照之后」插入确定性屏障，不改任何行为。
            return spy(new SessionContextRepositoryImpl(sessionContextMapper));
        }

        @Bean
        ModelContextService modelContextService(ObjectMapper objectMapper, SessionContextRepository repository) {
            // 事务管理器由 Spring 注入到字段：这走的才是生产事务路径。
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
            // 同样只为插入屏障：保存路径的行为完全真实。
            return spy(new ExecutionRepositoryImpl(executionMapper));
        }

        @Bean
        ExecutionCheckpointService checkpointService(ExecutionRepository executionRepository) {
            return new ExecutionCheckpointService(executionRepository, mock(ApplicationEventPublisher.class));
        }

        @Bean
        LocalExecutionRepository runtime(ExecutionCheckpointService checkpointService, ObjectMapper objectMapper,
                                        LocalFileCheckpointStore checkpointStore) {
            // 事务管理器同样由 Spring 注入字段，与生产一致。
            return new LocalExecutionRepository(checkpointService, objectMapper, checkpointStore,
                    provider(mock(ToolCallReadinessService.class)),
                    provider(mock(ToolCallService.class)),
                    provider(mock(SubExecutionLifecycle.class)),
                    provider(mock(SessionContextUsageProjector.class)),
                    provider(new ChatTurnLifecycleProjector(mock(ChatTurnService.class))),
                    provider(mock(RuntimeEventPublisher.class)));
        }

        @SuppressWarnings("unchecked")
        private static <T> ObjectProvider<T> provider(T service) {
            ObjectProvider<T> provider = mock(ObjectProvider.class);
            when(provider.getObject()).thenReturn(service);
            return provider;
        }
    }
}
