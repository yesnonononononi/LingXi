package com.summit.dp.shared.context;

import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.shared.config.workflow.AgentAccessMode;
import com.summit.dp.shared.config.workflow.CommandApprovalPolicy;

import java.util.HashMap;
import java.util.Map;

/**
 * 显式执行上下文：一次请求/一次子任务的身份与运行环境。
 *
 * <p><b>设计意图</b>：替代原先经 ThreadLocal 隐式传播的身份信息。
 * 它以参数/attributes 形式随调用链流动，在线程池、ForkJoin、子 Agent 线程上均有效，
 * 因此不再需要「哪个线程」这个前提。</p>
 *
 * <p><b>无用户字段</b>：本地单实例下不存在账号归属，禁止用任何常量冒充用户。</p>
 */
public record ExecutionContext(
        /* 会话 ID（业务主键）。根任务与子任务各有自己的会话行。 */
        long sessionId,
        /* 根会话 ID。根任务等于 sessionId；子任务指向委派发起方。 */
        long rootSessionId,
        /* 执行 ID（框架侧，字符串，雪花）；prepare 阶段尚未生成时为 null。 */
        String executionId,
        /* 根执行 ID。根任务为 null。 */
        String rootExecutionId,
        /* 绑定的工作空间 ID；无工作空间为 null。 */
        Long workspaceId,
        /* 本次生效的模型配置 ID；可为 null（走兜底）。 */
        Long modelConfigId,
        /* 生效的访问权限档位。 */
        AgentAccessMode accessMode,
        /* 生效的命令审批档位。 */
        CommandApprovalPolicy approvalPolicy
) {

    /** 根任务上下文：rootSessionId 即 sessionId，rootExecutionId 为 null。 */
    public static ExecutionContext root(long sessionId, String executionId,
                                        Long workspaceId, Long modelConfigId,
                                        AgentAccessMode mode, CommandApprovalPolicy policy) {
        return new ExecutionContext(sessionId, sessionId, executionId, null,
                workspaceId, modelConfigId, mode, policy);
    }

    /** 派生：补齐执行 ID（{@code buildRequest} 生成雪花 ID 后的不可变更新）。 */
    public ExecutionContext withExecutionId(String executionId) {
        return new ExecutionContext(sessionId, rootSessionId, executionId, rootExecutionId,
                workspaceId, modelConfigId, accessMode, approvalPolicy);
    }

    /** 子任务上下文：回指父任务的根会话与根执行。 */
    public ExecutionContext child(long childSessionId, String childExecutionId, Long childWorkspaceId,
                                  Long childModelConfigId, AgentAccessMode mode, CommandApprovalPolicy policy) {
        return new ExecutionContext(childSessionId, this.rootSessionId, childExecutionId, this.executionId,
                childWorkspaceId, childModelConfigId, mode, policy);
    }

    /**
     * 写入框架 attributes 的稳定键。
     *
     * <p>值为 null 的可选项（executionId / rootExecutionId / workspaceId / modelConfigId）
     * 直接跳过：attributes 会被 {@code Map.copyOf} 收敛，不接受 null 值。</p>
     */
    public Map<String, Object> toAttributes() {
        Map<String, Object> attributes = new HashMap<>();
        attributes.put(ExecutionAttributes.SESSION_ID, String.valueOf(sessionId));
        if (rootExecutionId != null) {
            attributes.put(ExecutionAttributes.ROOT_EXECUTION_ID, rootExecutionId);
        }
        if (workspaceId != null) {
            attributes.put(ExecutionAttributes.WORKSPACE_ID, workspaceId.toString());
        }
        if (modelConfigId != null) {
            attributes.put(ExecutionAttributes.MODEL_CONFIG_ID, modelConfigId.toString());
        }
        attributes.putAll(AgentAccessMode.toAttributes(accessMode));
        attributes.putAll(CommandApprovalPolicy.toAttributes(approvalPolicy));
        return Map.copyOf(attributes);
    }
}
