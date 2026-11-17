package com.summit.dp.workflow.infrastructure.tools.checklist;

import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.LoopContext;
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

/** 额度占用不是投递证据，只有属性与对应消息同时存在才能保护提醒。 */
final class ChecklistReminderState {
    static final String DELIVERED_MARKER = "lingxi.checklist.reminder.delivered";
    static final String DELIVERED_TEXT = "lingxi.checklist.reminder.text";

    private ChecklistReminderState() { }

    static ChecklistReminderContext context(Execution execution) {
        Object marker = execution.getAgentRequest().runtimeParametersOrDefault().getAttributes().get(DELIVERED_MARKER);
        // 提醒本身是用户消息：只看系统消息会把真实投递误判成未投递。
        Set<String> delivered = marker instanceof String text && containsText(execution.getMessages(), "\n" + text)
                ? Set.of(text) : Set.of();
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

    /**
     * 提醒所属的消息被压缩带走时补一条，绝不改写历史里的旧消息。
     *
     * <p>证据不成立（清单没了、或已换进度版本）时清掉属性：留着旧证据会拦住下一次提醒。</p>
     */
    static void appendIfMissing(LoopContext context, Execution execution, ChecklistVO snapshot) {
        Optional<String> expected = protectedText(execution, snapshot);
        if (expected.isEmpty()) {
            AgentRuntimeParameters parameters = execution.getAgentRequest().runtimeParametersOrDefault();
            if (!parameters.getAttributes().containsKey(DELIVERED_MARKER)
                    && !parameters.getAttributes().containsKey(DELIVERED_TEXT)) {
                return;
            }
            Map<String, Object> attributes = new HashMap<>(parameters.getAttributes());
            attributes.remove(DELIVERED_MARKER);
            attributes.remove(DELIVERED_TEXT);
            parameters.setAttributes(Map.copyOf(attributes));
            execution.getAgentRequest().setRuntimeParameters(parameters);
            return;
        }
        String text = expected.get();
        boolean present = containsText(execution.getMessages(), text);
        if (!present) context.appendMessage(List.of(UserMessageEntity.from(text).markPendingCompaction()));
    }

    /**
     * 消息里是否出现过这段文本。
     *
     * <p>只发工具调用的助手消息没有正文，{@link Message#text()} 返回 null —— 必须按「不含」处理。
     * 直接把 null 丢给 {@code contains} 会让整轮在提醒注入处崩掉：现场是恢复长会话时抛
     * NPE，433 条已恢复的消息全部作废，用户看到的是「这一轮莫名其妙失败了」。</p>
     */
    private static boolean containsText(List<Message> messages, String fragment) {
        return messages != null && messages.stream()
                .map(Message::text)
                .anyMatch(text -> text != null && text.contains(fragment));
    }
}
