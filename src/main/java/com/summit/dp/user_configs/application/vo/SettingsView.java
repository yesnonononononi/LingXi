package com.summit.dp.user_configs.application.vo;

import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import com.summit.dp.user_configs.application.policy.CommandApprovalPolicy;
import com.summit.dp.shared.model.WorkspaceType;

/**
 * 单例本地设置的只读投影（{@code user_configs} 单例行）。
 *
 * <p>供基础设施类（{@code SettingsProvider} 的使用方）读取「读一项设置」，
 * 与面向前端的 {@code UserConfigVO} 解耦：这里只暴露运行时真正需要的字段，
 * 且档位字段已是类型化枚举，使用方无需再各自解析字符串。</p>
 */
public record SettingsView(
        /* 工作空间运行类型；null 表示未配置，由使用方按各自缺省兜底。 */
        WorkspaceType workspaceType,
        /* 会话访问档位；null 表示未配置。 */
        AgentAccessMode accessMode,
        /* 命令审批档位；null 表示未配置。 */
        CommandApprovalPolicy commandApprovalPolicy,
        /* 计划提醒上限；null 表示未配置。 */
        Integer planMaxReminders,
        /* 选中的模型 ID；null 表示未选择。 */
        Long modelId,
        /* 本实例全局选中的 Agent ID；null 表示未选择。 */
        Long agentId,
        /* 模型最大 Token 数；null 表示沿用模型/框架缺省。 */
        Integer maxTokens,
        /* 思考深度/推理等级；null 表示沿用模型/框架缺省。 */
        String reasoningEffort,
        /* 技能根目录的生效值（已由设置行/yaml 缺省解析过）；null 表示未启用 Skill。 */
        String skillDir,
        /* 团队规模上限的生效值（已由设置行/yaml 缺省解析过）；不会为 null。 */
        Integer teamSize,
        /* 专用压缩模型（关联 model_config.id）；null 表示沿用对话模型做摘要。 */
        Long compactModelId
) {
    /**
     * 兼容既有调用：未配置专用压缩模型（沿用对话模型做摘要）。
     *
     * <p>投影对象多一个可选字段，不该逼着每个只关心「模型/权限」的调用方也写一个 null；
     * 但新增字段时必须检查这里，别让「不传」被误读成「显式关闭」。</p>
     */
    public SettingsView(WorkspaceType workspaceType, AgentAccessMode accessMode,
                        CommandApprovalPolicy commandApprovalPolicy, Integer planMaxReminders, Long modelId,
                        Long agentId, Integer maxTokens, String reasoningEffort, String skillDir,
                        Integer teamSize) {
        this(workspaceType, accessMode, commandApprovalPolicy, planMaxReminders, modelId, agentId, maxTokens,
                reasoningEffort, skillDir, teamSize, null);
    }
}
