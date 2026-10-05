package com.summit.dp.user_configs.application.command;


/** UserConfig 应用层命令（生成骨架） */

public record UserConfigCommand(
        Long id,
        String commandApprovalPolicy,
        String accessMode,
        Integer planMaxReminders,
        Long modelId,
        Long agentId,
        String workspaceType,
        Integer maxTokens,
        String reasoningEffort,
        String renderTheme
)  {

}
