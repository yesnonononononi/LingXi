package com.summit.dp.user_configs.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

/** UserConfig 持久化对象（单例行：主键固定为 1，表上无自增，见 chk_user_configs_singleton） */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@TableName("user_configs")
public class UserConfigPO {
    /** 单例行主键恒为 {@code LocalInstance.SETTINGS_ROW_ID}；表列非自增，必须显式赋值（INPUT）。 */
    @TableId(type = IdType.INPUT)
    private Long id;
    private String workspaceType;
    /** 命令放行档位（空值表示沿用 yml 缺省） */
    private String commandApprovalPolicy;
    /** 会话访问档位（空值表示沿用 yml 缺省） */
    private String accessMode;
    /** 提醒"还有未完成任务"的次数上限（缺省由 PlanReminderPolicy 兜底） */
    private Integer planMaxReminders;
    /** 本实例全局选中的 Agent（关联 agent.id；空表示未选择） */
    private Long agentId;
    /** 当前用户选中的模型（关联 model_config.id；空表示未选择） */
    private Long modelId;
    /** 模型最大 Token 数（空则由模型/框架缺省兜底） */
    private Integer maxTokens;
    /** 思考深度/推理等级（空则由模型/框架缺省兜底） */
    private String reasoningEffort;
    /** 渲染主题 */
    private String renderTheme;

    private Integer status;
    private Instant createTime;
    private Instant updateTime;
}
