package com.summit.dp.agent.application.command;

import lombok.Data;

import java.util.List;

/** Agent 应用层命令 */
@Data
public class AgentCommand {
    private Long id;
    private String name;
    private Long modelId;
    private List<String> toolList;
    private String prompt;
    private String description;
}
