package com.summit.dp.agent.application.vo;

import lombok.Data;

import java.util.List;

/** Agent 视图对象（生成骨架） */
@Data
public class AgentVO {
    private Long modelId;
    private Long id;
    private String name;
    private String description;
    private List<String> toolList;
    private String prompt;
    /** 状态: 1正常 0禁用 */
    private Integer status;
}
