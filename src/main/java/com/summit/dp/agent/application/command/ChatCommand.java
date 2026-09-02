package com.summit.dp.agent.application.command;

/**
 * 聊天命令。
 *
 * @param input       用户输入
 * @param sessionId   会话 id（必传；续聊场景后端按会话绑定的工作空间续接）
 * @param workDir     可选，新建工作空间时使用的目录：docker 为容器内绝对路径(缺省 /workspace)，local 为主机绝对路径(必填)
 * @param workspaceId 可选，显式指定工作空间（优先级高于会话绑定）；为空时沿用会话绑定，无绑定则自动新建
 */
public record ChatCommand(
        String input,
        Long sessionId,
        String workDir,
        Long workspaceId
) {
}
