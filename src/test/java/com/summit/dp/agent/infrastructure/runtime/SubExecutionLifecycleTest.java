package com.summit.dp.agent.infrastructure.runtime;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.application.service.ExecutionResumeCoordinator;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * {@link SubExecutionLifecycle} 的结束事实翻译契约。
 *
 * <p>根/子共用一条通知链：子挂起保留登记、子终态移除并在「最后一个子终结」上唤醒根；
 * 根挂起重放保留唤醒、根终态清理保留唤醒。唤醒目标一律是<b>协作根执行 id</b>（子执行取
 * {@code ROOT_EXECUTION_ID}，根执行回落自身执行 id）。</p>
 */
class SubExecutionLifecycleTest {

    private static final long ROOT_SESSION_ID = 800L;
    private static final long CHILD_SESSION_ID = 555L;
    private static final long ROOT_EXECUTION_ID = 900L;

    private final SessionExecutionRegistry registry = mock(SessionExecutionRegistry.class);
    private final ExecutionResumeCoordinator resumeCoordinator = mock(ExecutionResumeCoordinator.class);
    private final ExecutionIdentity executionIdentity = mock(ExecutionIdentity.class);

    private final SubExecutionLifecycle lifecycle =
            new SubExecutionLifecycle(registry, resumeCoordinator, executionIdentity);

    @Test
    @DisplayName("子执行挂起：保留登记（markChildSuspended），不唤醒根")
    void childSuspendedKeepsRegistration() {
        when(executionIdentity.resolveRootSessionIdOrNull(CHILD_SESSION_ID)).thenReturn(ROOT_SESSION_ID);

        lifecycle.onSuspended(childExecution());

        verify(registry).markChildSuspended(ROOT_SESSION_ID, CHILD_SESSION_ID);
        verify(resumeCoordinator, never()).accept(anyLong());
        verify(resumeCoordinator, never()).flushPendingWake(anyLong());
    }

    @Test
    @DisplayName("子执行终态且成为空：移除登记并唤醒协作根执行")
    void lastChildFinishedWakesRoot() {
        when(executionIdentity.resolveRootSessionIdOrNull(CHILD_SESSION_ID)).thenReturn(ROOT_SESSION_ID);
        when(registry.unregisterChild(ROOT_SESSION_ID, CHILD_SESSION_ID)).thenReturn(true);

        lifecycle.onFinished(childExecution());

        verify(registry).unregisterChild(ROOT_SESSION_ID, CHILD_SESSION_ID);
        verify(resumeCoordinator).accept(ROOT_EXECUTION_ID);
    }

    @Test
    @DisplayName("子执行终态但仍有其它子在跑：移除登记但不唤醒根（避免无谓模型轮次）")
    void nonLastChildFinishedDoesNotWakeRoot() {
        when(executionIdentity.resolveRootSessionIdOrNull(CHILD_SESSION_ID)).thenReturn(ROOT_SESSION_ID);
        when(registry.unregisterChild(ROOT_SESSION_ID, CHILD_SESSION_ID)).thenReturn(false);

        lifecycle.onFinished(childExecution());

        verify(registry).unregisterChild(ROOT_SESSION_ID, CHILD_SESSION_ID);
        verify(resumeCoordinator, never()).accept(anyLong());
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
        return Execution.builder().id("1234")
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
