package com.summit.dp.workflow.application.chat;

import com.summit.core.conf.ModelConfig;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.user_configs.application.policy.AgentPermissionMode;

import java.util.List;

/**
 * 测试侧的 {@link RuntimeContext} 装配器。
 *
 * <p><b>为什么要有它</b>：{@code RuntimeContext} 按语义分了五组，但绝大多数用例只关心其中一两项
 * （「给我一个绑了工作区的上下文」「给我一个带待落库用户消息的上下文」）。若每个用例都自己写
 * {@code new RuntimeContext(identity, new AgentSelection(...), ...)}，分组带来的噪声会淹没断言本身。</p>
 *
 * <p><b>只做装配、不做缺省猜测</b>：需要什么就显式传什么；受理前的场景用
 * {@link #beforeAdmission}，需要 turnId / execution / 重发快照的用链式 {@code withXxx}。</p>
 */
public final class RuntimeContextTestSupport {

    private RuntimeContextTestSupport() {
    }

    /** 受理前的上下文：没有 turnId、没有执行、没有重发快照。 */
    public static RuntimeContext beforeAdmission(ExecutionContext identity, Long agentId, Long teamId,
                                                 SessionVO session, List<Message> messageList,
                                                 WorkspaceSpec workspace, ModelConfig modelConfig,
                                                 AgentPermissionMode permissionMode, boolean requirePlan,
                                                 UserMessageEntity pendingUserMessage, boolean vision) {
        return new RuntimeContext(
                identity,
                new RuntimeContext.AgentSelection(agentId, teamId),
                RuntimeContext.SessionBinding.beforeAdmission(session, workspace),
                new RuntimeContext.RunProfile(modelConfig, vision, permissionMode, requirePlan),
                new RuntimeContext.ContextPayload(messageList, pendingUserMessage, null));
    }

    /** 不声明识图能力的受理前上下文。 */
    public static RuntimeContext beforeAdmission(ExecutionContext identity, Long agentId, Long teamId,
                                                 SessionVO session, List<Message> messageList,
                                                 WorkspaceSpec workspace, ModelConfig modelConfig,
                                                 AgentPermissionMode permissionMode, boolean requirePlan,
                                                 UserMessageEntity pendingUserMessage) {
        return beforeAdmission(identity, agentId, teamId, session, messageList, workspace, modelConfig,
                permissionMode, requirePlan, pendingUserMessage, false);
    }

    /** 裸模型、无会话、无工作区的上下文：只验证「拿不到就按最小形态跑」的分支。 */
    public static RuntimeContext bare(ExecutionContext identity) {
        return beforeAdmission(identity, null, null, null, List.of(), null, null,
                AgentPermissionMode.FULL_ACCESS, false, null, false);
    }
}
