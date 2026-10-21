package com.summit.dp.workflow.infrastructure.tools.arguments;

import lombok.Data;

/** 查看队员状态的工具参数。 */
@Data
public class PeekTeammateStateArgument {
    /** 目标队员的 Agent id，取自指挥者的成员名单。 */
    private Long agentId;
    /** 仅供展示，成员身份与回执名称仍以团队名单为准。 */
    private String agentName;
}
