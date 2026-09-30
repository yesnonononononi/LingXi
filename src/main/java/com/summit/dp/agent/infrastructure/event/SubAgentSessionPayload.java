package com.summit.dp.agent.infrastructure.event;

/** Identifies the child session created for one concrete delegation tool call. */
public record SubAgentSessionPayload(
        Long rootSessionId,
        String subSessionId,
        Long agentId,
        String agentName,
        String task,
        String toolCallId
) {
    public SubAgentSessionPayload(Long rootSessionId, String subSessionId, Long agentId, String task, String toolCallId) {
        this(rootSessionId, subSessionId, agentId, null, task, toolCallId);
    }
}
