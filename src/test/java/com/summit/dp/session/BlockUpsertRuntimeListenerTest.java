package com.summit.dp.session;

import com.summit.core.conversation.event.ToolCallEndEvent;
import com.summit.core.conversation.event.ToolCallStartEvent;
import com.summit.core.tool.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.workflow.application.projection.TurnViewBroadcaster;
import com.summit.dp.workflow.infrastructure.listener.session.BlockUpsertRuntimeListener;
import org.junit.jupiter.api.Test;

import java.util.Optional;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class BlockUpsertRuntimeListenerTest {

    private final TurnViewBroadcaster broadcaster = mock(TurnViewBroadcaster.class);
    private final ToolCallRepository tools = mock(ToolCallRepository.class);
    private final ChatTurnRepository turns = mock(ChatTurnRepository.class);
    private final BlockUpsertRuntimeListener listener = new BlockUpsertRuntimeListener(broadcaster, tools, turns);

    @Test
    void approvedCommandStartBroadcastsPersistedBlockBeforeCompletion() {
        ToolCall tool = ToolCall.builder().id("command").conversationId(7L).build();
        ChatTurn turn = ChatTurn.accept(900L, 7L, null, "model", "provider");
        when(tools.findById("command")).thenReturn(Optional.of(tool));
        when(turns.findByExecutionId(800L)).thenReturn(Optional.of(turn));

        listener.onToolCall(new ToolCallStartEvent("command", "800", "execute_command", "{}", "101", null, 0));

        verify(broadcaster).broadcastBlockUpsert(900L, "command");
    }

    @Test
    void completionStillBroadcastsPersistedBlock() {
        ToolCall tool = ToolCall.builder().id("command").conversationId(7L).build();
        ChatTurn turn = ChatTurn.accept(900L, 7L, null, "model", "provider");
        when(tools.findById("command")).thenReturn(Optional.of(tool));
        when(turns.findByExecutionId(800L)).thenReturn(Optional.of(turn));

        listener.onToolCallOutput(new ToolCallEndEvent("command", "800", "101", "execute_command",
                "{}", "完成", null, ToolCallStatus.COMPLETED, 0));

        verify(broadcaster).broadcastBlockUpsert(900L, "command");
    }

    @Test
    void promisedOutputDoesNotPublishCompetingIntermediateState() {
        listener.onToolCallOutput(new ToolCallEndEvent("command", "800", "101", "execute_command",
                "{}", "等待批准", null, ToolCallStatus.PROMISED, 0));

        verifyNoInteractions(broadcaster, tools, turns);
    }
}
