package com.summit.dp.agent.infrastructure.listener;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.event.AgentPartialTextEvent;
import com.summit.core.conversation.event.AgentPartialThinkingEvent;
import com.summit.core.conversation.event.ToolCallStartEvent;
import com.summit.core.runtime.RuntimeListener;
import com.summit.dp.shared.event.SseEventPublisher;
import lombok.AllArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

@Slf4j
@Component
@AllArgsConstructor
public class AgentEventListener implements RuntimeListener {
    private final ObjectMapper objectMapper;
    private final SseEventPublisher sseEventPublisher;

    @Override
    public void onPartialThinking(AgentPartialThinkingEvent event) {
        try {
            sseEventPublisher.broadcast(objectMapper.writeValueAsString(event));
        } catch (JsonProcessingException e) {
            throw new RuntimeException(e);
        }
    }

    @Override
    public void onToolCall(ToolCallStartEvent event) {
        try {
            sseEventPublisher.broadcast(objectMapper.writeValueAsString(event));
        } catch (JsonProcessingException e) {
            throw new RuntimeException(e);
        }
    }

    @Override
    public void onPartialText(AgentPartialTextEvent event) {
        try {
            sseEventPublisher.broadcast(objectMapper.writeValueAsString(event));
        } catch (JsonProcessingException e) {
            log.error("Error processing agent partial text event", e);
        }
    }
}
