package com.summit.dp.execution;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.application.port.ExecutionActivity;
import com.summit.dp.execution.domain.model.ExecutionResumeTask;
import com.summit.dp.execution.domain.model.ResumeSource;
import com.summit.dp.execution.domain.model.ResumeTaskState;
import com.summit.dp.execution.domain.repository.ExecutionResumeTaskRepository;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionResumeTaskMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.execution.infrastructure.repository.ExecutionResumeTaskRepositoryImpl;
import com.summit.dp.shared.concurrent.ManagedAsyncExecutor;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.workflow.application.input.InputAutomationPolicy;
import com.summit.dp.workflow.application.lifecycle.StartupFailureCloser;
import com.summit.dp.workflow.application.lifecycle.SuspensionGateChain;
import com.summit.dp.workflow.application.lifecycle.UnresolvedToolSuspensionGate;
import com.summit.dp.workflow.application.lifecycle.UserPauseSuspensionGate;
import com.summit.dp.workflow.application.lifecycle.ExecutionResumeCoordinator;
import com.summit.dp.workflow.application.lifecycle.SuspendedExecutionResumer;
import com.summit.dp.workflow.infrastructure.lifecycle.startup.ExecutionStartupReaper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.fail;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 真实启动入口按<b>持久化来源</b>重投遗留的人工恢复请求，而不是一律烧成 FAILED。
 *
 * <p>走的是真链路：{@code ApplicationReadyEvent → ExecutionStartupReaper → ExecutionResumeCoordinator}，
 * 执行表与恢复请求表都是真实 H2 仓储。框架侧（执行检查点读口、恢复动作）用 mock —— 它们由框架实现，
 * 与本类要守的判定无关。</p>
 *
 * <p><b>判据（写在用例名里）</b>：</p>
 * <ul>
 *   <li>READY / DEFERRED + 执行仍 SUSPENDED + 代际一致 → 不失败收口，按库内来源重投（人工来源不受
 *       {@code AUTO_ROUNDS} 限制）；</li>
 *   <li>CLAIMED（崩溃时已在跑）→ 保持既有安全策略，收口为 FAILED；</li>
 *   <li>代际过期 → 作废，且不触发恢复。</li>
 * </ul>
 */
class ExecutionStartupReaperResumeSourceTest {

    private static final long SUSPENDED = 2L;
    private static final long COMPLETED = 3L;
    private static final long GENERATION = 5L;

    private H2TestDatabase database;
    private ExecutionMapper executionMapper;
    private ExecutionRepositoryImpl executions;
    private ExecutionResumeTaskMapper resumeTaskMapper;
    private ExecutionResumeTaskRepository tasks;

    private final ExecutionControl executionControl = mock(ExecutionControl.class);
    private final SuspendedExecutionResumer resumer = mock(SuspendedExecutionResumer.class);
    private final ExecutionActivity activity = mock(ExecutionActivity.class);
    private final ExecutionRepository frameworkExecutions = mock(ExecutionRepository.class);
    private ExecutionResumeCoordinator coordinator;

    @BeforeEach
    void setup() {
        database = H2TestDatabase.create("ExecutionStartupReaperResumeSourceTest");
        executionMapper = H2TestDatabase.sqlSession(database.sessionFactory(ExecutionMapper.class))
                .getMapper(ExecutionMapper.class);
        resumeTaskMapper = H2TestDatabase.sqlSession(database.sessionFactory(ExecutionResumeTaskMapper.class))
                .getMapper(ExecutionResumeTaskMapper.class);
        executions = new ExecutionRepositoryImpl(executionMapper);
        tasks = new ExecutionResumeTaskRepositoryImpl(resumeTaskMapper);
        when(activity.isActive(any())).thenReturn(false);
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    @Test
    @DisplayName("已受理未开始的同代际人工审批：重启后按库内来源重投并真的恢复，绝不 FAILED")
    void humanApprovalAcceptedBeforeStartResumesAfterRestart() {
        long executionId = insertExecution(SUSPENDED, GENERATION);
        ExecutionResumeTask task = tasks.enqueue(executionId, GENERATION, Instant.now(),
                ResumeSource.APPROVAL_DECISION);
        stubSuspendedExecution(executionId, autoRoundsAtLimit());

        reaper().onApplicationEvent(mock(ApplicationReadyEvent.class));

        assertEquals(ResumeTaskState.SUCCEEDED, awaitState(executionId),
                "人工批准已落库、执行仍挂起：重启必须把它重投并恢复，而不是判失败");
        verify(resumer).resume(any(Execution.class), anyLong());
        verify(executionControl, never()).fail(any(), any());
        assertEquals(GENERATION, resumeTaskOf(executionId).getGeneration(),
                "重投沿用同一条请求，不得改写代际");
        assertEquals(task.getId(), resumeTaskOf(executionId).getId());
    }

    @Test
    @DisplayName("门禁未放行的 DEFERRED 人工请求：重启后重新排队并恢复")
    void deferredHumanRequestIsRetriedOnRestart() {
        long executionId = insertExecution(SUSPENDED, GENERATION);
        ExecutionResumeTask task = tasks.enqueue(executionId, GENERATION, Instant.now(),
                ResumeSource.APPROVAL_DECISION);
        task.defer("自动轮次已达上限，等待下一次受理");
        tasks.updateState(task);
        assertEquals(ResumeTaskState.DEFERRED, resumeTaskOf(executionId).getState(),
                "前提：请求处于 DEFERRED");
        stubSuspendedExecution(executionId, autoRoundsAtLimit());

        reaper().onApplicationEvent(mock(ApplicationReadyEvent.class));

        assertEquals(ResumeTaskState.SUCCEEDED, awaitState(executionId),
                "DEFERRED 请求必须被启动扫描纳入并重新排队，否则重启后永远等不到下一次受理");
        verify(resumer).resume(any(Execution.class), anyLong());
        verify(executionControl, never()).fail(any(), any());
    }

    @Test
    @DisplayName("崩溃时已在跑的 CLAIMED 请求：保持既有安全策略，收口为 FAILED 且不重投")
    void claimedRequestStillClosedSafely() {
        long executionId = insertExecution(SUSPENDED, GENERATION);
        ExecutionResumeTask task = tasks.enqueue(executionId, GENERATION, Instant.now(),
                ResumeSource.APPROVAL_DECISION);
        tasks.claim(task);
        assertEquals(ResumeTaskState.CLAIMED, resumeTaskOf(executionId).getState(), "前提：请求已被领取");
        stubSuspendedExecution(executionId, new HashMap<>());

        reaper().onApplicationEvent(mock(ApplicationReadyEvent.class));

        assertEquals(ResumeTaskState.FAILED, resumeTaskOf(executionId).getState(),
                "崩溃时已在跑，无法确认是否已产生副作用：必须收口为失败，绝不重投");
        verify(resumer, never()).resume(any(Execution.class), anyLong());
        verify(coordinator, never()).dispatch(anyLong());
        verify(executionControl).fail(any(), any());
    }

    @Test
    @DisplayName("代际过期的遗留请求：作废，且不触发任何恢复")
    void staleGenerationRequestIsSuperseded() {
        long executionId = insertExecution(SUSPENDED, GENERATION + 1);
        tasks.enqueue(executionId, GENERATION, Instant.now(), ResumeSource.APPROVAL_DECISION);
        stubSuspendedExecution(executionId, new HashMap<>());

        reaper().onApplicationEvent(mock(ApplicationReadyEvent.class));

        assertEquals(ResumeTaskState.SUPERSEDED, resumeTaskOf(executionId).getState(),
                "代际已变说明期间又挂起过：旧请求必须作废，不能连坐新的挂起边界");
        verify(coordinator, never()).dispatch(anyLong());
        verify(resumer, never()).resume(any(Execution.class), anyLong());
        verify(executionControl, never()).fail(any(), any());
    }

    @Test
    @DisplayName("请求 READY 但执行仍在跑：不得重投，按既有安全策略收口为 FAILED")
    void runningExecutionIsNotResumedEvenWhenRequestReady() {
        long executionId = insertExecution(ExecutionStatusCodes.RUNNING, GENERATION);
        ExecutionResumeTask task = tasks.enqueue(executionId, GENERATION, Instant.now(),
                ResumeSource.APPROVAL_DECISION);
        assertEquals(ResumeTaskState.READY, resumeTaskOf(executionId).getState(),
                "前提：请求已受理、尚未被领取");
        stubExecution(executionId, ExecutionState.RUNNING, new HashMap<>());

        reaper().onApplicationEvent(mock(ApplicationReadyEvent.class));

        assertEquals(ResumeTaskState.FAILED, resumeTaskOf(executionId).getState(),
                "执行已不在 SUSPENDED（这里是 RUNNING，等同另一个活进程正在跑）：重投会让同一段执行并行跑第二次模型调用");
        verify(resumer, never()).resume(any(Execution.class), anyLong());
        verify(coordinator, never()).dispatch(anyLong());
        verify(executionControl).fail(any(), any());
        assertEquals(task.getId(), resumeTaskOf(executionId).getId(),
                "收口沿用同一条请求，不得另开一条");
    }

    // ------------------------------------------------------------------
    // 夹具
    // ------------------------------------------------------------------

    private ExecutionStartupReaper reaper() {
        SuspensionGateChain gates = new SuspensionGateChain(List.of(new UserPauseSuspensionGate()));
        // 真实协调器 + spy：恢复是否被触发这件事只能从「派发有没有发生」上看出来。
        coordinator = spy(new ExecutionResumeCoordinator(
                tasks, executions, resumer, executionControl, gates,
                mock(UnresolvedToolSuspensionGate.class),
                provider(ExecutionRepository.class, frameworkExecutions),
                provider(ExecutionActivity.class, activity),
                new StartupFailureCloser(executionControl)));
        return new ExecutionStartupReaper(executions, tasks, coordinator, frameworkExecutions,
                mock(com.summit.dp.workflow.application.lifecycle.ExecutionLifecycleProjection.class),
                new ManagedAsyncExecutor() {
                    @Override
                    public boolean tryExecute(String taskName, Runnable task) {
                        // 待收口补偿与本类无关：只接住任务，不执行。
                        return true;
                    }
                });
    }

    private long insertExecution(long status, long generation) {
        ExecutionPO row = new ExecutionPO();
        row.setSessionId(9_500L);
        row.setStatus((int) status);
        row.setResumeGeneration(generation);
        row.setClosurePending(0);
        executionMapper.insert(row);
        return row.getId();
    }

    private void stubSuspendedExecution(long executionId, Map<String, Object> attributes) {
        stubExecution(executionId, ExecutionState.SUSPENDED, attributes);
    }

    /** 框架检查点读口返回的执行快照：状态由用例指定，其余字段与生产同构。 */
    private void stubExecution(long executionId, ExecutionState state, Map<String, Object> attributes) {
        attributes.put(com.summit.dp.execution.ExecutionAttributes.SESSION_ID, "9500");
        Execution execution = Execution.builder().id(String.valueOf(executionId))
                .agentId("chatAgent").executionState(state)
                .agentRequest(AgentRequest.builder().executionId(String.valueOf(executionId))
                        .runtimeParameters(AgentRuntimeParameters.builder().attributes(attributes).build())
                        .build())
                .build();
        // 框架的检查点读口同时被 reaper 与 coordinator 使用，返回同一份挂起执行。
        doReturn(Optional.of(execution)).when(frameworkExecutions).findById(String.valueOf(executionId));
    }

    private static Map<String, Object> autoRoundsAtLimit() {
        return new HashMap<>(Map.of(InputAutomationPolicy.AUTO_ROUNDS, InputAutomationPolicy.MAX_AUTO_ROUNDS));
    }

    private ExecutionResumeTask resumeTaskOf(long executionId) {
        List<ExecutionResumeTask> live = tasks.findByExecutionId(executionId);
        assertEquals(1, live.size(), "同一执行应当只有一条恢复请求");
        return live.get(0);
    }

    /** 恢复是异步派发的：轮询库里的请求状态，只做「有限时间内收敛」的断言。 */
    private ResumeTaskState awaitState(long executionId) {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30L);
        ResumeTaskState state = null;
        while (System.nanoTime() < deadline) {
            state = resumeTaskOf(executionId).getState();
            if (state != ResumeTaskState.READY && state != ResumeTaskState.CLAIMED) {
                return state;
            }
            try {
                TimeUnit.MILLISECONDS.sleep(50L);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                fail("等待恢复请求收敛被中断");
            }
        }
        return state;
    }

    private static <T> ObjectProvider<T> provider(Class<T> type, T value) {
        return new StaticListableBeanFactory(Map.of("value", value)).getBeanProvider(type);
    }
}
