package com.summit.dp.workflow.application.input;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.workflow.application.lifecycle.ResumeTriggerType;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.application.port.ExecutionActivity;
import com.summit.dp.workflow.application.lifecycle.SuspensionGateChain;
import com.summit.dp.workflow.application.lifecycle.UserPauseSuspensionGate;
import com.summit.dp.workflow.application.lifecycle.ExecutionResumeCoordinator;
import com.summit.dp.workflow.infrastructure.lifecycle.ExecutionCoordination;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.support.StaticListableBeanFactory;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class InputWakeupServiceTest {
    private final ExecutionRepository executions = mock(ExecutionRepository.class);
    private final ExecutionActivity activity = mock(ExecutionActivity.class);
    private final InputResolver inputs = mock(InputResolver.class);
    private final InputNoticeReporter notices = mock(InputNoticeReporter.class);
    private final ExecutionResumeCoordinator resumes = mock(ExecutionResumeCoordinator.class);
    private final InputTurnContinuation continuations = mock(InputTurnContinuation.class);
    private final SessionExecutionRegistry registry = new SessionExecutionRegistry();
    private final InputWakeupService service = new InputWakeupService(provider(ExecutionRepository.class, executions),
            provider(ExecutionActivity.class, activity), inputs, new InputAutomationPolicy(registry), notices,
            provider(ExecutionResumeCoordinator.class, resumes), provider(InputTurnContinuation.class, continuations),
            new SuspensionGateChain(List.of(new UserPauseSuspensionGate())));

    @AfterEach void close() { service.close(); }

    private Execution given(ExecutionState state) {
        Execution execution = Execution.builder().id("100").executionState(state).messages(new ArrayList<>())
                .agentRequest(AgentRequest.builder().runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(Map.of(ExecutionAttributes.SESSION_ID, "10")).build()).build()).build();
        when(executions.findById("100")).thenReturn(Optional.of(execution));
        when(inputs.pendingBatchKey(execution)).thenReturn("batch-1");
        return execution;
    }

    private void check() throws Exception { service.resumeIfInputPending(100L).get(5, TimeUnit.SECONDS); }

    @Test void consumedInputNeverCreatesAnotherModelRun() throws Exception {
        Execution execution = given(ExecutionState.SUSPENDED);
        when(inputs.pendingBatchKey(execution)).thenReturn(null);
        check();
        verifyNoInteractions(resumes, continuations, notices);
    }

    @Test void activeInputIsNotRecordedAndReleaseRechecksTheCurrentFacts() throws Exception {
        Execution execution = given(ExecutionState.SUSPENDED);
        when(activity.isActive("100")).thenReturn(true);
        check();
        verifyNoInteractions(resumes);
        when(activity.isActive("100")).thenReturn(false);
        when(inputs.pendingBatchKey(execution)).thenReturn(null);
        check();
        verifyNoInteractions(resumes);
        when(inputs.pendingBatchKey(execution)).thenReturn("batch-1");
        check();
        verify(resumes).accept(100L, ResumeTriggerType.AUTO_INPUT_WAKEUP);
    }

    @Test void completedInputUsesANewTurnAndNeverResumesTheOldExecution() throws Exception {
        Execution execution = given(ExecutionState.COMPLETED);
        check();
        verify(continuations).continueTurn(execution);
        verifyNoInteractions(resumes);
    }

    @Test void failedAndCancelledInputStaysPendingAndIsReported() throws Exception {
        for (ExecutionState state : new ExecutionState[]{ExecutionState.FAILED, ExecutionState.CANCELLED}) {
            Execution execution = given(state);
            check();
            verify(notices).report(eq(execution), eq("batch-1"), anyString());
        }
        verifyNoInteractions(resumes, continuations);
    }

    @Test void completedChildKeepsTheStandardDelegationBoundary() throws Exception {
        Execution execution = given(ExecutionState.COMPLETED);
        InputAutomationPolicy.putAttribute(execution, ExecutionAttributes.ROOT_EXECUTION_ID, "99");
        check();
        verify(notices).report(eq(execution), eq("batch-1"), contains("标准委派"));
        verifyNoInteractions(resumes, continuations);
    }

    @Test void requestedCancellationWinsBeforeTerminalState() throws Exception {
        Execution execution = given(ExecutionState.SUSPENDED);
        registry.cancelRoot(10L);
        check();
        verify(notices).report(execution, "batch-1", "执行已取消");
        verifyNoInteractions(resumes, continuations);
    }

    @Test void explicitPauseAndAutomaticRoundLimitBlockAutomaticWork() throws Exception {
        Execution paused = given(ExecutionState.SUSPENDED);
        InputAutomationPolicy.putAttribute(paused, InputAutomationPolicy.USER_PAUSED, true);
        check();
        verify(notices).report(paused, "batch-1", "执行已由用户暂停");
        Execution completed = given(ExecutionState.COMPLETED);
        InputAutomationPolicy.putAttribute(completed, InputAutomationPolicy.AUTO_ROUNDS, InputAutomationPolicy.MAX_AUTO_ROUNDS);
        check();
        verify(notices).report(eq(completed), eq("batch-1"), contains("上限"));
        verifyNoInteractions(resumes, continuations);
    }

    @Test void queryFailureRetriesExactlyOnceAndNeverLooksLikeAnEmptyInbox() throws Exception {
        Execution execution = given(ExecutionState.SUSPENDED);
        when(inputs.pendingBatchKey(execution)).thenThrow(new IllegalStateException("读取失败"));
        check();
        verify(inputs, times(2)).pendingBatchKey(execution);
        verify(notices).reportQueryFailure(eq(100L), contains("读取失败"));
        verifyNoInteractions(resumes, continuations);
    }

    @Test void transientQueryFailureRecoversOnTheInlineRetry() throws Exception {
        Execution execution = given(ExecutionState.SUSPENDED);
        when(inputs.pendingBatchKey(execution)).thenThrow(new IllegalStateException("暂时失败")).thenReturn("batch-1");
        check();
        verify(resumes).accept(100L, ResumeTriggerType.AUTO_INPUT_WAKEUP);
        verifyNoInteractions(notices);
    }

    @Test void publicationGatePreventsInputFromOvertakingWaitingProjection() throws Exception {
        given(ExecutionState.SUSPENDED);
        AtomicBoolean projected = new AtomicBoolean();
        doAnswer(call -> { assertTrue(projected.get()); return null; }).when(resumes).accept(100L, ResumeTriggerType.AUTO_INPUT_WAKEUP);
        CompletableFuture<Void> check;
        synchronized (ExecutionCoordination.monitor("100")) {
            check = service.resumeIfInputPending(100L);
            assertFalse(check.isDone());
            projected.set(true);
        }
        check.get(5, TimeUnit.SECONDS);
        verify(resumes).accept(100L, ResumeTriggerType.AUTO_INPUT_WAKEUP);
    }

    private static <T> ObjectProvider<T> provider(Class<T> type, T value) {
        return new StaticListableBeanFactory(Map.of("value", value)).getBeanProvider(type);
    }
}
