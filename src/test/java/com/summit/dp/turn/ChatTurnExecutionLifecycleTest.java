package com.summit.dp.turn;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.dp.turn.application.service.impl.ChatTurnServiceImpl;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.model.ChatTurnStatus;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

/** 轮次终态取已提交执行，用量和根会话身份不能被转换逻辑改写。 */
class ChatTurnExecutionLifecycleTest {
    private final ChatTurnRepository repository = mock(ChatTurnRepository.class);
    private final ChatTurnServiceImpl service = new ChatTurnServiceImpl(repository);

    @Test
    void mapsAllTerminalStatesAndPreservesKnownUsage() {
        Instant completedAt = Instant.parse("2026-10-07T01:00:00Z");
        for (ExecutionState state : new ExecutionState[]{ExecutionState.COMPLETED, ExecutionState.FAILED, ExecutionState.CANCELLED}) {
            ChatTurn turn = ChatTurn.accept(7001L, 200L, null, "model", "provider");
            turn.attachExecution(9001L);
            turn.refreshUsage(100L, 50L, 150L);
            when(repository.findByExecutionId(9001L)).thenReturn(Optional.of(turn));

            service.finishExecution(execution(state, completedAt));

            assertEquals(ChatTurnStatus.valueOf(state.name()), turn.getStatus());
            assertEquals(completedAt, turn.getCompletedAt());
            assertEquals(150L, turn.getTotalTokenCount());
            verify(repository).updateById(turn, 100L);
        }
    }

    @Test
    void suspensionKeepsCompletionTimeEmptyAndRoutesToRootSession() {
        ChatTurn turn = ChatTurn.accept(7001L, 200L, null, "model", "provider");
        when(repository.findByExecutionId(9001L)).thenReturn(Optional.of(turn));

        service.markExecutionWaiting(execution(ExecutionState.SUSPENDED, null));

        assertEquals(ChatTurnStatus.WAITING, turn.getStatus());
        assertNull(turn.getCompletedAt());
        verify(repository).updateById(turn, 100L);
    }

    @Test
    void ignoresMissingAndNonTerminalExecutions() {
        service.finishExecution(null);
        service.finishExecution(execution(ExecutionState.SUSPENDED, null));
        service.finishExecution(execution(ExecutionState.RUNNING, null));
        verifyNoInteractions(repository);
    }

    @Test
    void storageFailuresPropagateToRepositoryCallbackIsolation() {
        when(repository.findByExecutionId(anyLong())).thenAnswer(invocation ->
                Optional.of(ChatTurn.accept(7001L, 200L, null, "model", "provider")));
        doThrow(new IllegalStateException("轮次保存失败")).when(repository).updateById(any(ChatTurn.class), eq(100L));
        assertThrows(IllegalStateException.class,
                () -> service.finishExecution(execution(ExecutionState.COMPLETED, Instant.now())));
        assertThrows(IllegalStateException.class,
                () -> service.markExecutionWaiting(execution(ExecutionState.SUSPENDED, null)));
    }

    private static Execution execution(ExecutionState state, Instant completedAt) {
        AgentRequest request = AgentRequest.builder().runtimeParameters(AgentRuntimeParameters.builder()
                .eventMetaData(Map.of("rootSessionId", "100", "sessionId", "200")).build()).build();
        return Execution.builder().id("9001").agentRequest(request)
                .executionState(state).completedAt(completedAt).build();
    }
}
