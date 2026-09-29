package com.summit.dp.team.application.service.impl;

import com.summit.dp.agent.application.service.AgentService;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.agent.domain.model.Agent;
import com.summit.dp.shared.model.ToolCatalog;
import com.summit.dp.team.application.command.TeamCommand;
import com.summit.dp.team.domain.model.Team;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.function.Function;
import java.util.stream.Collectors;

/** Team 新增/更新的业务校验。 */
@Component
@RequiredArgsConstructor
@Slf4j
public class TeamValidator {

    private final AgentService agentService;

    /** 团队容量上限，默认与 {@link Team#MAX_MEMBER_SIZE} 一致 */
    @Value("${lingxi.team.max-member-size:10}")
    private int maxMemberSize;

    /** @return null 表示校验通过，否则为错误提示 */
    public String validateForCreate(TeamCommand command) {
        if (command == null) return "新增参数不能为空";

        String nameError = checkName(command.getName());
        if (nameError != null) return nameError;

        String descError = checkDescription(command.getDescription());
        if (descError != null) return descError;

        return checkMembers(command.getCommanderAgentId(), command.getAgentIds());
    }

    /** @return null 表示校验通过，否则为错误提示 */
    public String validateForUpdate(TeamCommand command) {
        if (command == null) return "更新参数不能为空";
        if (command.getId() == null) return "id不能为空";

        if (command.getName() != null) {
            String nameError = checkName(command.getName());
            if (nameError != null) return nameError;
        }
        if (command.getDescription() != null) {
            String descError = checkDescription(command.getDescription());
            if (descError != null) return descError;
        }
        if (command.getCommanderAgentId() != null || command.getAgentIds() != null) {
            return checkMembers(command.getCommanderAgentId(), command.getAgentIds());
        }
        return null;
    }

    private String checkName(String name) {
        if (name == null || name.isBlank()) return "团队名称不能为空";
        if (name.trim().length() > Team.NAME_MAX_LENGTH)
            return "团队名称长度不能超过" + Team.NAME_MAX_LENGTH;
        return null;
    }

    private String checkDescription(String description) {
        if (description != null && description.trim().length() > Team.MAX_DESCRIPTION_LENGTH) {
            return "团队描述长度不能超过" + Team.MAX_DESCRIPTION_LENGTH;
        }
        return null;
    }

    /** 校验团队组成：指挥者必填且属于成员、成员数量受容量限制、成员 Agent 必须存在且可用、 除指挥者外任何成员都不允许持有委派工具。 */
    private String checkMembers(Long commanderAgentId, List<Long> agentIds) {
        if (commanderAgentId == null) return "团队必须指定指挥者 Agent";
        if (agentIds == null || agentIds.isEmpty()) return "团队必须指定成员 Agent";

        List<Long> distinct = agentIds.stream().filter(Objects::nonNull).distinct().toList();
        if (distinct.size() != agentIds.size()) return "团队成员不允许重复";
        if (distinct.isEmpty()) return "团队必须指定成员 Agent";
        if (distinct.size() > maxMemberSize)
            return "团队成员数量不能超过 " + maxMemberSize + " 个，当前 " + distinct.size() + " 个";
        if (!distinct.contains(commanderAgentId)) return "指挥者必须属于团队成员";

        List<AgentVO> agents = agentService.queryIn(distinct).getData();
        if (agents == null) agents = List.of();
        Map<Long, AgentVO> found = agents.stream()
                .filter(agent -> agent != null && agent.getId() != null)
                .collect(Collectors.toMap(AgentVO::getId, Function.identity(), (a, b) -> a));

        List<Long> missing = distinct.stream().filter(id -> !found.containsKey(id)).toList();
        if (!missing.isEmpty()) return "以下 Agent 不存在: " + missing;

        for (Long id : distinct) {
            AgentVO agent = found.get(id);
            String nameError = checkAgentEnabled(agent);
            if (nameError != null) return nameError;
            if (id.equals(commanderAgentId)) continue;
            String delegationError = checkNoDelegationTool(agent);
            if (delegationError != null) return delegationError;
        }
        return null;
    }

    private String checkAgentEnabled(AgentVO agent) {
        if (agent.getStatus() != null && agent.getStatus() != Agent.STATUS_ENABLED)
            return "Agent[" + agent.getId() + "] 已禁用，不能加入团队";
        return null;
    }

    private String checkNoDelegationTool(AgentVO agent) {
        List<String> toolList = agent.getToolList();
        if (toolList == null) return null;
        for (String tool : toolList) {
            if (tool != null && ToolCatalog.CALL_SUB_AGENT.equals(tool.trim()))
                return "Agent[" + agent.getId() + ":" + agent.getName() + "] 不允许持有委派工具 "
                        + ToolCatalog.CALL_SUB_AGENT + "，该工具仅属于指挥者";
        }
        return null;
    }
}
