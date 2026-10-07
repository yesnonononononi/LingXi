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
 * <p>同时覆盖「遗留恢复请求只收口、不重投」：恢复只尝试一次，崩溃后留下的 READY / CLAIMED
 * 请求一律失败收口，绝不自动重投；而<b>没有遗留请求的 SUSPENDED 执行是正常等待审批，
 * 原样保留</b>。</p>
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
        // 恢复请求表在 H2 单测库里是桩：只做启动收口判定，reap 本身不碰。
        resumeTaskRepository = mock(ExecutionResumeTaskRepository.class);
        resumeCoordinator = mock(ExecutionResumeCoordinator.class);
        when(resumeTaskRepository.listUnfinished(anyInt())).thenReturn(List.of());
        when(resumeTaskRepository.updateState(any())).thenReturn(true);
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
        verify(resumeTaskRepository).purgeFinishedBefore(any());
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

    // ------------------------------------------------------------------
    // 遗留请求只收口、不重投（变异守卫 #3）
    // ------------------------------------------------------------------

    @Test
    @DisplayName("遗留请求只收口不重投：执行收口 + 请求 FAILED，绝不 dispatch")
    void leftoverRequestIsClosedOutAndNeverRedispatched() {
        long executionId = insertExecution(301L, STATUS_SUSPENDED, 7L);
        ExecutionResumeTask leftover = resumeTask(1L, executionId, 7L, ResumeTaskState.READY);
        when(resumeTaskRepository.listUnfinished(anyInt())).thenReturn(List.of(leftover));

        reaper().onApplicationEvent(mock(ApplicationReadyEvent.class));

        verify(resumeCoordinator).closeStartupFailure(eq(executionId), any());
        verify(resumeCoordinator, never()).dispatch(anyLong());
        assertEquals(ResumeTaskState.FAILED, leftover.getState(),
                "遗留请求必须收口为 FAILED，绝不能自动重投");
    }

    @Test
    @DisplayName("遗留请求对应执行崩溃时正在 loop 中：执行被收口、请求 FAILED，不重投")
    void leftoverRequestMidLoopIsClosedOut() {
        long executionId = insertExecution(302L, STATUS_RUNNING, 7L);
        ExecutionResumeTask leftover = resumeTask(2L, executionId, 7L, ResumeTaskState.CLAIMED);
        when(resumeTaskRepository.listUnfinished(anyInt())).thenReturn(List.of(leftover));

        reaper().onApplicationEvent(mock(ApplicationReadyEvent.class));

        verify(resumeCoordinator).closeStartupFailure(eq(executionId), any());
        verify(resumeCoordinator, never()).dispatch(anyLong());
        assertEquals(ResumeTaskState.FAILED, leftover.getState());
        assertEquals(STATUS_FAILED, repository.findById(executionId).orElseThrow().getStatus(),
                "崩溃时在 loop 中的执行由 markOrphanRunsFailed 收口为 FAILED");
    }

    // ------------------------------------------------------------------
    // 正常等待审批的 SUSPENDED 执行原样保留（变异守卫 #4）
    // ------------------------------------------------------------------

    @Test
    @DisplayName("无遗留请求的 SUSPENDED 执行：启动收尸原样保留，不触碰")
    void suspendedWithoutLeftoverRequestSurvivesUntouched() {
        long suspendedId = insertExecution(401L, STATUS_SUSPENDED, 7L);
        when(resumeTaskRepository.listUnfinished(anyInt())).thenReturn(List.of());

        reaper().onApplicationEvent(mock(ApplicationReadyEvent.class));

        assertEquals(STATUS_SUSPENDED, repository.findById(suspendedId).orElseThrow().getStatus(),
                "正常等待审批的 SUSPENDED 执行必须原样保留");
        verify(resumeCoordinator, never()).closeStartupFailure(anyLong(), any());
        verify(resumeCoordinator, never()).dispatch(anyLong());
    }

    // ------------------------------------------------------------------
    // 已无意义的请求：执行终态 / 代际过期
    // ------------------------------------------------------------------

    @Test
    @DisplayName("遗留请求：执行已终态 → 作废，不收口也不派发")
    void leftoverRequestWithTerminalExecutionIsSuperseded() {
        long executionId = insertExecution(601L, STATUS_COMPLETED, 7L);
        ExecutionResumeTask leftover = resumeTask(11L, executionId, 7L, ResumeTaskState.CLAIMED);
        when(resumeTaskRepository.listUnfinished(anyInt())).thenReturn(List.of(leftover));

        reaper().onApplicationEvent(mock(ApplicationReadyEvent.class));

        assertEquals(ResumeTaskState.SUPERSEDED, leftover.getState(), "终态执行的遗留请求必须作废");
        verify(resumeCoordinator, never()).closeStartupFailure(anyLong(), any());
        verify(resumeCoordinator, never()).dispatch(anyLong());
    }

    @Test
    @DisplayName("遗留请求：代际已过期 → 作废，不连坐新的挂起边界")
    void leftoverRequestWithStaleGenerationIsSuperseded() {
        // 执行已经过了一次新的挂起边界（代际从 7 涨到 8），旧请求作废。
        long executionId = insertExecution(602L, STATUS_SUSPENDED, 8L);
        ExecutionResumeTask leftover = resumeTask(12L, executionId, 7L, ResumeTaskState.CLAIMED);
        when(resumeTaskRepository.listUnfinished(anyInt())).thenReturn(List.of(leftover));

        reaper().onApplicationEvent(mock(ApplicationReadyEvent.class));

        assertEquals(ResumeTaskState.SUPERSEDED, leftover.getState(), "代际过期的遗留请求必须作废");
        assertEquals(STATUS_SUSPENDED, repository.findById(executionId).orElseThrow().getStatus(),
                "新挂起边界是合法的等待，不能被旧请求连坐收口");
        verify(resumeCoordinator, never()).closeStartupFailure(anyLong(), any());
        verify(resumeCoordinator, never()).dispatch(anyLong());
    }

    private ExecutionStartupReaper reaper() {
        return new ExecutionStartupReaper(repository, resumeTaskRepository, resumeCoordinator);
    }

    private ExecutionResumeTask resumeTask(long id, long executionId, long generation, ResumeTaskState state) {
        return ExecutionResumeTask.builder().id(id).executionId(executionId).generation(generation)
                .state(state).version(1L)
                .createdAt(Instant.now()).updatedAt(Instant.now()).build();
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
