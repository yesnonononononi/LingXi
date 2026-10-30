package com.summit.dp.execution;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.dp.execution.application.port.ExecutionCheckpointStore;
import com.summit.dp.execution.application.service.ExecutionCheckpointService;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.execution.infrastructure.checkpoint.LocalFileCheckpointStore;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.shared.persistence.MyBatisTypeHandlers;
import com.summit.dp.shared.support.SqliteTestDatabase;
import com.summit.dp.workflow.application.approval.ToolCallReadinessService;
import com.summit.dp.workflow.application.projection.ChatTurnLifecycleProjector;
import com.summit.dp.workflow.application.projection.SessionContextUsageProjector;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.harness.LocalExecutionRepository;
import com.summit.dp.workflow.infrastructure.lifecycle.SubExecutionLifecycle;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.turn.application.service.ChatTurnService;
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
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.when;

/**
 * 复核 R2：不同执行在真实事务里并发保存，必须都能提交，且不允许停在旧快照上。
 *
 * <p>被守的缺陷：SQLite 的事务第一次读就固定快照。A 提交后，B 在<b>原事务</b>里更新会立刻收到
 * {@code SQLITE_BUSY_SNAPSHOT}；在同一个过期事务里重试 UPDATE 永远失败。必须整笔丢弃、
 * 换一个全新事务重新读，才可能成功。</p>
 *
 * <p>这里刻意使用真实的 {@link DataSourceTransactionManager}（Spring 上下文注入到生产仓储），
 * 而不是 {@code new} 一个没有事务基础设施的服务 —— 复核报告里「new 出来的三并发通过」
 * 不能代表生产事务路径。</p>
 */
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

    @BeforeEach
    void setUp() {
        executions.delete(null);
    }

    /**
     * 屏障强制「两笔都读到旧快照后 A 先提交，B 再更新」：B 必须靠换新事务重试成功。
     */
    @Test
    void concurrentSavesOnDifferentExecutionsBothCommitThroughRetry() throws Exception {
        runtime.save(execution(FIRST_ID, ExecutionState.CREATED));
        runtime.save(execution(SECOND_ID, ExecutionState.CREATED));
        String firstOriginalFile = executions.selectById(FIRST_ID).getSnapshotFile();
        String secondOriginalFile = executions.selectById(SECOND_ID).getSnapshotFile();
        assertEquals(1L, executions.selectById(FIRST_ID).getVersion());
        assertEquals(1L, executions.selectById(SECOND_ID).getVersion());

        CountDownLatch secondReadStaleSnapshot = new CountDownLatch(1);
        CountDownLatch firstCommitted = new CountDownLatch(1);
        AtomicInteger secondReads = new AtomicInteger();
        // 只在 B 的「第一次」读取上做文章：读到旧快照后卡住，等 A 提交完再写 —— 正好撞上
        // SQLITE_BUSY_SNAPSHOT。重试会走第二次读取（不再卡住），于是能提交成功。
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
            // A 在 B 占着旧快照时提交：这正是复核报告里 B 必然收到 BUSY_SNAPSHOT 的交错。
            runtime.save(execution(FIRST_ID, ExecutionState.COMPLETED));
            firstCommitted.countDown();
            second.get(30, TimeUnit.SECONDS);
        }

        assertEquals(2, secondReads.get(), "B 的第二次读取必须来自重试开出的新事务（去掉重试这里只会读到 1 次）");
        assertEquals(2L, executions.selectById(FIRST_ID).getVersion(), "A 的版本必须前进到 2");
        assertEquals(2L, executions.selectById(SECOND_ID).getVersion(), "B 的版本必须前进到 2");
        String firstFile = executions.selectById(FIRST_ID).getSnapshotFile();
        String secondFile = executions.selectById(SECOND_ID).getSnapshotFile();
        assertNotEquals(firstOriginalFile, firstFile, "本次保存必须发布新文件");
        assertNotEquals(secondOriginalFile, secondFile, "本次保存必须发布新文件");
        // 提交成功后才删旧文件：两笔的旧正文都必须已经被回收。
        assertTrue(Files.notExists(checkpointFile(FIRST_ID, firstOriginalFile)), "A 的旧正文应在提交后删除");
        assertTrue(Files.notExists(checkpointFile(SECOND_ID, secondOriginalFile)), "B 的旧正文应在提交后删除");
        // 库内引用必须指向真实存在的正文：重试成功但文件对不上就是断链。
        assertTrue(Files.isRegularFile(checkpointFile(FIRST_ID, firstFile)));
        assertTrue(Files.isRegularFile(checkpointFile(SECOND_ID, secondFile)));
        assertNotNull(runtime.findById(Long.toString(SECOND_ID)).orElse(null), "保存后必须还能按引用读出正文");
        assertEquals(ExecutionState.SUSPENDED, runtime.findById(Long.toString(SECOND_ID)).orElseThrow()
                .getExecutionState(), "重试成功后落库的必须是最新状态");
    }

    /** 三次保存串行叠加：每次都必须是新文件 + 版本继续前进（旧文件逐次回收）。 */
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
        @Bean(destroyMethod = "shutdown")
        SqliteTestDatabase database() {
            return SqliteTestDatabase.create("ConcurrentCheckpointSaveTransactionTest");
        }

        @Bean
        PlatformTransactionManager transactionManager(SqliteTestDatabase database) {
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
        SqlSessionTemplate sql(SqliteTestDatabase database) throws Exception {
            MybatisConfiguration configuration = new MybatisConfiguration();
            configuration.setMapUnderscoreToCamelCase(true);
            MyBatisTypeHandlers.registerAll(configuration);
            configuration.addMapper(ExecutionMapper.class);
            MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
            factory.setDataSource(database);
            factory.setConfiguration(configuration);
            return SqliteTestDatabase.sqlSession(factory.getObject());
        }

        @Bean
        ExecutionRepository executionRepository(SqlSessionTemplate sql) {
            // spy 只为在「读到旧快照之后」插入确定性屏障，不改任何行为。
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
            // 生产保存入口：事务管理器由 Spring 注入（PlatformTransactionManager 字段），
            // 因此这里走的是真实事务路径，而不是无事务的直连。
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
