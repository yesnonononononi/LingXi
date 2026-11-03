package com.summit.dp.workflow.application.input;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.HashMap;
import java.util.Map;

/** 自动输入不能覆盖人的暂停、取消意图，也不能形成无限自动新轮。 */
@Component
@RequiredArgsConstructor
public class InputAutomationPolicy {
    public static final String USER_PAUSED = "lingxi.input.user_paused";
    public static final String AUTO_ROUNDS = "lingxi.input.auto_rounds";
    public static final String LAST_REPORT = "lingxi.input.last_report";
    public static final int MAX_AUTO_ROUNDS = 3;
    private final SessionExecutionRegistry registry;

    public String blockedReason(Execution execution) {
        if (registry.isExecutionCancelled(execution.getId()) || registry.isCancelled(ExecutionAttributes.mailboxSessionId(attributes(execution)))
                || execution.getExecutionState() == ExecutionState.CANCELLED) return "执行已取消";
        if (execution.getExecutionState() == ExecutionState.FAILED) return "执行失败或已按崩溃收口";
        if (Boolean.TRUE.equals(attributes(execution).get(USER_PAUSED))) return "执行已由用户暂停";
        if (execution.getExecutionState() == ExecutionState.COMPLETED
                && ExecutionAttributes.readLong(attributes(execution), ExecutionAttributes.ROOT_EXECUTION_ID) != null)
            return "子执行已结束，请通过标准委派入口继续处理";
        if (execution.getExecutionState() == ExecutionState.COMPLETED
                && autoRounds(execution) >= MAX_AUTO_ROUNDS) return "连续自动接续已达到 " + MAX_AUTO_ROUNDS + " 轮上限";
        return null;
    }

    public static int autoRounds(Execution execution) {
        Object value = attributes(execution).get(AUTO_ROUNDS);
        return value instanceof Number number ? number.intValue() : 0;
    }

    public static Map<String, Object> attributes(Execution execution) {
        return execution.getAgentRequest().runtimeParametersOrDefault().getAttributes();
    }

    public static void putAttribute(Execution execution, String key, Object value) {
        Map<String, Object> values = new HashMap<>(attributes(execution));
        if (value == null) values.remove(key);
        else values.put(key, value);
        execution.getAgentRequest().runtimeParametersOrDefault().setAttributes(values);
    }
}
