package com.summit.dp.workflow.infrastructure.tools.checklist;

import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.SystemMessageEntity;
import com.summit.dp.checklist.application.ChecklistReminderContext;
import com.summit.dp.checklist.application.ChecklistReminderText;
import com.summit.dp.checklist.application.ChecklistVO;
import com.summit.dp.checklist.application.ReminderDecision;
import com.summit.dp.workflow.infrastructure.harness.ExecutionIdentity;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/** 额度占用不是投递证据，只有属性与对应系统消息同时存在才能保护提醒。 */
final class ChecklistReminderState {
    static final String DELIVERED_MARKER = "lingxi.checklist.reminder.delivered";
    static final String DELIVERED_TEXT = "lingxi.checklist.reminder.text";

    private ChecklistReminderState() { }

    static ChecklistReminderContext context(Execution execution) {
        Object marker = execution.getAgentRequest().runtimeParametersOrDefault().getAttributes().get(DELIVERED_MARKER);
        Set<String> delivered = marker instanceof String text && execution.getMessages() != null
                && execution.getMessages().stream().anyMatch(message -> message instanceof SystemMessageEntity
                && message.text().contains("\n" + text)) ? Set.of(text) : Set.of();
        return new ChecklistReminderContext(ExecutionIdentity.sessionId(execution),
                ExecutionIdentity.numericOrNull(execution.getId()), delivered);
    }

    static Optional<String> protectedText(Execution execution, ChecklistVO snapshot) {
        ChecklistReminderContext receipt = context(execution);
        if (snapshot == null || !receipt.wasDelivered(snapshot.getChecklistId(), snapshot.getProgressVersion())) {
            return Optional.empty();
        }
        List<ChecklistVO.StepVO> unresolved = snapshot.sortedSteps().stream()
                .filter(step -> "PENDING".equals(step.getStatus()) || "IN_PROGRESS".equals(step.getStatus())).toList();
        String marker = ChecklistReminderContext.buildDeliveryMarker(snapshot.getChecklistId(),
                snapshot.getProgressVersion(), receipt.executionId());
        return Optional.of(ChecklistReminderText.render(ReminderDecision.replayed(snapshot, unresolved)) + "\n" + marker);
    }

    static void synchronize(Execution execution, ChecklistVO snapshot) {
        AgentRuntimeParameters parameters = execution.getAgentRequest().runtimeParametersOrDefault();
        Object stored = parameters.getAttributes().get(DELIVERED_TEXT);
        String previous = stored instanceof String text ? text : null;
        String current = protectedText(execution, snapshot).orElse(null);
        if (previous == null && current == null) return;
        ChecklistSystemMessages.synchronize(execution, previous, current);
        Map<String, Object> attributes = new HashMap<>(parameters.getAttributes());
        if (current == null) { attributes.remove(DELIVERED_MARKER); attributes.remove(DELIVERED_TEXT); }
        else attributes.put(DELIVERED_TEXT, current);
        parameters.setAttributes(Map.copyOf(attributes));
        execution.getAgentRequest().setRuntimeParameters(parameters);
    }
}
