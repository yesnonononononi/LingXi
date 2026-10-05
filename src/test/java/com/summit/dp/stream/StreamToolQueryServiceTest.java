package com.summit.dp.stream;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.stream.application.service.*;
import com.summit.dp.stream.application.protocol.*;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.Optional;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class StreamToolQueryServiceTest {
    private final ObjectMapper json = new ObjectMapper();
    private final ToolCallRepository tools = mock(ToolCallRepository.class);
    private final SessionRepository sessions = mock(SessionRepository.class);
    private final SessionStreamHub hub = mock(SessionStreamHub.class);
    private final StreamClientViewAssembler views = mock(StreamClientViewAssembler.class);
    private final StreamToolQueryService query = new StreamToolQueryService(tools, sessions, hub, views);
    private void owned() {
        ToolCall tool = mock(ToolCall.class); when(tool.getConversationId()).thenReturn(1L);
        when(tools.findById("call")).thenReturn(Optional.of(tool));
        when(sessions.findById(1L)).thenReturn(Optional.of(Session.builder().id(1L).rootSessionId(0L).build()));
    }
    private StreamSnapshot snapshot(List<ObjectNode> cards) {
        return new StreamSnapshot("epoch", "20", "1", new StreamSnapshot.Scope(List.of("1"), List.of(), List.of(), true, false),
                List.of(), List.of(), List.of(), List.of(), cards);
    }
    @Test void currentCardUsesExecutionVersionAndProjectionStampFromHub() {
        owned(); ObjectNode card = json.createObjectNode().put("id", "call").put("version", "10")
                .put("executionVersion", "11").put("projectionStamp", "epoch:20"); card.putArray("allowedActions");
        when(hub.snapshot(1L)).thenReturn(snapshot(List.of(card)));
        StreamToolProjection result = query.findById("call").orElseThrow();
        assertFalse(result.persistentOnly()); assertEquals("epoch:20", result.toolCall().path("projectionStamp").asText());
        verifyNoInteractions(views);
    }
    @Test void historicalCardCannotOverwriteLiveActionsWithUnversionedDatabaseView() {
        owned(); when(hub.snapshot(1L)).thenReturn(snapshot(List.of()));
        ObjectNode stale = json.createObjectNode().put("id", "call").put("version", "1").put("unavailableReason", "旧原因");
        stale.putArray("allowedActions").add("APPROVE"); when(views.tool(any())).thenReturn(stale);
        StreamToolProjection result = query.findById("call").orElseThrow();
        assertTrue(result.persistentOnly()); assertFalse(result.toolCall().has("allowedActions"));
        assertFalse(result.toolCall().has("unavailableReason")); assertEquals("1", result.historyRevision());
    }
}
