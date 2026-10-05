package com.summit.dp.execution;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.summit.dp.execution.application.service.ExecutionResumeCoordinator;
import com.summit.dp.execution.domain.model.ExecutionResumeTask;
import com.summit.dp.execution.domain.model.ResumeTaskState;
import com.summit.dp.execution.domain.repository.ExecutionResumeTaskRepository;
import com.summit.dp.execution.infrastructure.config.ExecutionStartupReaper;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;

import java.time.Instant;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 启动执行收尸钩子（{@code ExecutionStartupReaper}）回归：
 * 进程崩溃重启后，遗留的 CREATED / RUNNING 执行由启动钩子收口为 FAILED，
 * SUSPENDED（待恢复）与终态行不受影响，收口幂等可重复执行。
 *
 * <p>同时覆盖架构 §8.3 末段：<b>只能重新派发「确实没启动过」的恢复任务</b> ——
 * CLAIMED 说明曾有 worker 领走过，重跑等于让同一段恢复执行两次；代际过期同理。</p>
 */
class ExecutionStartupReaperTest {

    private static final int STATUS_CREATED = 0;
    private static final int STATUS_RUNNING = 1;
    private static final int STATUS_SUSPENDED = 2;
    private static final int STATUS_COMPLETED = 3;
    private static final int STATUS_FAILED = 4;

    private EmbeddedDatabase database;
    private ExecutionMapper mapper;
    private ExecutionRepositoryImpl repository;
    private ExecutionResumeTaskRepository resumeTaskRepository;
    private ExecutionResumeCoordinator resumeCoordinator;

    @BeforeEach
    void setup() throws Exception {
        database = new EmbeddedDatabaseBuilder().generateUniqueName(true).setType(EmbeddedDatabaseType.H2)
                .addScript("execution-status-schema.sql").build();
        MybatisConfiguration configuration = new MybatisConfiguration();
        configuration.setMapUnderscoreToCamelCase(true);
        configuration.addMapper(ExecutionMapper.class);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        SqlSessionFactory sessionFactory = factory.getObject();
        SqlSessionTemplate session = new SqlSessionTemplate(sessionFactory);
        mapper = session.getMapper(ExecutionMapper.class);
        repository = new ExecutionRepositoryImpl(mapper);
        // 恢复任务表在 H2 单测库里是桩：只有重新派发判定需要它，reap 本身不碰。
        resumeTaskRepository = mock(ExecutionResumeTaskRepository.class);
        resumeCoordinator = mock(ExecutionResumeCoordinator.class);
        when(resumeTaskRepository.listDispatchable(any(), anyInt())).thenReturn(List.of());
        when(resumeTaskRepository.listClaimed(anyInt())).thenReturn(List.of());
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    @Test
    @DisplayName("崩溃收口：仅 CREATED / RUNNING 收口为 FAILED，SUSPENDED 与终态不动")
    void reapsOnlyCreatedAndRunning() {
        long createdId = insertExecution(101L, STATUS_CREATED);
        long runningId = insertExecution(102L, STATUS_RUNNING);
        long suspendedId = insertExecution(103L, STATUS_SUSPENDED);
        long completedId = insertExecution(104L, STATUS_COMPLETED);

        reaper().onApplicationEvent(mock(ApplicationReadyEvent.class));

        assertEquals(STATUS_FAILED, repository.findById(createdId).orElseThrow().getStatus(),
                "CREATED 应被收口为 FAILED");
        assertEquals(STATUS_FAILED, repository.findById(runningId).orElseThrow().getStatus(),
                "RUNNING 应被收口为 FAILED");
        assertEquals(STATUS_SUSPENDED, repository.findById(suspendedId).orElseThrow().getStatus(),
                "SUSPENDED（待恢复）不应被触碰");
        assertEquals(STATUS_COMPLETED, repository.findById(completedId).orElseThrow().getStatus(),
                "COMPLETED 终态不应被触碰");
    }

    @Test
    @DisplayName("幂等：重复触发不抛异常，第二次收口 0 行")
    void idempotentRepeat() {
        long createdId = insertExecution(201L, STATUS_CREATED);
        long runningId = insertExecution(202L, STATUS_RUNNING);

        ExecutionStartupReaper reaper = reaper();
        assertDoesNotThrow(() -> {
            reaper.onApplicationEvent(mock(ApplicationReadyEvent.class));
            reaper.onApplicationEvent(mock(ApplicationReadyEvent.class));
        });

        assertEquals(STATUS_FAILED, repository.findById(createdId).orElseThrow().getStatus());
        assertEquals(STATUS_FAILED, repository.findById(runningId).orElseThrow().getStatus());
        assertEquals(0, repository.markOrphanRunsFailed(), "已全部收口，重复收口应命中 0 行");
    }

    @Test
    @DisplayName("重新派发：READY 且代际匹配的恢复任务会被唤醒")
    void redispatchesReadyTaskWithMatchingGeneration() {
        long executionId = insertExecution(301L, STATUS_SUSPENDED, 7L);
        when(resumeTaskRepository.listDispatchable(any(Instant.class), eq(200)))
                .thenReturn(List.of(resumeTask(1L, executionId, 7L, ResumeTaskState.READY)));

        reaper().onApplicationEvent(mock(ApplicationReadyEvent.class));

        verify(resumeCoordinator).dispatch(executionId);
    }

    @Test
    @DisplayName("重新派发：代际已过期的任务不得作用在新挂起边界上")
    void skipsStaleGenerationTask() {
        // 执行已经过了一次新的挂起边界（代际从 7 涨到 8），旧意图作废。
        long executionId = insertExecution(501L, STATUS_SUSPENDED, 8L);
        when(resumeTaskRepository.listDispatchable(any(Instant.class), eq(200)))
                .thenReturn(List.of(resumeTask(3L, executionId, 7L, ResumeTaskState.READY)));

        reaper().onApplicationEvent(mock(ApplicationReadyEvent.class));

        verify(resumeCoordinator, never()).dispatch(anyLong());
    }

    // ------------------------------------------------------------------
    // 遗留 CLAIMED 四路分流（架构 §10.1）
    // ------------------------------------------------------------------

    @Test
    @DisplayName("遗留 CLAIMED：执行已终态 → 作废，不派发")
    void leftoverClaimedWithTerminalExecutionIsSuperseded() {
        long executionId = insertExecution(601L, STATUS_COMPLETED, 7L);
        ExecutionResumeTask claimed = resumeTask(11L, executionId, 7L, ResumeTaskState.CLAIMED);
        when(resumeTaskRepository.listClaimed(anyInt())).thenReturn(List.of(claimed));

        reaper().onApplicationEvent(mock(ApplicationReadyEvent.class));

        assertEquals(ResumeTaskState.SUPERSEDED, claimed.getState(), "终态执行的遗留任务必须作废");
        verify(resumeCoordinator, never()).dispatch(anyLong());
    }

    @Test
    @DisplayName("遗留 CLAIMED：代际已过期 → 作废，不派发")
    void leftoverClaimedWithStaleGenerationIsSuperseded() {
        // 任务代际 7，执行已推进到 8（期间又挂起过一次）
        long executionId = insertExecution(602L, STATUS_SUSPENDED, 8L);
        ExecutionResumeTask claimed = resumeTask(12L, executionId, 7L, ResumeTaskState.CLAIMED);
        when(resumeTaskRepository.listClaimed(anyInt())).thenReturn(List.of(claimed));

        reaper().onApplicationEvent(mock(ApplicationReadyEvent.class));

        assertEquals(ResumeTaskState.SUPERSEDED, claimed.getState(), "代际过期的遗留任务必须作废");
        verify(resumeCoordinator, never()).dispatch(anyLong());
    }

    @Test
    @DisplayName("遗留 CLAIMED：仍 SUSPENDED 且代际一致 → 证明未跨边界，允许重投")
    void leftoverClaimedBeforeBoundaryIsRedispatched() {
        long executionId = insertExecution(603L, STATUS_SUSPENDED, 7L);
        ExecutionResumeTask claimed = resumeTask(13L, executionId, 7L, ResumeTaskState.CLAIMED);
        when(resumeTaskRepository.listClaimed(anyInt())).thenReturn(List.of(claimed));

        reaper().onApplicationEvent(mock(ApplicationReadyEvent.class));

        verify(resumeCoordinator).dispatch(executionId);
        assertEquals(ResumeTaskState.CLAIMED, claimed.getState(), "可安全重投的任务不改状态，交由协调器领取");
    }

    @Test
    @DisplayName("遗留 CLAIMED：已脱离挂起点但非终态 → 标记需人工处理，禁止自动重跑")
    void leftoverClaimedAfterBoundaryNeedsManual() {
        // 执行已在 RUNNING：resume 的 SUSPENDED→RUNNING 已落库，副作用不明
        long executionId = insertExecution(604L, STATUS_RUNNING, 7L);
        ExecutionResumeTask claimed = resumeTask(14L, executionId, 7L, ResumeTaskState.CLAIMED);
        when(resumeTaskRepository.listClaimed(anyInt())).thenReturn(List.of(claimed));

        reaper().onApplicationEvent(mock(ApplicationReadyEvent.class));

        assertEquals(ResumeTaskState.NEEDS_MANUAL, claimed.getState(),
                "无法证明未跨边界时必须转人工，绝不自动重跑");
        verify(resumeCoordinator, never()).dispatch(anyLong());
    }

    private ExecutionStartupReaper reaper() {
        return new ExecutionStartupReaper(repository, resumeTaskRepository, resumeCoordinator);
    }

    private ExecutionResumeTask resumeTask(long id, long executionId, long generation, ResumeTaskState state) {
        return ExecutionResumeTask.builder().id(id).executionId(executionId).generation(generation)
                .state(state).attempts(0).version(1L)
                .nextAttemptAt(Instant.now()).createdAt(Instant.now()).updatedAt(Instant.now()).build();
    }

    /** 仅写入本测试关心的列，其余列取表默认值；回填并返回自增主键。 */
    private long insertExecution(long sessionId, int status) {
        return insertExecution(sessionId, status, 0L);
    }

    private long insertExecution(long sessionId, int status, long resumeGeneration) {
        ExecutionPO po = new ExecutionPO();
        po.setSessionId(sessionId);
        po.setStatus(status);
        po.setResumeGeneration(resumeGeneration);
        mapper.insert(po);
        return po.getId();
    }
}
