package com.summit.dp.agent.api.request;

import lombok.Data;

import java.util.List;

/** 批量设置智能体基座模型的入参 */
@Data
public class AgentBatchModelRequest {
    /** 目标智能体标识集合 */
    private List<Long> ids;
    /** 统一绑定的模型标识 */
    private Long modelId;
}
