package com.summit.dp.user_configs.domain.model;


import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.local.LocalInstance;
import com.summit.dp.shared.model.WorkspaceType;
import lombok.Builder;
import lombok.Getter;
import lombok.NonNull;

import java.time.Instant;

/**
 * 通用配置领域模型：本地实例的默认环境（工作区类型、未完成任务提醒上限等）。
 */
@Getter
@Builder
public class UserConfig {
    public static final int DEFAULT_IMAGE_GENERATION_MAX_CALLS = 10;
    public static final int MAX_IMAGE_GENERATION_CALLS = 20;


    public record WorkSpaceConfig(WorkspaceType type) {
    }

    public enum AccessMode {
        IN_WORKSPACE,
        READ_ONLY_IN_WORKSPACE,
        OUT_OF_WORKSPACE;

        public static AccessMode fromString(String mode) {
            if (mode == null || mode.isBlank()) return null;
            return AccessMode.valueOf(mode.trim().toUpperCase());
        }
    }

    public enum CommandPolicy {
        DANGEROUS_BLOCK,
        PRE_EXEC_CONFIRM,
        FULL_ACCESS;

        public static CommandPolicy fromString(String policy) {
            if (policy == null) return null;
            return CommandPolicy.valueOf(policy.toUpperCase());
        }
    }

    public enum RenderTheme {
        LIGHT,
        DARK;
    }

    /**
     * 界面全局字号档位，与前端 4 档一一对应。
     */
    public enum FontScale {
        SMALL,
        MEDIUM,
        LARGE,
        X_LARGE;

        /** 空值/空串返回 null（未设置）；非空值按 name 解析。 */
        public static FontScale fromString(String value) {
            if (value == null || value.isBlank()) return null;
            return FontScale.valueOf(value.trim().toUpperCase());
        }

        /** 白名单判定：先判合法再 valueOf，报错文案才能带上可选值。 */
        public static boolean isSupported(String normalized) {
            for (FontScale scale : FontScale.values()) {
                if (scale.name().equals(normalized)) return true;
            }
            return false;
        }
    }

    public static final int DEFAULT_PLAN_MAX_REMINDERS = 10;
    /** 未设置时的字号档位：与历史界面观感（默认字号）一致，避免老库升级后视觉跳变。 */
    public static final FontScale DEFAULT_FONT_SCALE = FontScale.MEDIUM;
    public static final int DEFAULT_MAX_TOKENS = 102400;
    /** 未设置时的流式开关：默认流式，与历史行为一致，升级不改变现有观感。 */
    public static final boolean DEFAULT_STREAM_CHAT = true;
    /** 目录类字段的最大长度，与 user_configs.data_dir / skill_dir 的列宽一致。 */
    public static final int MAX_DIRECTORY_LENGTH = 500;
    /** 团队规模上限的合法区间：0 人团队没有意义，无上限则等于没设防。 */
    public static final int MIN_TEAM_SIZE = 1;
    public static final int MAX_TEAM_SIZE = 50;

    private final Long id;

    private WorkSpaceConfig workSpaceConfig;
    /**
     * 命令放行档位（业务侧概念）；空值表示沿用 yml 缺省。
     */
    private CommandPolicy commandApprovalPolicy;
    /**
     * 会话访问档位（业务侧概念）；空值表示沿用 yml 缺省。
     */
    private AccessMode accessMode;
    private Integer planMaxReminders;
    /**
     * 本实例全局选中的 Agent（关联 agent.id；空表示未选择）
     */
    private Long agentId;
    /**
     * 当前用户选中的模型（关联 model_config.id；空表示未选择）
     */
    private Long modelId;
    /**
     * 模型最大 Token 数；空表示沿用模型/框架缺省。
     */
    private Integer maxTokens;
    /**
     * 思考深度/推理等级；空表示沿用模型/框架缺省。
     */
    private ReasoningEffort reasoningEffort;
    /**
     * 前端界面主题
     */
    private RenderTheme renderTheme;
    /**
     * 界面全局字号档位；空值表示未设置，读取时归一到 {@link #DEFAULT_FONT_SCALE}。
     */
    private FontScale fontScale;

    /**
     * 会话数据存放目录
     */
    private String dataDir;
    /**
     * skills存放目录
     */
    private String skillDir;

    /**
     * 专用压缩模型（关联 model_config.id）。
     *
     * <p>空值表示「沿用对话模型做摘要」—— 框架侧的既有缺省；有值则本轮聊天请求
     * 会带上独立的 compactModel，上下文压缩不再借用对话模型。</p>
     */
    private Long compactModelId;
    /** 生图工具使用的独立模型；空表示未启用。 */
    private Long imageModelId;
    /** 每次执行的生图工具调用上限，失败调用也占用次数。 */
    private Integer imageGenerationMaxCalls;

    /**
     * 最大团队规模
     */
    private Integer teamSize;

    /**
     * 普通模型请求是否流式输出（SSE 逐字返回）。
     *
     * <p>空值表示未设置，读取时归一到 {@link #DEFAULT_STREAM_CHAT}（流式）。流式是连接级属性：
     * 它决定主对话/子 Agent 的对话请求走 streaming 还是同步 invoker，与「思考内容是否回传」
     * （框架的 returnThinking/sendThinking）是两回事，这里只控制前者。</p>
     */
    private Boolean streamChat;


    private Integer status;

    private final Instant createAt;

    private Instant updateAt;


    /**
     * 单例默认配置。主键固定为 {@code LocalInstance.SETTINGS_ROW_ID}：
     * 表列非自增且有 {@code CHECK (id = 1)} 约束，落行必须显式带主键，
     * 否则 INSERT 直接失败 —— 从结构上杜绝「自增落行 ≠ 1 导致永远读不到」的缺陷。
     */
    public static UserConfig defaultConfig() {
        return UserConfig.builder()
                .id(LocalInstance.SETTINGS_ROW_ID)
                .commandApprovalPolicy(CommandPolicy.PRE_EXEC_CONFIRM)
                .planMaxReminders(DEFAULT_PLAN_MAX_REMINDERS)
                .accessMode(AccessMode.IN_WORKSPACE)
                .reasoningEffort(ReasoningEffort.LOW)
                .maxTokens(DEFAULT_MAX_TOKENS)
                .streamChat(DEFAULT_STREAM_CHAT)
                .createAt(Instant.now())
                .updateAt(Instant.now())
                .workSpaceConfig(new WorkSpaceConfig(WorkspaceType.SAND_BOX))
                .build();
    }

    public void delete() {
        this.status = 0;
        update();
    }
    public void changeRenderTheme(String s) {
        this.renderTheme = RenderTheme.valueOf(s.toUpperCase());
        update();
    }

    /**
     * 切换界面字号档位；入参为空表示「回到未设置」（读取时取 {@link #DEFAULT_FONT_SCALE}）。
     *
     * <p>非法档位直接抛业务异常而不是静默回落 MEDIUM：回落会让调用方拿到「成功」却看到别的档位，
     * 契约违约被藏起来，排查时无从下手。</p>
     */
    public void changeFontScale(String fontScale) {
        this.fontScale = parseFontScale(fontScale);
        update();
    }

    /** 归一校验：null/空串 = 未设置；其余必须落在 SMALL/MEDIUM/LARGE/X_LARGE 白名单内。 */
    private FontScale parseFontScale(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String normalized = raw.trim().toUpperCase();
        throwIf(!FontScale.isSupported(normalized), "字体大小档位不支持: " + raw + "，可选 SMALL/MEDIUM/LARGE/X_LARGE");
        return FontScale.valueOf(normalized);
    }

    /** 读取侧归一：未设置按默认档位输出，前端不需要各自猜默认值。 */
    public FontScale resolveFontScale() {
        return this.fontScale == null ? DEFAULT_FONT_SCALE : this.fontScale;
    }

    public void changePlanMaxReminders(@NonNull Integer planMaxReminders) {
        if (planMaxReminders < 0) return;
        this.planMaxReminders = planMaxReminders;
        update();
    }

    public void changeWorkspace(@NonNull WorkSpaceConfig workSpaceConfig) {
        if (workSpaceConfig.type == null) return;
        this.workSpaceConfig = workSpaceConfig;
        update();
    }

    public void changeModel(@NonNull Long modelId) {
        this.modelId = modelId;
        update();
    }

    /**
     * 切换本实例全局选中的 Agent；{@code agentId} 允许为空，表示取消绑定。
     */
    public void changeAgent(Long agentId) {
        this.agentId = agentId;
        update();
    }

    /**
     * 切换专用压缩模型；{@code compactModelId} 允许为空，表示回到「沿用对话模型」。
     */
    public void changeCompactModel(Long compactModelId) {
        this.compactModelId = compactModelId;
        update();
    }

    public void changeImageModel(Long imageModelId) {
        this.imageModelId = imageModelId;
        update();
    }

    public void changeImageGenerationMaxCalls(Integer count) {
        throwIf(count == null || count < 0 || count > MAX_IMAGE_GENERATION_CALLS,
                "每次执行的生图次数必须在 0~" + MAX_IMAGE_GENERATION_CALLS + " 之间");
        this.imageGenerationMaxCalls = count;
        update();
    }

    /**
     * 切换普通模型请求的流式输出；{@code null} 表示回到默认（流式），由读取侧归一。
     */
    public void changeStreamChat(Boolean streamChat) {
        this.streamChat = streamChat;
        update();
    }

    /** 读取侧归一：未设置按 {@link #DEFAULT_STREAM_CHAT} 输出，前端与运行时都不必各自猜缺省。 */
    public boolean resolveStreamChat() {
        return this.streamChat == null ? DEFAULT_STREAM_CHAT : this.streamChat;
    }

    public int resolveImageGenerationMaxCalls() {
        return imageGenerationMaxCalls == null ? DEFAULT_IMAGE_GENERATION_MAX_CALLS : imageGenerationMaxCalls;
    }

    public void changeMaxTokens(Integer maxTokens) {
        if (maxTokens < 0) return;
        this.maxTokens = maxTokens;
        update();
    }

    public void changeReasoningEffort(@NonNull ReasoningEffort reasoningEffort) {
        this.reasoningEffort = reasoningEffort;
        update();
    }

    public void changeAccessMode(@NonNull AccessMode accessMode) {
        this.accessMode = accessMode;
        update();
    }

    public void changeCommandPolicy(@NonNull CommandPolicy commandPolicy) {
        this.commandApprovalPolicy = commandPolicy;
        update();
    }

    /** 数据存储目录；落库前必须先把库文件搬到该目录，这里只负责「记住新位置」。 */
    public void changeDataDir(@NonNull String dataDir) {
        this.dataDir = requireDirectory(dataDir);
        update();
    }

    /** 技能根目录；与 {@link #changeDataDir} 同理，先搬内容再落库。 */
    public void changeSkillDir(@NonNull String skillDir) {
        this.skillDir = requireDirectory(skillDir);
        update();
    }

    public void changeTeamSize(@NonNull Integer teamSize) {
        if (teamSize < MIN_TEAM_SIZE || teamSize > MAX_TEAM_SIZE) {
            throw new IllegalArgumentException("团队规模上限必须在 " + MIN_TEAM_SIZE + "~" + MAX_TEAM_SIZE + " 之间");
        }
        this.teamSize = teamSize;
        update();
    }

    /** 目录字段统一校验：trim 后非空且不超列宽，避免落库时才被数据库截断。 */
    private static String requireDirectory(String directory) {
        String trimmed = directory == null ? null : directory.trim();
        if (trimmed == null || trimmed.isEmpty()) {
            throw new IllegalArgumentException("目录不能为空");
        }
        if (trimmed.length() > MAX_DIRECTORY_LENGTH) {
            throw new IllegalArgumentException("目录长度不能超过 " + MAX_DIRECTORY_LENGTH);
        }
        return trimmed;
    }


    private void update() {
        this.updateAt = Instant.now();
    }

    /** 业务校验统一入口：报错交给 ClientException，前端能直接展示文案。 */
    private void throwIf(boolean condition, String err) {
        if (condition) {
            throw new ClientException(err);
        }
    }


}
