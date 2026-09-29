package com.summit.dp.team.application.command;

import lombok.Data;

import java.util.List;

/** Team 应用层命令 */
@Data
public class TeamCommand {
    private Long id;
    private String name;
    private String description;
    private Long commanderAgentId;
    private List<Long> agentIds;
}
