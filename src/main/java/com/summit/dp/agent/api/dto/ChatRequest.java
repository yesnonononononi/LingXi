package com.summit.dp.agent.api.dto;

import org.springframework.web.multipart.MultipartFile;

public record ChatRequest(
        String input,
        Long sessionId,
        String workDir,
        Long teamId,
        Long modelId,
        Long workspaceId,
        /* 直接指定单个 Agent 聊天时的 Agent ID；团队模式无需传（由编排器取指挥者）。 */
        Long agentId,
        /* 本次请求是否要计划能力：true 才把计划工具随请求下发给模型。 */
        Boolean requirePlan,
        /* 前端以 multipart/form-data 上传的原始图片。 */
        MultipartFile image,
        /* 兼容已有的 URL/Data URL 调用方；新前端优先传 image。 */
        String imageUrl
) {
}
