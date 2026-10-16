package com.summit.dp.user_configs.application.policy;

import java.util.Map;

/** 会话的访问边界（读写范围）—— 属于业务侧。 */
public enum AgentAccessMode {

    /** 只读模式禁用编辑工具，原生沙箱不给文件写入授权。 */
    READ_ONLY_IN_WORKSPACE,

    /** 普通修改模式：Windows 沙箱允许普通宿主路径，隐私拒绝始终生效。 */
    IN_WORKSPACE,

    /** 项目外修改模式：仍受原生隐私拒绝约束。 */
    OUT_OF_WORKSPACE;

    /** 本业务在不透明 attributes 中使用的键。 */
    public static final String ATTRIBUTE_KEY = "agent.access.mode";

    /** 请求未指定时的默认档位。 */
    public static final AgentAccessMode DEFAULT = IN_WORKSPACE;

    /** 是否允许使用文件编辑工具；终端授权单独处理。 */
    public boolean allowsWriteTools() {
        return this != READ_ONLY_IN_WORKSPACE;
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
