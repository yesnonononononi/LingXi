package com.summit.dp.execution;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.application.port.ExecutionActivity;
import com.summit.dp.execution.domain.model.ExecutionResumeTask;
import com.summit.dp.execution.domain.model.ResumeTaskState;
import com.summit.dp.execution.application.service.ResumeDisposition;
import com.summit.dp.execution.domain.repository.ExecutionResumeTaskRepository;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.infrastructure.persistence.mapper.ToolCallMapper;
import com.summit.dp.toolcall.infrastructure.persistence.repository.ToolCallRepositoryImpl;
import com.summit.dp.workflow.application.input.InputAutomationPolicy;
import com.summit.dp.workflow.application.lifecycle.ResumeTriggerType;
import com.summit.dp.workflow.application.lifecycle.StartupFailureCloser;
import com.summit.dp.workflow.application.lifecycle.SubAgentWaitSuspensionGate;
import com.summit.dp.workflow.application.lifecycle.SubExecutionDependency;
import com.summit.dp.workflow.application.lifecycle.SuspensionGateChain;
import com.summit.dp.workflow.application.lifecycle.UnresolvedToolSuspensionGate;
import com.summit.dp.workflow.application.lifecycle.UserPauseSuspensionGate;
import com.summit.dp.workflow.application.lifecycle.ExecutionResumeCoordinator;
import com.summit.dp.workflow.application.lifecycle.SuspendedExecutionResumer;
import com.summit.dp.workflow.infrastructure.harness.HarnessExecutionGate;
import com.summit.dp.workflow.infrastructure.harness.SessionAttributeRestorer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.support.StaticListableBeanFactory;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.*;

/**
 * 恢复消费端的锁内复检：门禁不通过就静默保持挂起，绝不记成执行失败。
 *
 * <p>未决槽位用真 H2 + 真仓储（{@link UnresolvedToolSuspensionGate}），否则测不出「判定真的下推到了 SQL」；
 * 执行侧仍用 mock，因为它们由框架实现、与本类要守的顺序无关。</p>
 */
class ExecutionResumeGateRecheckTest {

    private static final long EXECUTION_ID = 1200L;
    private static final long SESSION_ID = 820L;
    private static final long GENERATION = 4L;

    private final ExecutionRepository frameworkExecutions = mock(ExecutionRepository.class);
    private final ExecutionActivity activity = mock(ExecutionActivity.class);
    private final ExecutionControl executionControl = mock(ExecutionControl.class);
    private final ModelContextService modelContextService = mock(ModelContextService.class);
    private final ExecutionResumeTaskRepository tasks = mock(ExecutionResumeTaskRepository.class);
    private final com.summit.dp.execution.domain.repository.ExecutionRepository summaries =
            mock(com.summit.dp.execution.domain.repository.ExecutionRepository.class);

    private final AtomicReference<ExecutionResumeTask> task = new AtomicReference<>();
    private final CountDownLatch stateWritten = new CountDownLatch(1);

    private H2TestDatabase database;
    private ToolCallRepositoryImpl toolCalls;
    private ExecutionResumeCoordinator coordinator;

    @BeforeEach
    void setup() throws Exception {
        database = H2TestDatabase.create("ExecutionResumeGateRecheckTest");
        toolCalls = new ToolCallRepositoryImpl(
                H2TestDatabase.sqlSession(database.sessionFactory(ToolCallMapper.class)).getMapper(ToolCallMapper.class),
                new com.fasterxml.jackson.databind.ObjectMapper(),
                new CardAvailabilityPolicy(new HarnessExecutionGate(
                        mock(ObjectProvider.class), mock(ObjectProvider.class))));

        SuspensionGateChain gates = new SuspensionGateChain(List.of(
                new UserPauseSuspensionGate(),
                new UnresolvedToolSuspensionGate(toolCalls),
                new SubAgentWaitSuspensionGate(new SubExecutionDependency(
                        mock(com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry.class),
                        mock(SessionRepository.class), mock(ExecutionRepositoryImpl.class)))));
        SuspendedExecutionResumer resumer = new SuspendedExecutionResumer(
                mock(SessionAttributeRestorer.class), modelContextService, provider(ExecutionControl.class, executionControl));
        coordinator = new ExecutionResumeCoordinator(tasks, summaries, resumer, executionControl, gates,
                new UnresolvedToolSuspensionGate(toolCalls), provider(ExecutionRepository.class, frameworkExecutions),
                provider(ExecutionActivity.class, activity), new StartupFailureCloser(executionControl));

        task.set(newTask());
        when(activity.isActive(any())).thenReturn(false);
        when(summaries.findResumeGeneration(EXECUTION_ID)).thenReturn(GENERATION);
        when(tasks.findByExecutionId(EXECUTION_ID)).thenAnswer(invocation -> List.of(task.get()));
        when(tasks.claim(any())).thenAnswer(invocation -> {
            ((ExecutionResumeTask) invocation.getArgument(0)).claim();
            return true;
        });
        when(tasks.updateState(any())).thenAnswer(invocation -> {
            stateWritten.countDown();
            return true;
        });
        // 受理时把来源合并进同一个任务对象：生产里 enqueue 会把来源写进库、消费端从行上读回来，
        // 这里用 mock 仓储，必须显式模拟「来源随着请求被记住」，否则所有请求都会退化成自动唤醒。
        when(tasks.enqueue(anyLong(), anyLong(), any(), any())).thenAnswer(invocation -> {
            task.get().promoteSource(invocation.getArgument(3));
            return task.get();
        });
    }

    @AfterEach
    void shutdown() {
        coordinator.close();
        if (database != null) {
            database.shutdown();
        }
    }

    @Test
    @DisplayName("消费端复检：仍有未决槽位 → 静默保持挂起，不 resume、不记失败")
    void unresolvedSlotKeepsExecutionSuspendedWithoutFailing() {
        toolCalls.save(card("c-pending"));
        stubSuspendedExecution(new HashMap<>());

        coordinator.dispatch(EXECUTION_ID);

        assertEquals(ResumeTaskState.DEFERRED, awaitStateWritten(),
                "门禁拦住只是「还没条件恢复」：请求必须保留可重试，不能烧成作废，也不能判失败");
        verify(executionControl, never()).resume(any());
        verify(executionControl, never()).fail(any(), any());
        verify(modelContextService, never()).replace(anyLong(), any());
    }

    @Test
    @DisplayName("消费端复检：用户暂停中 → 自动唤醒不得恢复，且暂停标记原样保留")
    void userPauseKeepsExecutionSuspendedAndMarkerIntact() {
        Execution execution = stubSuspendedExecution(new HashMap<>(Map.of(InputAutomationPolicy.USER_PAUSED, true)));

        coordinator.dispatch(EXECUTION_ID);

        assertEquals(ResumeTaskState.DEFERRED, awaitStateWritten());
        verify(executionControl, never()).resume(any());
        assertTrue(InputAutomationPolicy.attributes(execution).containsKey(InputAutomationPolicy.USER_PAUSED),
                "自动唤醒绝不能替人清掉暂停意图");
    }

    @Test
    @DisplayName("消费端复检通过：无未决槽位且未被暂停 → 正常恢复")
    void cleanExecutionResumes() {
        Execution execution = stubSuspendedExecution(new HashMap<>());
        when(executionControl.resume(any(Execution.class))).thenReturn(execution);

        coordinator.dispatch(EXECUTION_ID);

        assertEquals(ResumeTaskState.SUCCEEDED, awaitStateWritten());
        ArgumentCaptor<Execution> captor = ArgumentCaptor.forClass(Execution.class);
        verify(executionControl).resume(captor.capture());
        assertEquals(String.valueOf(EXECUTION_ID), captor.getValue().getId());
    }

    @Test
    @DisplayName("轮次上限已满 + 人工批准：消费端复检放行并真恢复，请求不判作废")
    void autoRoundsAtLimitDoesNotBlockApprovalResume() {
        stubImmediateDispatch();
        Execution execution = stubSuspendedExecution(autoRoundsAtLimit());
        when(executionControl.resume(any(Execution.class))).thenReturn(execution);

        // 直连 accept：这就是 ApprovalFinalizer / ChoiceAnswersService / CommandApprovalExecutor /
        // VersionedToolCallDecisionService 真实调用形态，不经过编排器。
        ResumeDisposition disposition = coordinator.accept(EXECUTION_ID, ResumeTriggerType.APPROVAL_DECISION);

        assertEquals(ResumeDisposition.QUEUED, disposition);
        assertEquals(ResumeTaskState.SUCCEEDED, awaitStateWritten(),
                "人工批准不是自动接续，轮次上限不得拦住它 —— 拦住就是「回执说已受理、执行永远挂起」");
        verify(executionControl).resume(any(Execution.class));
        assertEquals(InputAutomationPolicy.MAX_AUTO_ROUNDS, InputAutomationPolicy.autoRounds(execution),
                "放行不等于清标记：轮次计数仍由入口在自动接续时维护");
    }

    @Test
    @DisplayName("轮次上限已满 + 自动唤醒：仍然作废请求并保持挂起")
    void autoRoundsAtLimitStillBlocksAutomaticWakeup() {
        stubImmediateDispatch();
        stubSuspendedExecution(autoRoundsAtLimit());

        coordinator.accept(EXECUTION_ID, ResumeTriggerType.AUTO_INPUT_WAKEUP);

        assertEquals(ResumeTaskState.DEFERRED, awaitStateWritten(),
                "自动唤醒继续受轮次上限约束（否则就是机器无限自转），但请求保留可重试");
        verify(executionControl, never()).resume(any());
        verify(executionControl, never()).fail(any(), any());
    }

    @Test
    @DisplayName("用户暂停中 + 人工批准：仍然作废，暂停标记原样保留")
    void userPausedStillBlocksApprovalDecision() {
        stubImmediateDispatch();
        Execution execution = stubSuspendedExecution(
                new HashMap<>(Map.of(InputAutomationPolicy.USER_PAUSED, true)));

        coordinator.accept(EXECUTION_ID, ResumeTriggerType.APPROVAL_DECISION);

        assertEquals(ResumeTaskState.DEFERRED, awaitStateWritten(),
                "人按了暂停就是暂停：审批恢复不能替他取消，手动恢复才是唯一出口（请求保留可重试）");
        verify(executionControl, never()).resume(any());
        assertTrue(InputAutomationPolicy.attributes(execution).containsKey(InputAutomationPolicy.USER_PAUSED),
                "暂停标记必须原样保留，否则下一次自动唤醒就会在用户不知情时把执行拉起来");
    }

    private Execution stubSuspendedExecution(Map<String, Object> attributes) {
        attributes.put(com.summit.dp.execution.ExecutionAttributes.SESSION_ID, String.valueOf(SESSION_ID));
        Execution execution = Execution.builder().id(String.valueOf(EXECUTION_ID))
                .agentId("chatAgent").executionState(ExecutionState.SUSPENDED)
                .agentRequest(AgentRequest.builder().executionId(String.valueOf(EXECUTION_ID))
                        .runtimeParameters(AgentRuntimeParameters.builder().attributes(attributes).build())
                        .build())
                .build();
        when(frameworkExecutions.findById(String.valueOf(EXECUTION_ID))).thenReturn(Optional.of(execution));
        return execution;
    }

    /**
     * 让 {@code accept} 驱动整条链路。
     *
     * <p>生产里 {@code afterCommit} 要等事务提交才回调；单测没有事务同步，直接立即执行，
     * 这样测的就是「决策受理 → 派发 → 消费端复检」这条真实路径，而不是手调 {@code dispatch}。
     */
    private void stubImmediateDispatch() {
        doAnswer(invocation -> {
            invocation.getArgument(0, Runnable.class).run();
            return null;
        }).when(frameworkExecutions).afterCommit(any());
    }

    private static Map<String, Object> autoRoundsAtLimit() {
        return new HashMap<>(Map.of(InputAutomationPolicy.AUTO_ROUNDS, InputAutomationPolicy.MAX_AUTO_ROUNDS));
    }

    private ResumeTaskState awaitStateWritten() {
        try {
            assertTrue(stateWritten.await(10, TimeUnit.SECONDS), "状态写入没有在超时内发生");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            fail("等待状态写入被中断");
        }
        return task.get().getState();
    }

    private static ExecutionResumeTask newTask() {
        return ExecutionResumeTask.builder().id(1L).executionId(EXECUTION_ID).generation(GENERATION)
                .state(ResumeTaskState.READY).createdAt(Instant.now()).build();
    }

    private static ToolCall card(String id) {
        return ToolCall.builder().id(id).conversationId(SESSION_ID).executionId(EXECUTION_ID)
                .toolName("ask_user").type(ToolCallType.PROMISE).status(ToolCallStatus.PENDING)
                .title("选择").content("{\"kind\":\"CHOICE\",\"question\":\"选一个\"}")
                .rawInput("{\"args\":{}}").createdAt(Instant.now()).updatedAt(Instant.now()).build();
    }

    /** 用 {@link StaticListableBeanFactory} 造 provider：生产里这些依赖都是延迟取用的。 */
    private static <T> ObjectProvider<T> provider(Class<T> type, T value) {
        return new StaticListableBeanFactory(Map.of("value", value)).getBeanProvider(type);
    }
}
