package com.summit.dp.shared.config.workflow;

import java.util.Map;

/** 命令执行的人机放行档位 —— 属于业务侧。 */
public enum CommandApprovalPolicy {

    /** 完全放行：任何命令都不询问。 */
    FULL_ACCESS,

    /** 逐条确认：每条命令都先给用户看。 */
    PRE_EXEC_CONFIRM,

    /** 危险拦截：仅内核判定为「需批准」的命令才询问；毁灭性命令由内核直接拒绝，不询问。 */
    DANGEROUS_BLOCK;

    /** 本业务在不透明 attributes 中使用的键。 */
    public static final String ATTRIBUTE_KEY = "command.approval.policy";

    /** 请求未指定时的默认档位。 */
    public static final CommandApprovalPolicy DEFAULT = DANGEROUS_BLOCK;

    public static Map<String, Object> toAttributes(CommandApprovalPolicy policy) {
        CommandApprovalPolicy effective = policy == null ? DEFAULT : policy;
        return Map.of(ATTRIBUTE_KEY, effective.name());
    }

    public static CommandApprovalPolicy from(Map<String, Object> attributes) {
        if (attributes == null) {
            return DEFAULT;
        }
        return parse(attributes.get(ATTRIBUTE_KEY));
    }

    public static CommandApprovalPolicy parse(Object raw) {
        if (raw == null) {
            return DEFAULT;
        }
        try {
            return valueOf(String.valueOf(raw).trim().toUpperCase());
        } catch (IllegalArgumentException e) {
            return DEFAULT;
        }
    }
}
