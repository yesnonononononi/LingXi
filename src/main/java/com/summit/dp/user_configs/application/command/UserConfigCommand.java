package com.summit.dp.user_configs.application.command;

/** UserConfig 应用层命令（生成骨架） */

public record UserConfigCommand(
        Long id,
        String commandApprovalPolicy,
        String accessMode,
        Integer planMaxReminders,
        Long modelId,
        Long agentId,
        boolean agentIdPresent,
        String workspaceType,
        Integer maxTokens,
        String reasoningEffort,
        String renderTheme,
        String dataDir,
        String skillDir,
        Integer teamSize,
        Long compactModelId,
        boolean compactModelIdPresent,
        String fontScale,
        boolean fontScalePresent,
        Long imageModelId,
        boolean imageModelIdPresent,
        Integer imageGenerationMaxCalls
)  {
    public UserConfigCommand(Long id, String commandApprovalPolicy, String accessMode, Integer planMaxReminders,
                             Long modelId, Long agentId, boolean agentIdPresent, String workspaceType,
                             Integer maxTokens, String reasoningEffort, String renderTheme, String dataDir,
                             String skillDir, Integer teamSize, Long compactModelId, boolean compactModelIdPresent,
                             String fontScale, boolean fontScalePresent) {
        this(id, commandApprovalPolicy, accessMode, planMaxReminders, modelId, agentId, agentIdPresent,
                workspaceType, maxTokens, reasoningEffort, renderTheme, dataDir, skillDir, teamSize,
                compactModelId, compactModelIdPresent, fontScale, fontScalePresent, null, false, null);
    }
}
