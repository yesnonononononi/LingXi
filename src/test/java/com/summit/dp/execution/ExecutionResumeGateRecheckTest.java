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
import com.summit.dp.workflow.application.lifecycle.StartupFailureCloser;
import com.summit.dp.workflow.application.lifecycle.SubAgentWaitSuspensionGate;
import com.summit.dp.workflow.application.lifecycle.SubExecutionDependency;
import com.summit.dp.workflow.application.lifecycle.SuspensionGateChain;
import com.summit.dp.workflow.application.lifecycle.UnresolvedToolSuspensionGate;
import com.summit.dp.workflow.application.lifecycle.UserPauseSuspensionGate;
import com.summit.dp.workflow.application.resume.ExecutionResumeCoordinator;
import com.summit.dp.workflow.application.resume.SuspendedExecutionResumer;
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

        assertEquals(ResumeTaskState.SUPERSEDED, awaitStateWritten(),
                "门禁拦住只是「还没条件恢复」，必须作废本次请求而不是判失败");
        verify(executionControl, never()).resume(any());
        verify(executionControl, never()).fail(any(), any());
        verify(modelContextService, never()).replace(anyLong(), any());
    }

    @Test
    @DisplayName("消费端复检：用户暂停中 → 自动唤醒不得恢复，且暂停标记原样保留")
    void userPauseKeepsExecutionSuspendedAndMarkerIntact() {
        Execution execution = stubSuspendedExecution(new HashMap<>(Map.of(InputAutomationPolicy.USER_PAUSED, true)));

        coordinator.dispatch(EXECUTION_ID);

        assertEquals(ResumeTaskState.SUPERSEDED, awaitStateWritten());
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
