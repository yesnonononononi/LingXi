package com.summit.dp.agent.application.service.impl;

import com.summit.core.conf.ModelConfig;
import com.summit.core.conversation.message.Message;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.shared.config.workflow.AgentAccessMode;
import com.summit.dp.shared.config.workflow.CommandApprovalPolicy;
import com.summit.dp.shared.context.ExecutionContext;
import com.summit.dp.shared.vo.SessionVO;

import java.util.List;

/**
 * 一次运行需要的上下文：执行身份、会话、工作区、模型，以及决定工具清单与命令放行的业务档位。
 * <p>身份不再走 ThreadLocal（HC-1），由 {@link ExecutionContext} 显式随 RuntimeContext 传播。</p>
 *
 * @param executionContext 执行身份（会话/根会话/执行 ID/工作空间/模型/档位）
 * @param agentId          本次绑定的 Agent（编排回落后的有效值；下行进 ExecutionAttributes.AGENT_ID）
 * @param teamId           团队模式标识；null 表示非团队会话（分支依据，替代原 command.teamId()）
 * @param session          会话视图（一定非 null：prepare 内含建会话）
 */
public record RuntimeContext(
        ExecutionContext executionContext,
        Long agentId,
        Long teamId,
        SessionVO session,
        List<Message> messageList,
        WorkspaceSpec workspace,
        ModelConfig modelConfig,
        AgentAccessMode accessMode,
        CommandApprovalPolicy commandApprovalPolicy,
        boolean requirePlan
) {

}
