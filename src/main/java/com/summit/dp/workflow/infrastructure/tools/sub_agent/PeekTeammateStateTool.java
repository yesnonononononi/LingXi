package com.summit.dp.workflow.infrastructure.tools.sub_agent;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.session.application.service.SessionService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.team.application.service.TeamService;
import com.summit.dp.team.application.vo.TeamVO;
import com.summit.dp.workflow.infrastructure.tools.arguments.PeekTeammateStateArgument;
import lombok.NonNull;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.Optional;

/**
 * 只读地查看某个队员在本会话里的运行状态，<b>固定给指挥者</b>（队员之间互不可见）。
 *
 * <p>它<b>不唤醒</b>任何执行：队员从未被委派时只回一句「尚未被唤醒」，绝不顺手派生一个子会话
 * ——「看一眼」不能变成真的产生一条会话。唤醒只有 {@code call_sub_agent} 一条路。</p>
 */
@RequiredArgsConstructor
@Component
public class PeekTeammateStateTool extends AbstractSubAgentTool implements ToolExecutor {

    private final ObjectMapper objectMapper;
    private final SessionService sessionService;
    private final SessionRepository sessionRepository;
    private final TeamService teamService;

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        // 固定给指挥者：子执行同样带 TEAM_ID，光靠工具名单拦截挡不住配置绕过，执行层再挡一次。
        if (isSubExecution(toolExecution)) {
            return err("只有指挥者可以查看队员状态，队员之间互不可见");
        }

        Long agentId = parseAgentId(toolExecution.getArgs());
        if (agentId == null) {
            return err("查看队员状态需要 agentId 参数（数字形式）");
        }

        Long teamId = resolveTeamId(toolExecution);
        if (teamId == null) {
            return err("当前会话不属于任何团队，无法查看队员状态");
        }
        Long rootSessionId = resolveRootSessionId(toolExecution);
        if (rootSessionId == null) {
            return err("未确定当前会话，无法查看队员状态");
        }

        try {
            TeamVO team = teamService.findById(teamId).getData();
            ToolExecuteResult membershipError = validateMembership(agentId, team);
            if (membershipError != null) {
                return membershipError;
            }
            String agentName = resolveAgentName(team, agentId);

            Optional<Session> subSession = sessionRepository.findByRootAndAgent(rootSessionId, agentId);
            if (subSession.isEmpty()) {
                return success("队员 " + agentName + " 尚未被唤醒：本会话内没有它的子会话");
            }
            SessionVO vo = sessionService.findById(subSession.get().getId()).getData();
            return success("队员 " + agentName + " 当前状态: " + vo.getRunStatus()
                    + ", 最近结果: " + (vo.getLastOutcome() == null ? "无" : vo.getLastOutcome())
                    + ", 子会话: " + vo.getId());
        } catch (ClientException e) {
            // 服务层查不到是抛 ClientException（不是返回 null），这里翻译成工具回执文案。
            return err(e.getMessage());
        }
    }

    /** 子执行才带 {@code ROOT_SESSION_ID}；带它即为队员，不是指挥者。 */
    private static boolean isSubExecution(ToolExecution toolExecution) {
        Map<String, Object> attributes = toolExecution == null ? null : toolExecution.getAttributes();
        return ExecutionAttributes.readLong(attributes, ExecutionAttributes.ROOT_SESSION_ID) != null;
    }

    /** 参数是模型下发的原始 JSON，不是裸数字。 */
    private Long parseAgentId(String args) {
        if (args == null || args.isBlank()) {
            return null;
        }
        try {
            return objectMapper.readValue(args, PeekTeammateStateArgument.class).getAgentId();
        } catch (Exception e) {
            return null;
        }
    }

    private static String resolveAgentName(TeamVO team, Long agentId) {
        if (team.getAgents() != null) {
            String name = team.getAgents().stream()
                    .filter(agent -> agent != null && agentId.equals(agent.getId()))
                    .map(AgentVO::getName)
                    .filter(candidate -> candidate != null && !candidate.isBlank())
                    .findFirst()
                    .orElse(null);
            if (name != null) {
                return name;
            }
        }
        return "agent " + agentId;
    }

    @Override
    public SessionRepository sessionRepository() {
        return sessionRepository;
    }

}
