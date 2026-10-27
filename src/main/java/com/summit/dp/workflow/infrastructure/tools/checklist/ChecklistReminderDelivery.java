package com.summit.dp.workflow.infrastructure.tools.checklist;

import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.dp.checklist.application.ChecklistReminderContext;
import com.summit.dp.checklist.application.ChecklistReminderText;
import com.summit.dp.checklist.application.ReminderDecision;
import com.summit.dp.workflow.infrastructure.harness.ExecutionIdentity;
import org.springframework.stereotype.Component;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** 标记与对应消息必须同时存在，防止注入失败或上下文重建被误判为已投递。 */
@Component
public class ChecklistReminderDelivery {
    private static final String DELIVERED_MARKER = "lingxi.checklist.reminder.delivered";

    public ChecklistReminderContext buildContext(Execution execution) {
        Object marker = execution.getAgentRequest().runtimeParametersOrDefault().getAttributes().get(DELIVERED_MARKER);
        Set<String> delivered = marker instanceof String text && execution.getMessages() != null
                && execution.getMessages().stream().anyMatch(message -> message instanceof UserMessageEntity
                && message.text().endsWith("\n" + text)) ? Set.of(text) : Set.of();
        return new ChecklistReminderContext(ExecutionIdentity.sessionId(execution),
                ExecutionIdentity.numericOrNull(execution.getId()), delivered);
    }

    public void append(LoopContext context, ReminderDecision decision) {
        Execution execution = context.getLoopMessages().getExecution();
        String marker = ChecklistReminderContext.buildDeliveryMarker(decision.checklist().getChecklistId(),
                decision.checklist().getProgressVersion(), Long.parseLong(execution.getId()));
        context.appendMessage(List.of(UserMessageEntity.from(ChecklistReminderText.render(decision) + "\n" + marker)));
        // 追加成功后才登记，框架会把消息与属性放进同一个执行检查点。
        AgentRuntimeParameters parameters = execution.getAgentRequest().runtimeParametersOrDefault();
        Map<String, Object> attributes = new HashMap<>(parameters.getAttributes());
        attributes.put(DELIVERED_MARKER, marker);
        parameters.setAttributes(Map.copyOf(attributes));
        execution.getAgentRequest().setRuntimeParameters(parameters);
    }
}
