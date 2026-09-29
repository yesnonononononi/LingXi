package com.summit.dp.agent.application.command;

import lombok.NonNull;
import org.springframework.web.multipart.MultipartFile;

/**
 * 聊天请求命令。归属概念已删除（HC-1），身份仅由会话本身承载。
 */
public record ChatCommand(
        String input,
        Long sessionId,
        Long modelId,
        Long workspaceId,
        Long teamId,
        Long agentId,
        boolean requirePlan,
        MultipartFile imageFile,
        String imageUrl
) {
    public ChatCommand assignAgentId(Long agentId) {
        return new ChatCommand(input, sessionId, modelId, workspaceId, teamId, agentId, requirePlan, imageFile, imageUrl);
    }
}
