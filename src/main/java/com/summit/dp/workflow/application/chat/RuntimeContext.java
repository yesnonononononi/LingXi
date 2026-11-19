package com.summit.dp.workflow.application.chat;

import com.summit.core.agent.Execution;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.user_configs.application.policy.AgentPermissionMode;

import java.util.List;

/**
 * 一次运行需要的上下文：执行身份、会话、工作区、模型，以及决定工具清单与命令放行的业务档位。
 * <p>身份不再走 ThreadLocal（HC-1），由 {@link ExecutionContext} 显式随 RuntimeContext 传播。</p>
 *
 * @param resendSnapshot 重发专用：目标轮次当时的系统提示词与记忆段；普通请求为 {@code null}
 */
public record RuntimeContext(
        ExecutionContext executionContext,
        Long agentId,
        Long teamId,
        SessionVO session,
        List<Message> messageList,
        WorkspaceSpec workspace,
        ModelConfig modelConfig,
        AgentPermissionMode permissionMode,
        boolean requirePlan,
        UserMessageEntity pendingUserMessage,
        Long turnId,
        Execution execution,
        boolean vision,
        ResendSnapshot resendSnapshot
) {
    /** 受理前的便捷构造器：turnId 与 execution 都还没有。 */
    public RuntimeContext(ExecutionContext executionContext, Long agentId, Long teamId,
                          SessionVO session, List<Message> messageList, WorkspaceSpec workspace,
                          ModelConfig modelConfig, AgentPermissionMode permissionMode,
                          boolean requirePlan, UserMessageEntity pendingUserMessage) {
        this(executionContext, agentId, teamId, session, messageList, workspace, modelConfig,
                permissionMode, requirePlan, pendingUserMessage, null, null, false, null);
    }

    public RuntimeContext(ExecutionContext executionContext, Long agentId, Long teamId,
                          SessionVO session, List<Message> messageList, WorkspaceSpec workspace,
                          ModelConfig modelConfig, AgentPermissionMode permissionMode,
                          boolean requirePlan, UserMessageEntity pendingUserMessage, boolean vision) {
        this(executionContext, agentId, teamId, session, messageList, workspace, modelConfig,
                permissionMode, requirePlan, pendingUserMessage, null, null, vision, null);
    }

    public RuntimeContext withTurnId(Long turnId) {
        return new RuntimeContext(executionContext, agentId, teamId, session, messageList,
                workspace, modelConfig, permissionMode, requirePlan,
                pendingUserMessage, turnId, execution, vision, resendSnapshot);
    }

    public RuntimeContext withExecution(Execution execution) {
        return new RuntimeContext(executionContext, agentId, teamId, session, messageList,
                workspace, modelConfig, permissionMode, requirePlan,
                pendingUserMessage, turnId, execution, vision, resendSnapshot);
    }

    /** 重发：挂上目标轮次的上下文规格，其余字段原样不动。 */
    public RuntimeContext withResendSnapshot(ResendSnapshot resendSnapshot) {
        return new RuntimeContext(executionContext, agentId, teamId, session, messageList,
                workspace, modelConfig, permissionMode, requirePlan,
                pendingUserMessage, turnId, execution, vision, resendSnapshot);
    }
}
