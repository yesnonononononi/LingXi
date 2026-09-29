package com.summit.dp.user_configs.application.vo;

import com.fasterxml.jackson.databind.annotation.JsonSerialize;
import com.fasterxml.jackson.databind.ser.std.ToStringSerializer;
import com.summit.dp.shared.model.WorkspaceType;
import lombok.Builder;
import lombok.Data;

/** UserConfig 视图对象（生成骨架） */
@Data
@Builder
public class UserConfigVO {
    @JsonSerialize(using = ToStringSerializer.class)
    private final Long id;
    @JsonSerialize(using = ToStringSerializer.class)
    private Long modelId;
    /** 本实例全局选中的 Agent（关联 agent.id；空表示未选择） */
    @JsonSerialize(using = ToStringSerializer.class)
    private Long agentId;
    private WorkspaceType type;
    /** 命令放行档位：FULL_ACCESS/PRE_EXEC_CONFIRM/DANGEROUS_BLOCK；空值表示沿用缺省。 */
    private String commandApprovalPolicy;
    /** 会话访问档位：IN_WORKSPACE/READ_ONLY_IN_WORKSPACE/OUT_OF_WORKSPACE；空值表示沿用缺省。 */
    private String accessMode;
    private Integer planMaxReminders;
    /** 模型最大 Token 数；空值表示沿用模型/框架缺省。 */
    private Integer maxTokens;
    /** 思考深度/推理等级：low/none/medium/high/xhigh/max；空值表示沿用模型/框架缺省。 */
    private String reasoningEffort;
}
