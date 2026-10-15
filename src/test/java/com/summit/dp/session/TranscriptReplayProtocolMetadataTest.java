package com.summit.dp.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.json.ExecutionJson;
import com.summit.dp.session.application.service.TranscriptReplayMatcher;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;

class TranscriptReplayProtocolMetadataTest {
    @Test
    void storedThinkingProtocolDataSurvivesReplayAndRejectsSignatureDrift() throws Exception {
        ObjectMapper json = ExecutionJson.newObjectMapper();
        AiMessageEntity original = AiMessageEntity.builder().text("回答").thinking("思考")
                .attributes(Map.of("thinking_signature", "signed", "redacted_thinking", List.of("opaque")))
                .build();
        SessionMessage stored = SessionMessage.builder().id(1L).sessionId(2L).turnId(3L)
                .type(SessionMessageType.AI).text(json.writeValueAsString(original)).build();
        TranscriptReplayMatcher matcher = new TranscriptReplayMatcher(json);
        AiMessageEntity restored = json.readValue(stored.getText(), AiMessageEntity.class);
        assertEquals(original.getAttributes(), restored.getAttributes());
        assertTrue(matcher.isSameRound(stored, 3L, restored));
        restored.setAttributes(Map.of("thinking_signature", "changed", "redacted_thinking", List.of("opaque")));
        assertFalse(matcher.isSameRound(stored, 3L, restored));
    }
}
