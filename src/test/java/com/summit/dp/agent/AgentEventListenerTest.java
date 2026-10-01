package com.summit.dp.agent;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.event.AgentPartialTextEvent;
import com.summit.core.conversation.event.ExecutionStartEvent;
import com.summit.core.conversation.event.ExecutionResumedEvent;
import com.summit.dp.agent.infrastructure.listener.AgentEventListener;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.shared.event.SseEventPublisher;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.ArgumentCaptor;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;

class AgentEventListenerTest {
    private static final String EXECUTION_ID = "2105000000000000001";
    private static final long SESSION_ID = 2105000000000000002L;
    private static final long ROOT_SESSION_ID = 2105000000000000003L;
    private static final long TURN_ID = 2105000000000000004L;

    private final ObjectMapper objectMapper = new ObjectMapper().findAndRegisterModules();
    private final SseEventPublisher publisher = mock(SseEventPublisher.class);
    private final ExecutionIdentity identity = mock(ExecutionIdentity.class);
    private final AgentEventListener listener =
            new AgentEventListener(objectMapper, publisher, identity);

    @BeforeEach
    void setUp() {
        listener.init();
    }

    @Test
    void partialTextRoutesToRootWithExactSessionIdAndWithoutTurnLookup() throws Exception {
        resolveSession();

        listener.onPartialText(new AgentPartialTextEvent("agent", EXECUTION_ID, "你好",
                Map.of("turnId", Long.toString(TURN_ID)), null));

        JsonNode payload = publishedPayload();
        assertEquals(EXECUTION_ID, payload.get("executionId").asText());
        assertEquals("你好", payload.get("content").asText());
        assertEquals("PARTIAL_TEXT", payload.get("type").asText());
        assertTrue(payload.get("sessionId").isTextual());
        assertEquals(Long.toString(SESSION_ID), payload.get("sessionId").asText());
        assertTrue(payload.get("turnId").isTextual());
        assertEquals(Long.toString(TURN_ID), payload.get("turnId").asText());
        verifySingleIdentityResolution();
    }

    @Test
    void lifecycleEventIncludesExactTurnId() throws Exception {
        resolveSession();
        listener.onExecutionStart(new ExecutionStartEvent(EXECUTION_ID,
                Map.of("turnId", Long.toString(TURN_ID), "sessionId", "untrusted-session")));

        JsonNode payload = publishedPayload();
        assertTrue(payload.get("turnId").isTextual());
        assertEquals(Long.toString(TURN_ID), payload.get("turnId").asText());
        assertEquals(Long.toString(SESSION_ID), payload.get("sessionId").asText());
        verifySingleIdentityResolution();
    }

    @Test
    void resumedEventSerializesIdentityTimestampAndMetadata() throws Exception {
        resolveSession();
        listener.onExecutionResumed(new ExecutionResumedEvent(EXECUTION_ID, Map.of("turnId", TURN_ID)));

        JsonNode payload = publishedPayload();
        assertEquals(EXECUTION_ID, payload.get("executionId").asText());
        assertTrue(payload.hasNonNull("timestamp"));
        assertEquals(Long.toString(TURN_ID), payload.get("turnId").asText());
        assertTrue(payload.hasNonNull("metaData"));
    }

    @Test
    void missingTurnDoesNotPreventPublishing() throws Exception {
        resolveSession();

        listener.onExecutionStart(new ExecutionStartEvent(EXECUTION_ID));

        assertFalse(publishedPayload().has("turnId"));
    }

    @Test
    void malformedTurnMetadataDoesNotPreventPublishing() throws Exception {
        resolveSession();
        listener.onExecutionStart(new ExecutionStartEvent(EXECUTION_ID, Map.of("turnId", "invalid")));

        assertFalse(publishedPayload().has("turnId"));
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {" ", "\t"})
    void missingExecutionIdIsDroppedBeforeLookups(String executionId) {
        listener.onExecutionStart(new ExecutionStartEvent(executionId));

        verifyNoInteractions(identity, publisher);
    }

    @Test
    void unknownExecutionIsDroppedBeforeTurnLookup() {
        when(identity.sessionId(EXECUTION_ID)).thenThrow(new IllegalStateException("unknown execution"));

        listener.onExecutionStart(new ExecutionStartEvent(EXECUTION_ID));

        verifyNoInteractions(publisher);
    }

    @Test
    void unknownRootSessionIsDroppedBeforeTurnLookup() {
        when(identity.sessionId(EXECUTION_ID)).thenReturn(SESSION_ID);
        when(identity.rootSessionIdOfSession(SESSION_ID)).thenThrow(new IllegalStateException("unknown session"));

        listener.onExecutionStart(new ExecutionStartEvent(EXECUTION_ID));

        verifyNoInteractions(publisher);
    }

    private void resolveSession() {
        when(identity.sessionId(EXECUTION_ID)).thenReturn(SESSION_ID);
        when(identity.rootSessionIdOfSession(SESSION_ID)).thenReturn(ROOT_SESSION_ID);
    }

    private void verifySingleIdentityResolution() {
        verify(identity).sessionId(EXECUTION_ID);
        verify(identity).rootSessionIdOfSession(SESSION_ID);
        verifyNoMoreInteractions(identity);
    }

    private JsonNode publishedPayload() throws Exception {
        ArgumentCaptor<String> payload = ArgumentCaptor.forClass(String.class);
        verify(publisher).publish(eq(ROOT_SESSION_ID), payload.capture());
        return objectMapper.readTree(payload.getValue());
    }
}
