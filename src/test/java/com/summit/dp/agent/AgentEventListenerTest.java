package com.summit.dp.agent;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.event.AgentPartialTextEvent;
import com.summit.core.conversation.event.ExecutionStartEvent;
import com.summit.core.conversation.event.ExecutionResumedEvent;
import com.summit.core.conversation.event.ToolCallEndEvent;
import com.summit.core.conversation.event.ToolCallStartEvent;
import com.summit.core.tool.ToolCallStatus;
import com.summit.dp.agent.infrastructure.listener.AgentEventListener;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.stream.application.protocol.StreamV3Event;
import com.summit.dp.stream.application.protocol.StreamV3Payloads;
import com.summit.dp.stream.application.service.EventStreamPublisher;
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
    private final EventStreamPublisher v3Publisher = mock(EventStreamPublisher.class);
    private final AgentEventListener listener =
            new AgentEventListener(objectMapper, publisher, identity, v3Publisher);

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

        verifyNoInteractions(identity, publisher, v3Publisher);
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
        when(identity.resolveRootSessionId(SESSION_ID)).thenThrow(new IllegalStateException("unknown session"));

        listener.onExecutionStart(new ExecutionStartEvent(EXECUTION_ID));

        verifyNoInteractions(publisher);
    }

    @Test
    void v3MetadataRoutesDirectlyToDirectPublisherWithoutAnyLookup() {
        // 带 rootSessionId 的元数据 = v3 执行：直投新发布器，且绝不触碰 ExecutionIdentity（零查询）。
        listener.onPartialText(new AgentPartialTextEvent("agent", EXECUTION_ID, "片段", Map.of(
                "rootSessionId", Long.toString(ROOT_SESSION_ID),
                "sessionId", Long.toString(SESSION_ID),
                "turnId", Long.toString(TURN_ID),
                "historyRevision", "3",
                "streamKey", "8001"), null));

        ArgumentCaptor<StreamV3Event> frame = ArgumentCaptor.forClass(StreamV3Event.class);
        verify(v3Publisher).publish(eq(ROOT_SESSION_ID), frame.capture());
        assertEquals("TEXT_DELTA", frame.getValue().type());
        assertEquals("8001", frame.getValue().streamKey());
        assertEquals("片段", ((StreamV3Payloads.Delta) frame.getValue().data()).delta());
        verifyNoInteractions(identity, publisher);
    }

    @Test
    void legacyMetadataWithoutRootSessionFallsBackToProjectionChain() throws Exception {
        resolveSession();

        listener.onPartialText(new AgentPartialTextEvent("agent", EXECUTION_ID, "你好",
                Map.of("turnId", Long.toString(TURN_ID)), null));

        // 未带 rootSessionId = 旧检查点：仍走 v2 路径，v3 发布器不被调用。
        verifyNoInteractions(v3Publisher);
        verifySingleIdentityResolution();
        assertEquals("PARTIAL_TEXT", publishedPayload().get("type").asText());
    }

    /**
     * 工具生命周期事件在 v3 链上不产生帧：{@code TOOL_CALL_UPDATED} 是「完整卡片 DTO」的专属通道，
     * 若框架事件也映射过去，同一条通道会出现两种载荷形状（状态字符串 vs 完整卡片），
     * 前端按 type 分派到同一 reducer 时会解析报错或静默丢字段。
     */
    @Test
    void toolLifecycleEventsProduceNoV3FrameSoCardChannelKeepsOneShape() {
        Map<String, Object> v3Metadata = Map.of(
                "rootSessionId", Long.toString(ROOT_SESSION_ID),
                "sessionId", Long.toString(SESSION_ID),
                "historyRevision", "3");

        listener.onToolCall(new ToolCallStartEvent("call_1", EXECUTION_ID, "read_file", "{}", v3Metadata));
        listener.onToolCallOutput(new ToolCallEndEvent("call_1", EXECUTION_ID, "read_file", "{}", "内容",
                v3Metadata, ToolCallStatus.COMPLETED));

        verifyNoInteractions(v3Publisher, identity, publisher);
    }

    /** 生命周期事件仍走 v3 直投，但载荷必须是具名 record，不能是临时拼的 Map。 */
    @Test
    void executionLifecycleUsesNamedPayloadRecordRatherThanMap() {
        listener.onExecutionStart(new ExecutionStartEvent(EXECUTION_ID, Map.of(
                "rootSessionId", Long.toString(ROOT_SESSION_ID),
                "sessionId", Long.toString(SESSION_ID),
                "historyRevision", "3")));

        ArgumentCaptor<StreamV3Event> frame = ArgumentCaptor.forClass(StreamV3Event.class);
        verify(v3Publisher).publish(eq(ROOT_SESSION_ID), frame.capture());
        assertEquals("EXECUTION_UPDATED", frame.getValue().type());
        assertTrue(frame.getValue().data() instanceof StreamV3Payloads.ExecutionState,
                "生命周期载荷必须是具名 record，不能是 Map —— 前端按固定 schema 解析");
    }

    private void resolveSession() {
        when(identity.sessionId(EXECUTION_ID)).thenReturn(SESSION_ID);
        when(identity.resolveRootSessionId(SESSION_ID)).thenReturn(ROOT_SESSION_ID);
    }

    private void verifySingleIdentityResolution() {
        verify(identity).sessionId(EXECUTION_ID);
        verify(identity).resolveRootSessionId(SESSION_ID);
        verifyNoMoreInteractions(identity);
    }

    private JsonNode publishedPayload() throws Exception {
        ArgumentCaptor<String> payload = ArgumentCaptor.forClass(String.class);
        verify(publisher).publish(eq(ROOT_SESSION_ID), payload.capture());
        return objectMapper.readTree(payload.getValue());
    }
}
