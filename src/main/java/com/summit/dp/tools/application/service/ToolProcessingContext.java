package com.summit.dp.tools.application.service;

import com.summit.core.conf.McpConfig;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import lombok.Builder;

import java.nio.file.Path;

/** 主执行与子执行显式携带能力、身份和档位，工具规则不再反查全局设置。 */
@Builder
public record ToolProcessingContext(Long agentId, Long teamId, boolean defaultAgent, boolean member, boolean vision,
                                    AgentAccessMode accessMode, boolean requirePlan,
                                    McpConfig mcpConfig, Path skillRoot) {
}
