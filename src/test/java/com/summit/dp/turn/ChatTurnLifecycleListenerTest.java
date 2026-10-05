package com.summit.dp.turn;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.domain.model.ChatTurnStatus;
import com.summit.dp.turn.infrastructure.listener.ChatTurnLifecycleListener;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 生命周期端口的轮次投影：终态与结束时间**直接取回调传入的已提交执行**，
 * 不再回查执行摘要。
 *
 * <p>广播方（{@code LocalExecutionRepository}）读出执行对象时，状态与 {@code completedAt}
 * 已在内存里；本测试守住「一次映射到位、不再多查一次」这条简化。</p>
 *
 * <p>本监听器**不自行兜异常**：广播方已逐监听器捕获并继续，隔离由它负责，
 * 因此落库失败在这里按原样上抛。</p>
 */
class ChatTurnLifecycleListenerTest {

    private ChatTurnService chatTurnService;
    private ChatTurnLifecycleListener listener;

    @BeforeEach
    void setup() {
        chatTurnService = mock(ChatTurnService.class);
        listener = new ChatTurnLifecycleListener(chatTurnService);
    }

    @Test
    @DisplayName("完成回调直接读传入执行：终态与 completedAt 一次映射，用量仍传 null")
    void mapsCompletionFromPassedExecution() {
        Instant completedAt = Instant.now();

        listener.onExecutionFinished("9001", finished(ExecutionState.COMPLETED, completedAt));

        verify(chatTurnService).markTerminal("9001", ChatTurnStatus.COMPLETED, null, null, null, completedAt, null);
    }

    @Test
    @DisplayName("失败与取消同样按传入状态映射，结束时间取执行自己的 completedAt")
    void mapsFailureAndCancellation() {
        Instant failedAt = Instant.now();
        listener.onExecutionFinished("9002", finished(ExecutionState.FAILED, failedAt));
        verify(chatTurnService).markTerminal("9002", ChatTurnStatus.FAILED, null, null, null, failedAt, null);

        Instant cancelledAt = Instant.now();
        listener.onExecutionFinished("9003", finished(ExecutionState.CANCELLED, cancelledAt));
        verify(chatTurnService).markTerminal("9003", ChatTurnStatus.CANCELLED, null, null, null, cancelledAt, null);
    }

    @Test
    @DisplayName("非终态与状态缺失的终结信号一律跳过，不猜状态")
    void skipsNonTerminalAndMissingState() {
        listener.onExecutionFinished("9004", finished(ExecutionState.SUSPENDED, null));
        listener.onExecutionFinished("9005", null);

        verify(chatTurnService, never()).markTerminal(anyString(), any(), any(), any(), any(), any(), any());
    }

    @Test
    @DisplayName("挂起走 WAITING，不写结束时间")
    void suspendMarksWaiting() {
        listener.onExecutionSuspended("9006", finished(ExecutionState.SUSPENDED, null));

        verify(chatTurnService).markWaiting("9006", null);
    }

    @Test
    @DisplayName("落库失败按原样上抛：异常隔离由广播方逐监听器负责，本类不再重复兜")
    void propagatesFailuresForBroadcasterToIsolate() {
        doThrow(new IllegalStateException("db down")).when(chatTurnService)
                .markTerminal(anyString(), any(), any(), any(), any(), any(), any());
        doThrow(new IllegalStateException("db down")).when(chatTurnService).markWaiting(anyString(), any());

        assertThrows(IllegalStateException.class,
                () -> listener.onExecutionFinished("9007", finished(ExecutionState.COMPLETED, Instant.now())));
        assertThrows(IllegalStateException.class, () -> listener.onExecutionSuspended("9008", finished(ExecutionState.SUSPENDED, null)));
    }

    @Test
    @DisplayName("根身份取自执行元数据：投递按根、实体归属仍由仓储按自身会话表达")
    void threadsRootSessionFromExecutionMetadata() {
        Instant completedAt = Instant.now();
        // eventMetaData() 是派生 getter（读 agentRequest 的运行时参数），这里直接打桩取根身份。
        Execution execution = mock(Execution.class);
        when(execution.getExecutionState()).thenReturn(ExecutionState.COMPLETED);
        when(execution.getCompletedAt()).thenReturn(completedAt);
        when(execution.eventMetaData()).thenReturn(java.util.Map.of("rootSessionId", "100", "sessionId", "200"));

        listener.onExecutionFinished("9009", execution);
        listener.onExecutionSuspended("9010", execution);

        verify(chatTurnService).markTerminal("9009", ChatTurnStatus.COMPLETED, null, null, null, completedAt, 100L);
        verify(chatTurnService).markWaiting("9010", 100L);
    }

    private static Execution finished(ExecutionState state, Instant completedAt) {
        return Execution.builder()
                .id("9001")
                .agentRequest(AgentRequest.builder().build())
                .executionState(state)
                .completedAt(completedAt)
                .build();
    }
}
