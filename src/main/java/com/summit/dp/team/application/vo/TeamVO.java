package com.summit.dp.team.application.vo;

import com.summit.dp.agent.application.vo.AgentVO;
import lombok.Builder;
import lombok.Data;
import lombok.Getter;

import java.util.List;

/** Team 视图对象 */
@Builder
@Getter
public class TeamVO {
    private Long id;
    private String name;
    private String commanderName;
    private Long commanderAgentId;
    private String description;
    private List<AgentVO> agents;
}
