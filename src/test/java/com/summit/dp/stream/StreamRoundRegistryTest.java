package com.summit.dp.stream;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.dp.stream.application.projection.StreamRoundRegistry;
import com.summit.dp.stream.application.protocol.StreamOperation;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class StreamRoundRegistryTest {
    private final ObjectMapper json = new ObjectMapper();
    private final StreamRoundRegistry registry = new StreamRoundRegistry(json);
    private StreamOperation accept(String execution, String type, String text) {
        ObjectNode event = json.createObjectNode().put("executionId", execution).put("type", type).put("content", text).put("text", text);
        return registry.accept("1", "7", "1", event).getFirst();
    }
    @Test void completionAiMessageAndTranscriptShareIdentityAndRollbackCanRetry() {
        String key = accept("11", "PARTIAL_TEXT", "相同回答").payload().path("message").path("streamKey").asText();
        assertEquals(key, accept("11", "COMPLETE_TEXT", "相同回答").payload().path("message").path("streamKey").asText());
        assertEquals(key, accept("11", "AI_MESSAGE", "相同回答").payload().path("message").path("streamKey").asText());
        AiMessageEntity message = AiMessageEntity.builder().text("相同回答").build();
        StreamRoundRegistry.Reservation reserved = registry.reserve("11", message);
        registry.release(reserved);
        StreamRoundRegistry.Reservation retried = registry.reserve("11", message);
        assertEquals(key, retried.streamKey()); registry.committed(retried); registry.release(reserved);
        assertEquals(key, registry.reserve("11", message).streamKey());
        assertNotEquals(key, accept("11", "PARTIAL_TEXT", "相同回答").payload().path("message").path("streamKey").asText());
        assertNotEquals(key, accept("12", "PARTIAL_TEXT", "相同回答").payload().path("message").path("streamKey").asText());
    }
    @Test void suspensionInterruptsOnlyUnreturnedOutputAndResumeAllocatesNewKey() {
        String key = accept("11", "PARTIAL_TEXT", "未完成").payload().path("message").path("streamKey").asText();
        StreamOperation interrupted = accept("11", "EXECUTION_SUSPENDED", "");
        assertTrue(interrupted.payload().path("message").path("interrupted").asBoolean());
        assertNotEquals(key, accept("11", "PARTIAL_TEXT", "恢复后").payload().path("message").path("streamKey").asText());
    }
}
