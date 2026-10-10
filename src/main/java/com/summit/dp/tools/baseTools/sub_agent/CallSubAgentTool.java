package com.summit.dp.tools.baseTools.sub_agent;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.agent.application.service.AgentService;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.context.SessionContextEntity;
import com.summit.dp.team.application.service.TeamService;
import com.summit.dp.team.application.vo.TeamVO;
import com.summit.dp.tools.baseTools.arguments.CallSubAgentToolArgument;
import com.summit.dp.tools.baseTools.sub_agent.delegation.AsyncDelegationSubmitter;
import com.summit.dp.tools.baseTools.sub_agent.delegation.AsyncDelegationTask;
import com.summit.dp.tools.baseTools.sub_agent.delegation.SubAgentRequestFactory;
import com.summit.dp.tools.baseTools.sub_agent.result.AsyncDelegationResultRenderer;
import com.summit.dp.tools.baseTools.sub_agent.session.SubSessionResolver;
import com.summit.dp.tools.baseTools.sub_agent.session.SubSessionTarget;
import lombok.AllArgsConstructor;
import lombok.NonNull;
import org.springframework.stereotype.Component;

import java.io.Serializable;
import java.util.Map;
import java.util.Objects;

/**
 * 委派工具：把一段任务交给团队里的另一个 Agent 并<b>立即受理</b>，让指挥者继续推进本轮其它工作。
 *
 * <p>本类只做<b>请求线程内的编排</b>：校验参数与成员资格 → 解析目标子会话 → 组装请求 →
 * <b>提交前登记</b>子执行 → 提交异步任务 → 渲染受理回执。真正的建行 / 落账 / 跑子 loop 由
 * {@link AsyncDelegationSubmitter} 在异步线程内独立完成。各块可独立理解的逻辑都落在协作者上：
 * 请求组装见 {@link SubAgentRequestFactory}，复用与建行见 {@link SubSessionResolver}。</p>
 *
 * <p>只有一种运行模式（协作式异步）：委派是「先受理、后核验」——回执只是受理，交付以成员工作
 * 目录里的实际产物与验证记录为准。编排顺序里有两处不能调换：<b>组装请求必须早于登记</b>
 * （组装失败即返回错误，不产生任何登记残留）；<b>登记必须早于提交</b>（提交失败要能撤销登记，
 * 不留孤儿）。</p>
 */
@AllArgsConstructor
@Component
public class CallSubAgentTool implements ToolExecutor {

    private final ObjectMapper objectMapper;
    private final AgentService agentService;
    private final TeamService teamService;
    private final SubAgentRequestFactory requestFactory;
    private final SubSessionResolver subSessionResolver;
    private final SessionExecutionRegistry sessionExecutionRegistry;
    private final SessionRepository sessionRepository;
    /** 协作式提交：子执行专用，独立于工具线程。 */
    private final AsyncDelegationSubmitter asyncDelegationSubmitter;
    /** 受理回执渲染：结构化 JSON（英文键，禁含子代理正文）。 */
    private final AsyncDelegationResultRenderer asyncResultRenderer;

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

        return executeChildAsync(toolExecution, argument, agent, team, workDir);
    }

    /**
     * 协作式（异步）委派：只做「解析子会话 → 组装请求 → 提交前登记 → 提交」四步即返回，
     * <b>不跑子 loop</b>。
     *
     * <p>请求组装与登记都在<b>请求线程内</b>完成（只读解析，可失败即返回错误）：组装失败时尚无登记，
     * 不产生任何痕迹；登记成功而提交失败（线程池拒绝）时撤销登记，绝不留下永不结束的幽灵条目。
     * 返回结构化 JSON，让指挥者立即拿回控制权继续本轮其它工作。</p>
     */
    private ToolExecuteResult executeChildAsync(ToolExecution toolExecution, CallSubAgentToolArgument argument,
                                                AgentVO agent, TeamVO team, String workDir) {
        Long rootSessionId = sessionIdOf(toolExecution);
        Long parentWorkspaceId = parentWorkspaceIdOf(rootSessionId);

        SubSessionTarget target = subSessionResolver.resolve(rootSessionId, agent);
        Long numericSubSessionId = target.numericSubSessionId();

        AgentRequest request = requestFactory.build(argument, agent, team, toolExecution, workDir,
                target.subSessionId(), parentWorkspaceId, target.priorMessages());
        argument.setSubSessionId(target.subSessionId());

        // 提交前登记「待启动」：把「已受理但尚未开跑」这段窗口也计入「未结束」。
        if (!sessionExecutionRegistry.registerPendingChild(rootSessionId, numericSubSessionId)) {
            return ToolExecuteResult.err("主会话已停止，取消启动子Agent");
        }
        Long rootExecutionId = ExecutionAttributes.workflowExecutionId(
                toolExecution.getAttributes(), toolExecution.getExecutionId());
        try {
            asyncDelegationSubmitter.submit(new AsyncDelegationTask(rootSessionId, numericSubSessionId, parentWorkspaceId,
                    rootExecutionId, target, agent, argument, toolExecution, request));
        } catch (RuntimeException e) {
            // 线程池拒绝等提交失败：撤销登记，绝不谎报已委派（否则模型以为已委派而漏做）。
            sessionExecutionRegistry.revokeChild(rootSessionId, numericSubSessionId);
            return ToolExecuteResult.err("委派提交失败: " + e.getMessage());
        }
        return asyncResultRenderer.render(target.subSessionId(), agent.getId(), agent.getName());
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
