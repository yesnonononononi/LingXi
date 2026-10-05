package com.summit.dp.user_configs.api.request;

import lombok.Data;

/** UserConfig 接口层入参（生成骨架） */
@Data
public class UserConfigRequest {
    private Long id;
    private String type;
    private String commandApprovalPolicy;
    private String accessMode;
    private Integer planMaxReminders;
    /** 当前用户选中的模型ID（关联 model_config.id） */
    private Long modelId;
    /** 本实例全局选中的 AgentID（关联 agent.id；空表示未选择） */
    private Long agentId;
    /** 模型最大 Token 数；空值表示沿用模型/框架缺省。 */
    private Integer maxTokens;
    /** 思考深度/推理等级：low/none/medium/high/xhigh/max；空值表示沿用模型/框架缺省。 */
    private String reasoningEffort;
    private String renderTheme;
}
