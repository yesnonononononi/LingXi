package com.summit.dp.session;

import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.session.application.service.ConversationTranscriptService;
import com.summit.dp.session.infrastructure.transcript.DatabaseConversationTranscriptSink;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class DatabaseConversationTranscriptSinkMetadataTest {
    private final ConversationTranscriptService transcript = mock(ConversationTranscriptService.class);
    private final ExecutionIdentity identity = mock(ExecutionIdentity.class);
    private final DatabaseConversationTranscriptSink sink = new DatabaseConversationTranscriptSink(transcript, identity);

    @Test
    void outputUsesSelectedTurnIdAndAuthoritativeSessionIdentity() {
        when(identity.sessionId("execution")).thenReturn(500L);
        AiMessageEntity ai = AiMessageEntity.builder().text("answer").build();

        sink.appendRound("execution", ai, List.of(), Map.of("turnId", "9007199254740995", "sessionId", "other"));

        verify(transcript).appendRound(500L, 9007199254740995L, ai, List.of());
    }

    @Test
    void legacyOutputKeepsTurnUnknownWithoutLookup() {
        when(identity.sessionId("legacy")).thenReturn(500L);
        AiMessageEntity ai = AiMessageEntity.builder().text("answer").build();

        sink.appendRound("legacy", ai, List.of());

        verify(transcript).appendRound(500L, null, ai, List.of());
    }
}
