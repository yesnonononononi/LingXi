package com.summit.dp.agent.infrastructure.event;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.shared.event.BusinessEventEnvelope;
import com.summit.dp.shared.event.SseEventPublisher;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.time.Instant;

/** Publishes the session identity before a delegated agent starts producing runtime events. */
@Slf4j
@Component
@RequiredArgsConstructor
public class SubAgentSessionEventPublisher {

    public static final String EVENT_TYPE = "SUB_AGENT_SESSION_CREATED";

    private final SseEventPublisher sseEventPublisher;
    private final ObjectMapper objectMapper;

    public void publish(String executionId, Long rootSessionId, String subSessionId,
                        Long agentId, String agentName, String task, String toolCallId) {
        if (rootSessionId == null || subSessionId == null || subSessionId.isBlank()) {
            log.warn("【sub-agent-event】skip invalid session mapping: root={}, child={}",
                    rootSessionId, subSessionId);
            return;
        }
        try {
            SubAgentSessionPayload payload = new SubAgentSessionPayload(
                    rootSessionId, subSessionId, agentId, agentName, task, toolCallId);
            BusinessEventEnvelope<SubAgentSessionPayload> envelope = new BusinessEventEnvelope<>(
                    EVENT_TYPE, executionId, rootSessionId, Instant.now(), payload);
            // 按根会话定向推送（HC-3）：入参已带 rootSessionId，子会话映射事件归入父任务。
            sseEventPublisher.publish(rootSessionId, objectMapper.writeValueAsString(envelope));
        } catch (Exception e) {
            log.warn("【sub-agent-event】failed to publish session mapping: root={}, child={}, error={}",
                    rootSessionId, subSessionId, e.getMessage());
        }
    }

    public void publish(String executionId, Long rootSessionId, String subSessionId,
                        Long agentId, String task, String toolCallId) {
        publish(executionId, rootSessionId, subSessionId, agentId, null, task, toolCallId);
    }
}
