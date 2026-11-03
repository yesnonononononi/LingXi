package com.summit.dp.workflow.infrastructure.tools.image;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.dp.execution.ExecutionAttributes;

import java.util.HashMap;
import java.util.Map;
import java.util.function.Consumer;

/**
 * 执行运行时属性的读取与整体替换。
 *
 * <p>运行时属性在请求准备阶段是 {@code Map.copyOf}（不可变），要改只能整体换一份再挂回去；
 * 换完会随执行快照持久化，suspend/resume 不丢。</p>
 */
final class ImageExecutionAttributes {

    private ImageExecutionAttributes() {
    }

    /** 读取当前执行属性；没有请求或没有参数时按空表处理。 */
    static Map<String, Object> read(Execution execution) {
        AgentRequest request = execution.getAgentRequest();
        return request == null ? Map.of() : request.runtimeParametersOrDefault().getAttributes();
    }

    /** 在属性副本上改完整体换回请求：原属性是 {@code Map.copyOf}，不可变，只能换一份。 */
    static void mutate(Execution execution, Consumer<Map<String, Object>> mutation) {
        AgentRequest request = execution.getAgentRequest();
        AgentRuntimeParameters parameters = request.runtimeParametersOrDefault();
        Map<String, Object> next = new HashMap<>(parameters.getAttributes());
        mutation.accept(next);
        parameters.setAttributes(Map.copyOf(next));
        request.setRuntimeParameters(parameters);
    }

    /** 读取整数属性，缺失按 0。 */
    static int number(Map<String, Object> attributes, String key) {
        Long value = ExecutionAttributes.readLong(attributes, key);
        return value == null ? 0 : value.intValue();
    }

    /** 已注入张数，与 {@code read_image} 回执里的 {@code budget.used} 同源。 */
    static int consumed(Map<String, Object> attributes) {
        return number(attributes, ReadImageToolExecutor.KEY_CONSUMED);
    }
}
