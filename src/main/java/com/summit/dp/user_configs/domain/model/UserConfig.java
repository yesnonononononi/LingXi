package com.summit.dp.user_configs.domain.model;


import com.summit.dp.shared.local.LocalInstance;
import com.summit.dp.shared.model.WorkspaceType;
import lombok.Builder;
import lombok.Getter;
import lombok.NonNull;

import java.time.Instant;

/** 通用配置领域模型：本地实例的默认环境（工作区类型、未完成任务提醒上限等）。 */
@Getter
@Builder
public class UserConfig {
    public record WorkSpaceConfig(WorkspaceType type) {
    }
    public enum AccessMode{
        IN_WORKSPACE,
        READ_ONLY_IN_WORKSPACE,
        OUT_OF_WORKSPACE;
        public static AccessMode fromString(String mode) {
            if (mode == null || mode.isBlank()) return null;
            return AccessMode.valueOf(mode.trim().toUpperCase());
        }
    }
    public enum CommandPolicy{
        DANGEROUS_BLOCK,
        PRE_EXEC_CONFIRM,
        FULL_ACCESS;
        public static CommandPolicy fromString(String policy) {
            if(policy == null)return null;
            return CommandPolicy.valueOf(policy.toUpperCase());
        }
    }
    private final Long id;
    private WorkSpaceConfig workSpaceConfig;
    /** 命令放行档位（业务侧概念）；空值表示沿用 yml 缺省。 */
    private CommandPolicy commandApprovalPolicy;
    /** 会话访问档位（业务侧概念）；空值表示沿用 yml 缺省。 */
    private AccessMode accessMode;
    private Integer planMaxReminders;
    /** 本实例全局选中的 Agent（关联 agent.id；空表示未选择） */
    private Long agentId;
    /** 当前用户选中的模型（关联 model_config.id；空表示未选择） */
    private Long modelId;
    /** 模型最大 Token 数；空表示沿用模型/框架缺省。 */
    private Integer maxTokens;
    /** 思考深度/推理等级；空表示沿用模型/框架缺省。 */
    private ReasoningEffort reasoningEffort;
    private Integer status;
    private final Instant createAt;
    private Instant updateAt;
    public static final int DEFAULT_PLAN_MAX_REMINDERS = 10;
    public static final int DEFAULT_MAX_TOKENS = 102400;

    /**
     * 单例默认配置。主键固定为 {@code LocalInstance.SETTINGS_ROW_ID}：
     * 表列非自增且有 {@code CHECK (id = 1)} 约束，落行必须显式带主键，
     * 否则 INSERT 直接失败 —— 从结构上杜绝「自增落行 ≠ 1 导致永远读不到」的缺陷。
     */
    public static UserConfig defaultConfig(){
        return UserConfig.builder()
                .id(LocalInstance.SETTINGS_ROW_ID)
                .commandApprovalPolicy(CommandPolicy.PRE_EXEC_CONFIRM)
                .planMaxReminders(DEFAULT_PLAN_MAX_REMINDERS)
                .accessMode(AccessMode.IN_WORKSPACE)
                .reasoningEffort(ReasoningEffort.LOW)
                .maxTokens(DEFAULT_MAX_TOKENS)
                .createAt(Instant.now())
                .updateAt(Instant.now())
                .workSpaceConfig(new WorkSpaceConfig(WorkspaceType.SAND_BOX))
                .build();
    }

    public void delete() {
        this.status = 0;
        update();
    }


    public void changePlanMaxReminders(@NonNull Integer planMaxReminders){
        if(planMaxReminders < 0) return;
        this.planMaxReminders = planMaxReminders;
        update();
    }
    public void changeWorkspace(@NonNull WorkSpaceConfig workSpaceConfig){
        if (workSpaceConfig.type == null) return;
        this.workSpaceConfig = workSpaceConfig;
        update();
    }
    public void changeModel(@NonNull Long modelId){
        this.modelId = modelId;
        update();
    }

    /** 切换本实例全局选中的 Agent；{@code agentId} 允许为空，表示取消绑定。 */
    public void changeAgent(Long agentId){
        this.agentId = agentId;
        update();
    }
    public void changeMaxTokens(Integer maxTokens){
        if(maxTokens < 0) return;
        this.maxTokens = maxTokens;
        update();
    }
    public void changeReasoningEffort(@NonNull ReasoningEffort reasoningEffort){
        this.reasoningEffort = reasoningEffort;
        update();
    }
    public void changeAccessMode(@NonNull AccessMode accessMode){
        // 沙箱模式下,完全访问无意义
        if (this.workSpaceConfig.type == WorkspaceType.SAND_BOX && accessMode == AccessMode.OUT_OF_WORKSPACE) return;
        this.accessMode = accessMode;
        update();
    }

    public void changeCommandPolicy(@NonNull CommandPolicy commandPolicy){
        this.commandApprovalPolicy = commandPolicy;
        update();
    }


    private void update(){
         this.updateAt = Instant.now();
    }


}
