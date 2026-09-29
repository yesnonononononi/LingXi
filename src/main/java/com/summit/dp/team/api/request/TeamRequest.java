package com.summit.dp.team.api.request;

import lombok.Data;

import java.util.List;

/** Team 接口层入参 */
@Data
public class TeamRequest {
    private Long id;
    /** 团队名称 */
    private String name;
    /** 团队描述 */
    private String description;
    /** 指挥者 Agent ID（必填，且必须是团队成员之一） */
    private Long commanderAgentId;
    /** 团队成员 Agent ID 列表（含指挥者） */
    private List<Long> agentIds;
}
