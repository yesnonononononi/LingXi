package com.summit.dp.execution;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.tool.ToolExecution;

import java.util.Map;

/**
 * 从执行请求携带的不透明属性解析业务身份。
 *
 * <p><b>只解析属性，不查库</b>：执行快照里的 {@code attributes} 已带齐会话归属，
 * 手上已有执行对象时读属性即可。需要「由执行标识回查归属」的调用方走
 * {@code ExecutionLocator}（应用层，读领域仓储）—— 两者的区别是「手上有没有执行对象」，
 * 不是「谁能访问数据库」。</p>
 */
public final class ExecutionIdentity {

    private ExecutionIdentity() { }

    private static final String SESSION_ID = ExecutionAttributes.SESSION_ID;

    /** 执行携带的会话标识；属性缺失说明受理链路已坏，直接抛错而不是猜一个值。 */
    public static long sessionId(Execution execution) {
        return sessionId(execution.getAgentRequest());
    }

    public static long sessionId(AgentRequest request) {
        return sessionId(request.runtimeParametersOrDefault().getAttributes());
    }

    public static long sessionId(ToolExecution tool) {
        return sessionId(tool.getAttributes());
    }

    public static long sessionId(Map<String, Object> attributes) {
        Object value = attributes == null ? null : attributes.get(SESSION_ID);
        if (value == null) throw new IllegalArgumentException("执行请求缺少会话 ID");
        return Long.parseLong(value.toString());
    }

    /**
     * 执行标识 → 数值主键；无法解析（框架在 executionId 缺省时回落 UUID）返回 {@code null}。
     *
     * <p>把「不是数字」当成「归属未知」，用于**观测落库**这类不得拖垮主链路的场景 ——
     * 拿不到归属就写 NULL，绝不抛异常。</p>
     */
    public static Long numericOrNull(String executionId) {
        if (executionId == null || executionId.isBlank()) {
            return null;
        }
        try {
            return Long.parseLong(executionId.trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
