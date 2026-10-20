package com.summit.dp.workflow.infrastructure.tools.sub_agent;

import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.team.application.vo.TeamVO;
import com.summit.dp.workflow.infrastructure.harness.ExecutionIdentity;

import java.io.Serializable;
import java.util.Map;
import java.util.Objects;

public abstract class AbstractSubAgentTool {





    public abstract SessionRepository sessionRepository();

    /** 父会话绑定的工作空间：子执行在 workDir 落空时回落到它，保证不静默放行无工作空间的子执行。 */
    public Long resolveParentWorkspaceId(Long rootSessionId) {
        if (rootSessionId == null) {
            return null;
        }
        return Objects.requireNonNull(sessionRepository()).findById(rootSessionId)
                .map(Session::getWorkspaceId)
                .orElse(null);
    }

    public  ToolExecuteResult validateMembership(Long agentId, TeamVO team) {
        boolean memberExists = team.getAgents() != null && team.getAgents().stream()
                .anyMatch(agent -> agent != null && Objects.equals(agent.getId(), agentId));
        return memberExists ? null : ToolExecuteResult.err("指定的团队中不包含该Agent: " + agentId);
    }
    public ToolExecuteResult err(String err){
        return ToolExecuteResult.err(err);
    }
    public ToolExecuteResult success(String output){
        return ToolExecuteResult.success(output);
    }
    /**
     * 团队 ID 随 AgentRequest attributes 流动（框架序列化进执行快照，恢复后原样回来），
     * 这里从工具执行上下文读取；{@code toString} 转换兼容快照 JSON 往返后的 String/数值形态。
     */
    public Long resolveTeamId(ToolExecution toolExecution) {
        Map<String, Object> attributes = toolExecution == null ? null : toolExecution.getAttributes();
        return ExecutionAttributes.readLong(attributes, ExecutionAttributes.TEAM_ID);
    }

    /**
     * 协作根会话 id：子执行带 {@code ROOT_SESSION_ID}，根执行回落自身 {@code SESSION_ID}。
     *
     * <p>只按属性解析、不查库；属性缺失（受理链路已坏）返回 {@code null}，不抛异常——
     * 工具要把「拿不到身份」翻译成回执文案，而不是让框架兜成一句 {@code Tool execution error}。</p>
     */
    public Long resolveRootSessionId(ToolExecution toolExecution) {
        Map<String, Object> attributes = toolExecution == null ? null : toolExecution.getAttributes();
        Long root = ExecutionAttributes.readLong(attributes, ExecutionAttributes.ROOT_SESSION_ID);
        if (root != null) {
            return root;
        }
        try {
            return resolveSessionId(toolExecution);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /** 工具执行上下文里的会话 ID：委派工具由此得知自己属于哪个根会话。 */
    public  Long resolveSessionId(ToolExecution toolExecution) {
        Serializable sessionId = toolExecution == null ? null : ExecutionIdentity.sessionId(toolExecution);
        if (sessionId == null) {
            return null;
        }
        try {
            return Long.valueOf(sessionId.toString());
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
