package com.summit.dp.user_configs.application.policy;

import java.util.Arrays;
import java.util.List;
import java.util.Map;

/**
 * 会话总权限档位（合并原工作区访问边界与命令审批策略为单一真源）。
 *
 * <p>工具集裁剪、工作区读写/越界围栏、命令审批级别以及沙箱 {@code writable} 标志
 * 全部从本枚举派生，避免多处各自组合判断导致状态撕裂。</p>
 */
public enum AgentPermissionMode {

    /**
     * 只读审阅：仅在业务 Plan 语义下生效，不展示在会话权限修改菜单中。
     * 剔除写文件工具与终端工具，工作区沙箱也以只读模式运行。
     */
    READ_ONLY_REVIEW(false, false, false, false, false, CommandApprovalKind.NONE),

    /**
     * 审批模式：每条命令均需用户审批，文件仅允许在工作区内读写。
     */
    APPROVAL_REQUIRED(true, true, true, false, true, CommandApprovalKind.EVERY_COMMAND),

    /**
     * 代我审批：仅危险命令需要用户审批，文件仅允许在工作区内读写。
     */
    DELEGATED_APPROVAL(true, true, true, false, true, CommandApprovalKind.DANGEROUS_ONLY),

    /**
     * 完全访问：命令完全不审批（用户自定义 DENY 规则除外），允许工作区外文件/命令访问。
     */
    FULL_ACCESS(true, true, true, true, true, CommandApprovalKind.NONE);

    public enum CommandApprovalKind {
        NONE,
        DANGEROUS_ONLY,
        EVERY_COMMAND
    }

    /** 写入框架 attributes 的权威键。 */
    public static final String ATTRIBUTE_KEY = "agent.permission.mode";

    /** 历史双字段 attributes 兼容键（仅用于旧执行快照反序列化迁移）。 */
    public static final String LEGACY_ACCESS_MODE_KEY = "agent.access.mode";
    public static final String LEGACY_APPROVAL_POLICY_KEY = "command.approval.policy";

    /** 未显式配置时的默认总权限档位。 */
    public static final AgentPermissionMode DEFAULT = APPROVAL_REQUIRED;

    private final boolean visibleInSessionMenu;
    private final boolean allowsWriteTools;
    private final boolean allowsTerminalTools;
    private final boolean allowsOutsideWorkspace;
    private final boolean workspaceWritable;
    private final CommandApprovalKind commandApprovalKind;

    AgentPermissionMode(boolean visibleInSessionMenu,
                        boolean allowsWriteTools,
                        boolean allowsTerminalTools,
                        boolean allowsOutsideWorkspace,
                        boolean workspaceWritable,
                        CommandApprovalKind commandApprovalKind) {
        this.visibleInSessionMenu = visibleInSessionMenu;
        this.allowsWriteTools = allowsWriteTools;
        this.allowsTerminalTools = allowsTerminalTools;
        this.allowsOutsideWorkspace = allowsOutsideWorkspace;
        this.workspaceWritable = workspaceWritable;
        this.commandApprovalKind = commandApprovalKind;
    }

    /** 是否展示在会话权限修改菜单中（只读审阅仅随 Plan 语义生效，不直接暴露给用户选择）。 */
    public boolean isVisibleInSessionMenu() {
        return visibleInSessionMenu;
    }

    /** 是否允许暴露文件写入/修改/删除工具。 */
    public boolean allowsWriteTools() {
        return allowsWriteTools;
    }

    /** 是否允许暴露终端命令工具（execute_command / manage_command）。 */
    public boolean allowsTerminalTools() {
        return allowsTerminalTools;
    }

    /** 是否允许文件工具改动工作区之外的路径（完全访问档免越界审批）。 */
    public boolean allowsOutsideWorkspace() {
        return allowsOutsideWorkspace;
    }

    /** 底层工作区沙箱是否以可写模式挂载。 */
    public boolean isWorkspaceWritable() {
        return workspaceWritable;
    }

    /** 本档位下的命令审批策略。 */
    public CommandApprovalKind commandApprovalKind() {
        return commandApprovalKind;
    }

    /** 是否要求每条命令执行前都必须由用户确认。 */
    public boolean requiresPerCommandApproval() {
        return commandApprovalKind == CommandApprovalKind.EVERY_COMMAND;
    }

    /** 是否仅在命中危险/高风险规则时才发起命令审批。 */
    public boolean requiresDangerousCommandApproval() {
        return commandApprovalKind == CommandApprovalKind.DANGEROUS_ONLY;
    }

    /** 是否完全跳过命令审批（仅保留用户自定义 DENY）。 */
    public boolean bypassesCommandApproval() {
        return this == FULL_ACCESS;
    }

    /** 供前端会话权限修改菜单展示的可选档位列表（不含 READ_ONLY_REVIEW）。 */
    public static List<AgentPermissionMode> selectableModes() {
        return Arrays.stream(values())
                .filter(AgentPermissionMode::isVisibleInSessionMenu)
                .toList();
    }

    /**
     * 根据 Plan 语义解析本次执行真正生效的总权限档位：
     * 开启 Plan 时强制收口为 {@link #READ_ONLY_REVIEW}；否则沿用用户配置档位。
     */
    public static AgentPermissionMode resolveEffective(AgentPermissionMode configured, boolean requirePlan) {
        if (requirePlan) {
            return READ_ONLY_REVIEW;
        }
        return configured == null ? DEFAULT : configured;
    }

    public static Map<String, Object> toAttributes(AgentPermissionMode mode) {
        AgentPermissionMode effective = mode == null ? DEFAULT : mode;
        return Map.of(ATTRIBUTE_KEY, effective.name());
    }

    public static AgentPermissionMode from(Map<String, Object> attributes) {
        if (attributes == null) {
            return DEFAULT;
        }
        Object raw = attributes.get(ATTRIBUTE_KEY);
        if (raw != null) {
            return parse(raw);
        }
        Object legacyAccess = attributes.get(LEGACY_ACCESS_MODE_KEY);
        Object legacyApproval = attributes.get(LEGACY_APPROVAL_POLICY_KEY);
        if (legacyAccess != null || legacyApproval != null) {
            return fromLegacy(
                    legacyAccess == null ? null : String.valueOf(legacyAccess),
                    legacyApproval == null ? null : String.valueOf(legacyApproval)
            );
        }
        return DEFAULT;
    }

    public static AgentPermissionMode parse(Object raw) {
        if (raw == null) {
            return DEFAULT;
        }
        String text = String.valueOf(raw).trim().toUpperCase();
        if (text.isEmpty()) {
            return DEFAULT;
        }
        try {
            return valueOf(text);
        } catch (IllegalArgumentException e) {
            return DEFAULT;
        }
    }

    /** 解析用户输入的可选总权限档位（非法或不可选档位抛出 IllegalArgumentException）。 */
    public static AgentPermissionMode parseSelectableStrict(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String normalized = raw.trim().toUpperCase();
        AgentPermissionMode parsed;
        try {
            parsed = valueOf(normalized);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException(
                    "不支持的权限档位: " + raw + "，可选 " + selectableModes());
        }
        if (!parsed.isVisibleInSessionMenu()) {
            throw new IllegalArgumentException(
                    "只读审阅仅在 Plan 模式下生效，不可直接设置为全局权限档位");
        }
        return parsed;
    }

    /** 将旧版双字段（accessMode + commandApprovalPolicy）平滑映射为新版统一总权限档位。 */
    public static AgentPermissionMode fromLegacy(String legacyAccessMode, String legacyCommandPolicy) {
        String access = legacyAccessMode == null ? "" : legacyAccessMode.trim().toUpperCase();
        String policy = legacyCommandPolicy == null ? "" : legacyCommandPolicy.trim().toUpperCase();
        if ("READ_ONLY_IN_WORKSPACE".equals(access)) {
            return READ_ONLY_REVIEW;
        }
        if ("OUT_OF_WORKSPACE".equals(access) || "FULL_ACCESS".equals(policy)) {
            return FULL_ACCESS;
        }
        if ("DANGEROUS_BLOCK".equals(policy)) {
            return DELEGATED_APPROVAL;
        }
        if ("PRE_EXEC_CONFIRM".equals(policy)) {
            return APPROVAL_REQUIRED;
        }
        return DEFAULT;
    }
}
