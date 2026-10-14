package com.summit.dp.user_configs.application.policy;

import java.util.Map;

/** 会话的访问边界（读写范围）—— 属于业务侧。 */
public enum AgentAccessMode {

    /** 只读模式禁用编辑工具；终端写入副作用不由档位保证。 */
    READ_ONLY_IN_WORKSPACE,

    /** 工作区内修改模式：允许读写工作区，工作区外只读。 */
    IN_WORKSPACE,

    /** 完全访问：允许项目外读写，执行环境仍由 workspace 类型决定。 */
    OUT_OF_WORKSPACE;

    /** 本业务在不透明 attributes 中使用的键。 */
    public static final String ATTRIBUTE_KEY = "agent.access.mode";

    /** 请求未指定时的默认档位。 */
    public static final AgentAccessMode DEFAULT = IN_WORKSPACE;

    /** 是否允许使用文件编辑工具；终端授权单独处理。 */
    public boolean allowsWriteTools() {
        return this != READ_ONLY_IN_WORKSPACE;
    }

    /** 是否为沙箱策略额外授予项目外写入路径。 */
    public boolean allowsOutsideWrite() {
        return this == OUT_OF_WORKSPACE;
    }

    /** 是否允许在工作区之外读取。三档皆可，保留此方法用于显式表达语义。 */
    public boolean allowsOutsideRead() {
        return true;
    }

    public static Map<String, Object> toAttributes(AgentAccessMode mode) {
        AgentAccessMode effective = mode == null ? DEFAULT : mode;
        return Map.of(ATTRIBUTE_KEY, effective.name());
    }

    public static AgentAccessMode from(Map<String, Object> attributes) {
        if (attributes == null) {
            return DEFAULT;
        }
        return parse(attributes.get(ATTRIBUTE_KEY));
    }

    public static AgentAccessMode parse(Object raw) {
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
