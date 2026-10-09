package com.summit.dp.agent;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.Execution;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.event.AgentPartialThinkingEvent;
import com.summit.core.conversation.event.ToolCallStartEvent;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.dp.agent.application.service.ResponseStreamState;
import com.summit.dp.agent.infrastructure.listener.AgentEventListener;
import com.summit.dp.agent.infrastructure.listener.ResponseStreamLoopInterceptor;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.shared.event.SseEventPublisher;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ResponseStreamStateTest {
    private final MessageRepository messages = mock(MessageRepository.class);
    private final ResponseStreamState state = new ResponseStreamState(messages);
    private final Map<String, Object> metadata = Map.of("sessionId", "7", "turnId", "900");

    @Test
    void newThinkingUsesNextPersistedResponsePositionAndKeepsItDuringAppend() {
        UUID responseId = UUID.randomUUID();
        when(messages.countAiMessagesInTurn(7L, 900L)).thenReturn(3L);
        AgentPartialThinkingEvent event = new AgentPartialThinkingEvent("a", "e", "第一段", responseId, metadata, null);
        ResponseStreamState.Response response = state.resolve(event, responseId, 7L);
        assertEquals(3000, response.thinkingOrder());
        assertEquals(3001, response.textOrder());
        assertEquals(0, response.advance(true, "第一段"));
        assertEquals(3, state.resolve(event, responseId, 7L).advance(true, "第二段"));
        verify(messages, times(1)).countAiMessagesInTurn(7L, 900L);
    }

    @Test
    void modelRequestOrderIsVisibleBeforeSnapshotEvenWhenToolsStartInReverseOrder() {
        UUID responseId = UUID.randomUUID();
        when(messages.countAiMessagesInTurn(7L, 900L)).thenReturn(2L);
        ChatResponseEntity response = ChatResponseEntity.builder().responseId(responseId)
                .aiMessageEntity(AiMessageEntity.builder().toolCalls(List.of(
                        new ToolCallRequest("first", "tool", "{}"), new ToolCallRequest("second", "tool", "{}"))).build()).build();
        Execution execution = mock(Execution.class);
        when(execution.getId()).thenReturn("e");
        when(execution.eventMetaData()).thenReturn(metadata);
        ResponseStreamLoopInterceptor interceptor = new ResponseStreamLoopInterceptor(state);
        interceptor.onAfterModelInvoke(new LoopContext(execution, null, null, Map.of(), ignored -> { }), response);
        assertFalse(interceptor.catchErr());

        ExecutionIdentity identity = mock(ExecutionIdentity.class);
        when(identity.sessionId("e")).thenReturn(7L);
        when(identity.resolveRootSessionId(7L)).thenReturn(7L);
        SseEventPublisher publisher = mock(SseEventPublisher.class);
        AgentEventListener listener = new AgentEventListener(new ObjectMapper().findAndRegisterModules(), publisher, identity, state);
        listener.init();
        listener.onToolCall(new ToolCallStartEvent("second", "e", "tool", "{}", responseId, metadata));
        listener.onToolCall(new ToolCallStartEvent("first", "e", "tool", "{}", responseId, metadata));
        ArgumentCaptor<ObjectNode> payload = ArgumentCaptor.forClass(ObjectNode.class);
        verify(publisher, times(2)).publishBusiness(eq(7L), eq("TOOL_CALL"), payload.capture());
        assertEquals(List.of(2003, 2002), payload.getAllValues().stream().map(item -> item.get("order").asInt()).toList());
    }

    @Test
    void restoredResponseUsesItsPersistedPositionInsteadOfNextResponseCount() {
        UUID responseId = UUID.randomUUID();
        when(messages.findByResponseId(7L, responseId)).thenReturn(Optional.of(
                SessionMessage.builder().responseOrder(1).build()));
        AgentPartialThinkingEvent event = new AgentPartialThinkingEvent("a", "e", "", responseId, metadata, null);
        assertEquals(1000, state.resolve(event, responseId, 7L).thinkingOrder());
    }
}
