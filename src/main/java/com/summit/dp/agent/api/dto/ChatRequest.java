package com.summit.dp.agent.api.dto;

public record ChatRequest(
        String input,
        Long sessionId,
        String workDir,
        Long workspaceId
) {
}
