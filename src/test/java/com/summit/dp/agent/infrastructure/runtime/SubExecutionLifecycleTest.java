package com.summit.dp.agent.infrastructure.runtime;

import com.summit.dp.workflow.infrastructure.lifecycle.SubExecutionLifecycle;

import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.dp.workflow.infrastructure.lifecycle.SubAgentCompleteNotifier;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.workflow.application.resume.ExecutionResumeCoordinator;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

import java.util.Map;

import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.doThrow;
import org.mockito.InOrder;

/** 子执行自身的保留唤醒与协作根的结束提醒分别处理，不能把两者的执行身份混用。 */
class SubExecutionLifecycleTest {

    private static final long ROOT_SESSION_ID = 800L;
    private static final long CHILD_SESSION_ID = 555L;
    private static final long ROOT_EXECUTION_ID = 900L;

    private final SessionExecutionRegistry registry = mock(SessionExecutionRegistry.class);
    private final ExecutionResumeCoordinator resumeCoordinator = mock(ExecutionResumeCoordinator.class);
    private final ExecutionLocator executionIdentity = mock(ExecutionLocator.class);
    private final SubAgentCompleteNotifier notifier = mock(SubAgentCompleteNotifier.class);

    private final SubExecutionLifecycle lifecycle =
            new SubExecutionLifecycle(registry, resumeCoordinator, executionIdentity, notifier);

    @Test
    @DisplayName("子执行挂起：保留登记（markChildSuspended），不唤醒根")
    void childSuspendedKeepsRegistration() {
        when(executionIdentity.resolveRootSessionIdOrNull(CHILD_SESSION_ID)).thenReturn(ROOT_SESSION_ID);

        lifecycle.onSuspended(childExecution());

        InOrder order = inOrder(registry, resumeCoordinator);
        order.verify(registry).markChildSuspended(ROOT_SESSION_ID, CHILD_SESSION_ID);
        order.verify(resumeCoordinator).flushPendingWake(1234L);
        verify(resumeCoordinator, never()).accept(anyLong());
    }

    @Test
    @DisplayName("子执行终态且成为空：移除登记并唤醒协作根执行")
    void lastChildFinishedWakesRoot() {
        when(executionIdentity.resolveRootSessionIdOrNull(CHILD_SESSION_ID)).thenReturn(ROOT_SESSION_ID);
        when(registry.unregisterChild(ROOT_SESSION_ID, CHILD_SESSION_ID)).thenReturn(true);

        Execution child = childExecution();
        lifecycle.onFinished(child);

        verify(resumeCoordinator).clearPendingWake(1234L);

        InOrder order = inOrder(notifier, registry, resumeCoordinator);
        order.verify(notifier).notifyCommander(child);
        order.verify(registry).unregisterChild(ROOT_SESSION_ID, CHILD_SESSION_ID);
        order.verify(resumeCoordinator).accept(ROOT_EXECUTION_ID);
    }

    @Test
    void failedNoticeStillReleasesRegistrationAndWakesRoot() {
        when(executionIdentity.resolveRootSessionIdOrNull(CHILD_SESSION_ID)).thenReturn(ROOT_SESSION_ID);
        when(registry.unregisterChild(ROOT_SESSION_ID, CHILD_SESSION_ID)).thenReturn(true);
        Execution child = childExecution();
        doThrow(new IllegalStateException("模拟投递失败")).when(notifier).notifyCommander(child);
        lifecycle.onFinished(child);
        verify(registry).unregisterChild(ROOT_SESSION_ID, CHILD_SESSION_ID);
        verify(resumeCoordinator).accept(ROOT_EXECUTION_ID);
    }

    @ParameterizedTest
    @EnumSource(value = ExecutionState.class, names = {"COMPLETED", "CANCELLED"})
    @DisplayName("子执行成功或取消但仍有其它子在跑：移除登记但不唤醒根")
    void nonLastSuccessfulOrCancelledChildDoesNotWakeRoot(ExecutionState state) {
        when(executionIdentity.resolveRootSessionIdOrNull(CHILD_SESSION_ID)).thenReturn(ROOT_SESSION_ID);
        when(registry.unregisterChild(ROOT_SESSION_ID, CHILD_SESSION_ID)).thenReturn(false);

        lifecycle.onFinished(childExecution(state));

        verify(registry).unregisterChild(ROOT_SESSION_ID, CHILD_SESSION_ID);
        verify(resumeCoordinator, never()).accept(anyLong());
    }

    @Test
    void failedChildWakesCommanderBeforeOtherChildrenFinish() {
        when(executionIdentity.resolveRootSessionIdOrNull(CHILD_SESSION_ID)).thenReturn(ROOT_SESSION_ID);
        when(registry.unregisterChild(ROOT_SESSION_ID, CHILD_SESSION_ID)).thenReturn(false);
        Execution failed = childExecution(ExecutionState.RUNNING);
        failed.fail("模型连接失败");

        lifecycle.onFinished(failed);

        InOrder order = inOrder(notifier, registry, resumeCoordinator);
        order.verify(notifier).notifyCommander(failed);
        order.verify(registry).unregisterChild(ROOT_SESSION_ID, CHILD_SESSION_ID);
        order.verify(resumeCoordinator).accept(ROOT_EXECUTION_ID);
    }

    @Test
    void failedChildStillWakesCommanderWhenFailureNoticeCannotBeDelivered() {
        when(executionIdentity.resolveRootSessionIdOrNull(CHILD_SESSION_ID)).thenReturn(ROOT_SESSION_ID);
        when(registry.unregisterChild(ROOT_SESSION_ID, CHILD_SESSION_ID)).thenReturn(false);
        Execution failed = childExecution(ExecutionState.RUNNING);
        failed.fail("模型连接失败");
        doThrow(new IllegalStateException("邮箱不可用")).when(notifier).notifyCommander(failed);

        lifecycle.onFinished(failed);

        verify(registry).unregisterChild(ROOT_SESSION_ID, CHILD_SESSION_ID);
        verify(resumeCoordinator).accept(ROOT_EXECUTION_ID);
    }

    @Test
    @DisplayName("根执行挂起：重放保留唤醒（控制槽位已释放后的唯一时点）")
    void rootSuspendedFlushesPendingWake() {
        lifecycle.onSuspended(rootExecution());

        verify(resumeCoordinator).flushPendingWake(ROOT_EXECUTION_ID);
        verify(registry, never()).markChildSuspended(anyLong(), anyLong());
    }

    @Test
    @DisplayName("根执行终态：清理保留唤醒，防止悬挂在不再挂起的执行上")
    void rootFinishedClearsPendingWake() {
        lifecycle.onFinished(rootExecution());

        verify(resumeCoordinator).clearPendingWake(ROOT_EXECUTION_ID);
        verify(registry, never()).unregisterChild(anyLong(), anyLong());
    }

    @Test void childWithoutCollaborationRoutingStillFlushesItsOwnWake() {
        when(executionIdentity.resolveRootSessionIdOrNull(CHILD_SESSION_ID)).thenReturn(null);
        lifecycle.onSuspended(childExecution());
        verify(resumeCoordinator).flushPendingWake(1234L);
        verify(registry, never()).markChildSuspended(anyLong(), anyLong());
    }

    @Test
    @DisplayName("兜底结束事实：子执行未建立执行时移除待启动登记并唤醒根")
    void abandonChildWakesRootWhenBecameEmpty() {
        when(registry.unregisterChild(ROOT_SESSION_ID, CHILD_SESSION_ID)).thenReturn(true);

        lifecycle.abandonChild(ROOT_SESSION_ID, CHILD_SESSION_ID, ROOT_EXECUTION_ID);

        verify(registry).unregisterChild(ROOT_SESSION_ID, CHILD_SESSION_ID);
        verify(resumeCoordinator).accept(ROOT_EXECUTION_ID);
    }

    @Test
    @DisplayName("兜底结束事实：根执行 id 未知则不唤醒（不猜身份、不误唤醒）")
    void abandonChildWithoutRootExecutionIdDoesNotWake() {
        when(registry.unregisterChild(ROOT_SESSION_ID, CHILD_SESSION_ID)).thenReturn(true);

        lifecycle.abandonChild(ROOT_SESSION_ID, CHILD_SESSION_ID, null);

        verify(registry).unregisterChild(ROOT_SESSION_ID, CHILD_SESSION_ID);
        verify(resumeCoordinator, never()).accept(anyLong());
    }

    private static Execution childExecution() {
        return childExecution(ExecutionState.COMPLETED);
    }

    private static Execution childExecution(ExecutionState state) {
        return Execution.builder().id("1234").executionState(state)
                .agentRequest(AgentRequest.builder()
                        .runtimeParameters(AgentRuntimeParameters.builder().attributes(Map.of(
                                ExecutionAttributes.SESSION_ID, String.valueOf(CHILD_SESSION_ID),
                                ExecutionAttributes.ROOT_SESSION_ID, String.valueOf(ROOT_SESSION_ID),
                                ExecutionAttributes.ROOT_EXECUTION_ID, String.valueOf(ROOT_EXECUTION_ID)))
                                .build())
                        .build())
                .build();
    }

    private static Execution rootExecution() {
        return Execution.builder().id(String.valueOf(ROOT_EXECUTION_ID))
                .agentRequest(AgentRequest.builder()
                        .runtimeParameters(AgentRuntimeParameters.builder().attributes(Map.of(
                                ExecutionAttributes.SESSION_ID, String.valueOf(ROOT_SESSION_ID)))
                                .build())
                        .build())
                .build();
    }
}
