package com.summit.dp.user_configs.api.request;

import com.fasterxml.jackson.annotation.JsonSetter;
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

    /**
     * 本次请求是否显式带了 {@code agentId} 键。
     *
     * <p>agentId 与其它字段相反：显式传 {@code null} 表示「取消绑定」，
     * 不传表示「保持原值」。两者反序列化后都是 null，
     * 只能靠 setter 有没有被调用区分，故在这里留痕。</p>
     */
    @JsonSetter("agentId")
    public void markAgentIdPresent(Long agentId) {
        this.agentId = agentId;
        this.agentIdPresent = true;
    }

    /** 本实例全局选中的 AgentID（关联 agent.id；空表示未选择） */
    private Long agentId;
    private boolean agentIdPresent;

    /** 模型最大 Token 数（空值表示沿用模型/框架缺省）。 */
    private Integer maxTokens;
    /** 思考深度/推理等级（空值表示沿用模型/框架缺省）。 */
    private String reasoningEffort;
    private String renderTheme;
}
