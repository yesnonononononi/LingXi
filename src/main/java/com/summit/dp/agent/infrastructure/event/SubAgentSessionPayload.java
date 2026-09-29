package com.summit.dp.agent.infrastructure.event;

/** Identifies the child session created for one concrete delegation tool call. */
public record SubAgentSessionPayload(
        Long rootSessionId,
        String subSessionId,
        Long agentId,
        String task,
        String toolCallId
) {
}
