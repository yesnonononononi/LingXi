package com.summit.dp.shared.config.workflow;

import com.summit.dp.shared.model.WorkspaceType;

import java.util.Map;

/** 会话的访问边界（读写范围）—— 属于业务侧。 */
public enum AgentAccessMode {

    /** 只读模式：读系统任意文件 + 无副作用终端命令 + 产出计划。 */
    READ_ONLY_IN_WORKSPACE,

    /** 工作区内修改模式：允许读写工作区，工作区外只读。 */
    IN_WORKSPACE,

    /** 完全访问：读写任意文件。仅 local 环境可选。 */
    OUT_OF_WORKSPACE;

    /** 本业务在不透明 attributes 中使用的键。 */
    public static final String ATTRIBUTE_KEY = "agent.access.mode";

    /** 请求未指定时的默认档位。 */
    public static final AgentAccessMode DEFAULT = IN_WORKSPACE;

    /** 解析请求档位并按工作区类型校正：沙箱下 OUT_OF_WORKSPACE 降级为 IN_WORKSPACE。 */
    public static AgentAccessMode effective(Object raw, WorkspaceType workspaceType) {
        AgentAccessMode mode = parse(raw);
        if (mode == OUT_OF_WORKSPACE && workspaceType == WorkspaceType.SAND_BOX) {
            return IN_WORKSPACE;
        }
        return mode;
    }

    /** 是否允许使用会产生副作用的工具（编辑文件、写文件等）。 */
    public boolean allowsWriteTools() {
        return this != READ_ONLY_IN_WORKSPACE;
    }

    /** 是否允许在工作区之外产生写副作用。 */
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
