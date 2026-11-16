package com.summit.dp.workflow.infrastructure.tools.checklist;

import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.dp.checklist.application.ChecklistReminderText;
import com.summit.dp.checklist.application.ChecklistService;
import com.summit.dp.checklist.application.ChecklistVO;
import com.summit.dp.workflow.infrastructure.harness.ExecutionIdentity;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 清单变化以用户消息追加，不改写已有消息。
 *
 * <p>已经发出去的消息就是服务端的提示前缀，替换其中一条会让它后面每个 token 的缓存作废。
 * 所以这里只在版本变化（或消息被压缩带走）时追加一条带版本的通知，正文交给
 * {@code get_current_checklist} —— 用户消息在压缩中会被保留，丢了也能重新拿到权威快照。</p>
 */
@Component
@RequiredArgsConstructor
public class ChecklistContextInjector {

    private static final String CONTENT = "lingxi.checklist.context.text";
    private final ChecklistService checklistService;

    void injectIfNeeded(LoopContext context, Execution execution) {
        ChecklistVO snapshot = checklistService.findActive(ExecutionIdentity.sessionId(execution)).orElse(null);
        String current = snapshot == null ? null : ChecklistReminderText.renderUpdate(snapshot);
        AgentRuntimeParameters parameters = execution.getAgentRequest().runtimeParametersOrDefault();
        Object stored = parameters.getAttributes().get(CONTENT);
        String previous = stored instanceof String text ? text : null;

        // 属性还在不代表模型还看得到那条消息：压缩与剪枝会把它带走，按上下文实况判断。
        if (current != null && (!current.equals(previous) || !present(execution, current))) {
            context.appendMessage(List.of(UserMessageEntity.from(current)));
        }

        // 追加成功后才记录文本，失败重试仍能补入。
        Map<String, Object> attributes = new HashMap<>(parameters.getAttributes());
        attributes.remove("lingxi.checklist.injected");
        if (current == null) attributes.remove(CONTENT);
        else attributes.put(CONTENT, current);
        parameters.setAttributes(Map.copyOf(attributes));
        execution.getAgentRequest().setRuntimeParameters(parameters);

        ChecklistReminderState.appendIfMissing(context, execution, snapshot);
    }

    private static boolean present(Execution execution, String text) {
        List<Message> messages = execution.getMessages();
        return messages != null && messages.stream().anyMatch(message -> text.equals(message.text()));
    }
}
