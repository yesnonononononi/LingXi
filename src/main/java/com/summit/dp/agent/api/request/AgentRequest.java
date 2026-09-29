package com.summit.dp.agent.api.request;

import lombok.Data;

import java.util.List;

/** Agent 接口层入参 */
@Data
public class AgentRequest {
    private Long id;
    /** Agent 名称 */
    private String name;
    /** 关联模型ID */
    private Long modelId;
    /** 允许使用的工具名列表 */
    private List<String> toolList;
    /** 系统提示词/设定 */
    private String prompt;
    /** Agent 描述 */
    private String description;
}
