package com.summit.dp.tools.baseTools.sub_agent;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.agent.application.service.AgentService;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.agent.infrastructure.agent.SubAgent;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.context.SessionContextEntity;
import com.summit.dp.team.application.service.TeamService;
import com.summit.dp.team.application.vo.TeamVO;
import com.summit.dp.tools.baseTools.arguments.CallSubAgentToolArgument;
import com.summit.dp.tools.baseTools.sub_agent.delegation.DelegationRecorder;
import com.summit.dp.tools.baseTools.sub_agent.delegation.DelegationSuspensionCard;
import com.summit.dp.tools.baseTools.sub_agent.delegation.SubAgentRequestFactory;
import com.summit.dp.tools.baseTools.sub_agent.result.SubAgentResultRenderer;
import com.summit.dp.tools.baseTools.sub_agent.session.SubSessionResolver;
import com.summit.dp.tools.baseTools.sub_agent.session.SubSessionTarget;
import lombok.AllArgsConstructor;
import lombok.NonNull;
import org.springframework.stereotype.Component;

import java.io.Serializable;
import java.util.Map;
import java.util.Objects;

/**
 * 委派工具：把一段任务交给团队里的另一个 Agent，并把它的最终结果回传给指挥者。
 *
 * <p>本类只做<b>编排</b>：校验参数与成员资格 → 解析目标子会话 → 组装请求 → 登记子执行 →
 * 落账 → 执行 → 渲染结果（子执行挂起时改为登记 PROMISE 槽位，让父执行同步挂起等待子代理
 * 终态）。各块可独立理解的逻辑都落在协作者上：请求组装见 {@link SubAgentRequestFactory}，
 * 复用与建行见 {@link SubSessionResolver}，可见事实落账（映射事件 / 子轮次 / transcript）
 * 见 {@link DelegationRecorder}，挂起槽位登记见 {@link DelegationSuspensionCard}，
 * 结果渲染见 {@link SubAgentResultRenderer}。改动其中任一块都不必再读懂其余几块。</p>
 *
 * <p>编排顺序里有两处不能调换：<b>建会话行必须晚于取消校验</b>（否则被取消的委派会留下孤儿会话）；
 * <b>落账必须先建轮次再写消息</b>（消息要带 turn_id）。</p>
 */
@AllArgsConstructor
@Component
public class CallSubAgentTool implements ToolExecutor {

    private final ObjectMapper objectMapper;
    private final AgentService agentService;
    private final TeamService teamService;
    private final SubAgent subAgent;
    private final SubAgentRequestFactory requestFactory;
    private final SubSessionResolver subSessionResolver;
    private final SubAgentResultRenderer resultRenderer;
    private final SessionExecutionRegistry sessionExecutionRegistry;
    private final ModelContextService modelContextService;
    private final SessionRepository sessionRepository;
    private final DelegationSuspensionCard delegationSuspensionCard;
    private final DelegationRecorder delegationRecorder;

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        try {
            return executeDelegation(toolExecution);
        } catch (Exception e) {
            return ToolExecuteResult.err("工具执行遇到错误:" + e);
        }
    }

    /** 入口编排：把模型参数校验成「可执行的委派」，任何一步不成立都在这里就地收口。 */
    private ToolExecuteResult executeDelegation(ToolExecution toolExecution) throws JsonProcessingException {
        String args = toolExecution.getArgs();
        if (args == null || args.isBlank()) {
            return ToolExecuteResult.err("工具参数需要非空");
        }

        CallSubAgentToolArgument argument = objectMapper.readValue(args, CallSubAgentToolArgument.class);
        ToolExecuteResult argumentError = validateArgument(argument);
        if (argumentError != null) {
            return argumentError;
        }

        String workDir = resolveWorkDir(argument, toolExecution);
        Long teamId = resolveTeamId(toolExecution);
        if (teamId == null) {
            return ToolExecuteResult.err("未确定当前协作团队，无法委派任务");
        }

        Long agentId = argument.getAgentId();
        AgentVO agent = agentService.findById(agentId).getData();
        if (agent == null) {
            return ToolExecuteResult.err("未找到指定的Agent: " + agentId);
        }
        if (agent.getModelId() == null) {
            return ToolExecuteResult.err("子 Agent 未配置模型，请先为该 Agent 绑定模型");
        }

        TeamVO team = teamService.findById(teamId).getData();
        if (team == null) {
            return ToolExecuteResult.err("未找到指定的团队: " + teamId);
        }
        ToolExecuteResult membershipError = validateMembership(agentId, team);
        if (membershipError != null) {
            return membershipError;
        }

        return executeChild(toolExecution, argument, agent, team, workDir);
    }

    private static ToolExecuteResult validateArgument(CallSubAgentToolArgument argument) {
        if (argument.getAgentId() == null) {
            return ToolExecuteResult.err("未说明唤醒的Agent角色信息");
        }
        if (argument.getTask() == null || argument.getTask().isBlank()) {
            return ToolExecuteResult.err("未说明需要委派的具体任务");
        }
        return null;
    }

    private static String resolveWorkDir(CallSubAgentToolArgument argument, ToolExecution toolExecution) {
        String workDir = argument.getWorkDir();
        return workDir == null || workDir.isBlank() ? toolExecution.getWorkspace().workDir() : workDir;
    }

    private static ToolExecuteResult validateMembership(Long agentId, TeamVO team) {
        if (Objects.equals(agentId, team.getCommanderAgentId())) {
            return ToolExecuteResult.err("不能委派任务给自己");
        }
        boolean memberExists = team.getAgents() != null && team.getAgents().stream()
                .anyMatch(agent -> agent != null && Objects.equals(agent.getId(), agentId));
        return memberExists ? null : ToolExecuteResult.err("指定的团队中不包含该Agent: " + agentId);
    }

    /**
     * 启动子执行并把结果渲染回调用方。
     *
     * <p>「优先复用」的编排落点：先解析目标子会话（命中则连历史一起拿到），只有在
     * {@link #sessionExecutionRegistry} 确认未被取消之后，才为首派创建会话行。</p>
     */
    private ToolExecuteResult executeChild(ToolExecution toolExecution, CallSubAgentToolArgument argument,
                                           AgentVO agent, TeamVO team, String workDir) {
        Long rootSessionId = sessionIdOf(toolExecution);
        Long parentWorkspaceId = parentWorkspaceIdOf(rootSessionId);

        SubSessionTarget target = subSessionResolver.resolve(rootSessionId, agent);
        Long numericSubSessionId = target.numericSubSessionId();

        AgentRequest request = requestFactory.build(argument, agent, team, toolExecution, workDir,
                target.subSessionId(), parentWorkspaceId, target.priorMessages());
        argument.setSubSessionId(target.subSessionId());

        if (!sessionExecutionRegistry.registerChild(rootSessionId, numericSubSessionId, Thread.currentThread())) {
            return ToolExecuteResult.err("主会话已停止，取消启动子Agent");
        }
        try {
            // 首次委派才建会话行；复用会话行已存在
            if (!target.reused()) {
                subSessionResolver.createSubSession(numericSubSessionId, rootSessionId, parentWorkspaceId, agent,
                        argument.getTask());
            }

            delegationRecorder.record(rootSessionId, toolExecution, request,
                    numericSubSessionId, target.subSessionId(), agent, argument.getTask());

            Execution execution = SessionContextEntity.runWithSubSession(rootSessionId, agent.getId(),
                    () -> subAgent.execute(request));

            modelContextService.replace(numericSubSessionId, execution.getMessages());

            // 子执行挂起（等人工审批）→ 父执行以 PROMISE 槽位**同步挂起**：挂起沿委派链传播，
            // 根会话不提前收尾。子执行终态后由 DelegationBackfillListener 回填结果并恢复父执行。
            if (execution.getExecutionState() == ExecutionState.SUSPENDED) {
                return delegationSuspensionCard.suspendAsPromise(toolExecution, target.subSessionId(), execution.getId(),
                        agent.getName(), argument.getTask());
            }

            return ToolExecuteResult.success(resultRenderer.render(execution));
        } finally {
            sessionExecutionRegistry.unregisterChild(rootSessionId, numericSubSessionId);
        }
    }

    /** 父会话绑定的工作空间：子执行在 workDir 落空时回落到它，保证不静默放行无工作空间的子执行。 */
    private Long parentWorkspaceIdOf(Long rootSessionId) {
        if (rootSessionId == null) {
            return null;
        }
        return sessionRepository.findById(rootSessionId)
                .map(Session::getWorkspaceId)
                .orElse(null);
    }

    /**
     * 团队 ID 随 AgentRequest attributes 流动（框架序列化进执行快照，恢复后原样回来），
     * 这里从工具执行上下文读取；{@code toString} 转换兼容快照 JSON 往返后的 String/数值形态。
     */
    private Long resolveTeamId(ToolExecution toolExecution) {
        Map<String, Object> attributes = toolExecution == null ? null : toolExecution.getAttributes();
        return ExecutionAttributes.readLong(attributes, ExecutionAttributes.TEAM_ID);
    }

    /** 工具执行上下文里的会话 ID：委派工具由此得知自己属于哪个根会话。 */
    private static Long sessionIdOf(ToolExecution toolExecution) {
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
