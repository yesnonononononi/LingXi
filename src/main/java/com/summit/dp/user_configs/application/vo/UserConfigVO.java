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
    /** 渲染主题：light/dark */
    private String renderTheme;
    /** 数据存储目录（H2 库文件所在目录）；已是「设置行覆盖配置项」后的生效值，前端只读展示。 */
    private String dataDir;
    /** 技能根目录；同样是生效值。 */
    private String skillDir;
    /** 团队最大成员数；空值表示沿用配置项缺省。 */
    private Integer teamSize;
    /** 专用压缩模型（关联 model_config.id）；空表示沿用对话模型做摘要。 */
    @JsonSerialize(using = ToStringSerializer.class)
    private Long compactModelId;
    /**
     * 数据目录变更是否待重启生效。
     *
     * <p>库文件在进程启动时打开，改目录只能落库 + 搬运文件，本进程仍写在旧目录上，
     * 必须重启才切得过去。前端据此提示并拦住继续对话 —— 否则这些新数据不在新目录的副本里。</p>
     */
    private Boolean dataDirRestartRequired;
}
