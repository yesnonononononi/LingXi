package com.summit.dp.agent.application.command;


import org.springframework.web.multipart.MultipartFile;

import java.util.List;

/**
 * 聊天请求命令。归属概念已删除（HC-1），身份仅由会话本身承载。
 *
 * <p>{@code teamId} 已移除：团队是会话绑定（{@code session.team_id}）的属性，本轮编排按库中
 * 记录取值，请求不再携带、也无法覆盖。换绑走 {@code SessionService#bindTeam}。</p>
 */
public record ChatCommand(
        String input,
        Long sessionId,
        Long modelId,
        Long workspaceId,
        Long messageId,
        Long agentId,
        boolean requirePlan,
        List<MultipartFile> imageFile,
        List<String> imageUrl
) {

}
