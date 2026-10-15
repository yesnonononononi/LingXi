package com.summit.dp.team.application.command;

import lombok.Data;

import java.util.List;

/** Team 应用层命令 */
@Data
public class TeamCommand {
    private Long id;
    private String name;
    private String description;
    /** 头像（Emoji 或图片 URL），可空 */
    private String avatar;
    private Long commanderAgentId;
    private List<Long> agentIds;
}
