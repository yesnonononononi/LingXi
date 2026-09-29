package com.summit.dp.shared.context;

import com.summit.dp.shared.config.workflow.AgentAccessMode;
import com.summit.dp.shared.config.workflow.CommandApprovalPolicy;
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
        String reasoningEffort
) {
}
