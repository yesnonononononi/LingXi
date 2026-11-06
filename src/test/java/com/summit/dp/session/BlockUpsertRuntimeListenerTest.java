package com.summit.dp.session;

import com.summit.core.conversation.event.ToolCallEndEvent;
import com.summit.core.conversation.event.ToolCallStartEvent;
import com.summit.core.tool.ToolCallStatus;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.model.TurnModelSnapshot;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.workflow.application.projection.TurnViewBroadcaster;
import com.summit.dp.workflow.infrastructure.listener.session.BlockUpsertRuntimeListener;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Optional;

import static org.mockito.Mockito.*;

class BlockUpsertRuntimeListenerTest {

    private final TurnViewBroadcaster broadcaster = mock(TurnViewBroadcaster.class);
    private final ChatTurnRepository turns = mock(ChatTurnRepository.class);
    private final BlockUpsertRuntimeListener listener = new BlockUpsertRuntimeListener(broadcaster, turns);

    @Test
    @DisplayName("工具开始：只按执行 ID 反查轮次，不读工具行（只读路径不额外读 CLOB）")
    void approvedCommandStartBroadcastsPersistedBlockBeforeCompletion() {
        ChatTurn turn = ChatTurn.accept(900L, 7L, null, TurnModelSnapshot.of("model", "provider", null));
        when(turns.findByExecutionId(800L)).thenReturn(Optional.of(turn));

        listener.onToolCall(new ToolCallStartEvent("command", "800", "execute_command", "{}", "101", null, 0));

        verify(broadcaster).broadcastBlockUpsert(900L, "command");
        // 归属判断只需要执行 ID：不查轮次以外的东西。
        verify(turns, times(1)).findByExecutionId(800L);
        verifyNoMoreInteractions(turns);
    }

    @Test
    @DisplayName("工具结束（非 PROMISED）：同样只反查轮次后推单块")
    void completionStillBroadcastsPersistedBlock() {
        ChatTurn turn = ChatTurn.accept(900L, 7L, null, TurnModelSnapshot.of("model", "provider", null));
        when(turns.findByExecutionId(800L)).thenReturn(Optional.of(turn));

        listener.onToolCallOutput(new ToolCallEndEvent("command", "800", "101", "execute_command",
                "{}", "完成", null, ToolCallStatus.COMPLETED, 0));

        verify(broadcaster).broadcastBlockUpsert(900L, "command");
    }

    @Test
    @DisplayName("反查不到轮次：跳过推送，不抛异常")
    void unknownExecutionIsSkipped() {
        when(turns.findByExecutionId(800L)).thenReturn(Optional.empty());

        listener.onToolCall(new ToolCallStartEvent("command", "800", "execute_command", "{}", "101", null, 0));

        verifyNoInteractions(broadcaster);
    }

    @Test
    void promisedOutputDoesNotPublishCompetingIntermediateState() {
        listener.onToolCallOutput(new ToolCallEndEvent("command", "800", "101", "execute_command",
                "{}", "等待批准", null, ToolCallStatus.PROMISED, 0));

        verifyNoInteractions(broadcaster, turns);
    }
}
