package com.summit.dp.workflow.infrastructure.tools.checklist;

import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.SystemMessageEntity;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.dp.checklist.application.ChecklistReminderContext;
import com.summit.dp.checklist.application.ChecklistReminderText;
import com.summit.dp.checklist.application.ReminderDecision;
import org.springframework.stereotype.Component;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** 标记与对应消息必须同时存在，防止注入失败或上下文重建被误判为已投递。 */
@Component
public class ChecklistReminderDelivery {
    public ChecklistReminderContext buildContext(Execution execution) {
        return ChecklistReminderState.context(execution);
    }

    public void append(LoopContext context, ReminderDecision decision) {
        Execution execution = context.getLoopMessages().getExecution();
        String marker = ChecklistReminderContext.buildDeliveryMarker(decision.checklist().getChecklistId(),
                decision.checklist().getProgressVersion(), Long.parseLong(execution.getId()));
        String text = ChecklistReminderText.render(decision) + "\n" + marker;
        context.appendMessage(List.of(SystemMessageEntity.builder().text(text).build()));
        // 追加成功后才登记，框架会把消息与属性放进同一个执行检查点。
        AgentRuntimeParameters parameters = execution.getAgentRequest().runtimeParametersOrDefault();
        Map<String, Object> attributes = new HashMap<>(parameters.getAttributes());
        attributes.put(ChecklistReminderState.DELIVERED_MARKER, marker);
        attributes.put(ChecklistReminderState.DELIVERED_TEXT, text);
        parameters.setAttributes(Map.copyOf(attributes));
        execution.getAgentRequest().setRuntimeParameters(parameters);
    }
}
