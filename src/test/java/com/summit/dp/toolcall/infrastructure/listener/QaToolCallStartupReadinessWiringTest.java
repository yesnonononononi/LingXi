package com.summit.dp.toolcall.infrastructure.listener;

import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.toolcall.application.service.ToolCallReadinessService;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 独立验证（QA）：{@link ToolCallStartupReadinessListener#reconcile()} 的启动收紧<b>接线</b>覆盖。
 *
 * <p>历史上本类还断言监听器对 {@code DelegationSlotStartupReconciler} 的调用。委派槽位兼容层
 * 删除后，收口器与其接线一并移除，本类只保留监听器自身的语义断言：无未决执行时零副作用、
 * SUSPENDED 执行走 {@code markReady}、终态执行走 {@code cancelPendingToolCalls}。</p>
 */
class QaToolCallStartupReadinessWiringTest {

    private final ToolCallRepository tools = mock(ToolCallRepository.class);
    private final ExecutionRepository executions = mock(ExecutionRepository.class);
    private final ToolCallReadinessService readiness = mock(ToolCallReadinessService.class);
    private final ToolCallService service = mock(ToolCallService.class);

    private ToolCallStartupReadinessListener listener;

    @BeforeEach
    void setup() {
        listener = new ToolCallStartupReadinessListener(tools, executions, readiness, service);
    }

    @Test
    @DisplayName("W1 无未决执行时：reconcile() 零副作用")
    void w1NoSideEffectsWhenNoUnresolvedExecutions() {
        when(tools.listUnresolvedExecutionIds()).thenReturn(List.of());

        listener.reconcile();

        verifyNoInteractions(executions, readiness, service);
    }

    @Test
    @DisplayName("W2 有 SUSPENDED 执行时：markReady 就绪校准，不取消")
    void w2SuspendedExecutionIsMarkedReady() {
        when(tools.listUnresolvedExecutionIds()).thenReturn(List.of(100L));
        when(executions.findList(List.of(100L))).thenReturn(List.of(execution(100L, ExecutionStatusCodes.SUSPENDED)));

        listener.reconcile();

        verify(readiness, times(1)).markReady("100");
        verifyNoInteractions(service);
    }

    @Test
    @DisplayName("W3 有终态执行时：cancelPendingToolCalls 收口，不 markReady")
    void w3TerminalExecutionCancelsPendingToolCalls() {
        when(tools.listUnresolvedExecutionIds()).thenReturn(List.of(200L));
        when(executions.findList(List.of(200L))).thenReturn(List.of(execution(200L, ExecutionStatusCodes.COMPLETED)));

        listener.reconcile();

        verify(service, times(1)).cancelPendingToolCalls("200");
        verifyNoInteractions(readiness);
    }

    private static Execution execution(Long id, int status) {
        Execution execution = new Execution();
        execution.setId(id);
        execution.setStatus(status);
        return execution;
    }
}
