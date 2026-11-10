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
    /** 界面全局字号档位（SMALL/MEDIUM/LARGE/X_LARGE） */
    private String fontScale;

    /**
     * 本次请求是否显式带了 {@code fontScale} 键。
     *
     * <p>与 {@code agentId} 同理：显式传 {@code null} 表示「回到未设置（默认档位）」，
     * 不传表示「保持原值」。两者反序列化后都是 null，只能靠 setter 有没有被调用区分。</p>
     */
    @JsonSetter("fontScale")
    public void markFontScalePresent(String fontScale) {
        this.fontScale = fontScale;
        this.fontScalePresent = true;
    }

    private boolean fontScalePresent;
    /** 数据存储目录；空值表示保持原值（改它会搬运库文件，因此不接受空串「清空」） */
    private String dataDir;
    /** 技能根目录；空值表示保持原值 */
    private String skillDir;
    /** 团队最大成员数；空值表示沿用配置项缺省 */
    private Integer teamSize;

    /**
     * 本次请求是否显式带了 {@code compactModelId} 键。
     *
     * <p>与 {@code agentId} 同理：显式传 {@code null} 表示「取消专用压缩模型、回到沿用对话模型」，
     * 不传表示「保持原值」。两者反序列化后都是 null，只能靠 setter 有没有被调用区分。</p>
     */
    @JsonSetter("compactModelId")
    public void markCompactModelIdPresent(Long compactModelId) {
        this.compactModelId = compactModelId;
        this.compactModelIdPresent = true;
    }

    /** 专用压缩模型ID（关联 model_config.id；空表示沿用对话模型做摘要） */
    private Long compactModelId;
    private boolean compactModelIdPresent;

    private Long imageModelId;
    private boolean imageModelIdPresent;
    private Integer imageGenerationMaxCalls;

    /** 普通模型请求是否流式输出（空表示保持原值；显式布尔才是设置项） */
    private Boolean streamChat;
    private boolean streamChatPresent;

    /** 显式 null 取消生图模型，未传入则保持原值。 */
    @JsonSetter("imageModelId")
    public void markImageModelIdPresent(Long imageModelId) {
        this.imageModelId = imageModelId;
        this.imageModelIdPresent = true;
    }

    /** 流式开关同 agentId：显式带上才改，不带保持原值；用 setter 留痕区分「传 null」与「没传」。 */
    @JsonSetter("streamChat")
    public void markStreamChatPresent(Boolean streamChat) {
        this.streamChat = streamChat;
        this.streamChatPresent = true;
    }
}
