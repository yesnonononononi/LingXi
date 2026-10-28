package com.summit.dp.workflow.infrastructure.tools.checklist;

import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.SystemMessageEntity;
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

/** 正文按实际内容更新；压缩后缺消息时不能被旧版本标记挡住。 */
@Component
@RequiredArgsConstructor
public class ChecklistContextInjector {

    private static final String CONTENT = "lingxi.checklist.context.text";
    private final ChecklistService checklistService;

    void injectIfNeeded(LoopContext context, Execution execution) {
        ChecklistVO snapshot = checklistService.findActive(ExecutionIdentity.sessionId(execution)).orElse(null);
        String current = snapshot == null ? null : ChecklistReminderText.renderContext(snapshot);
        AgentRuntimeParameters parameters = execution.getAgentRequest().runtimeParametersOrDefault();
        Object stored = parameters.getAttributes().get(CONTENT);
        String previous = stored instanceof String text ? text : null;
        if (!ChecklistSystemMessages.synchronize(execution, previous, current) && current != null) {
            context.appendMessage(List.of(SystemMessageEntity.builder().text(current).build()));
        }
        // 消息写入成功后才记录文本，失败重试仍能补入；不再依赖进展版本推测消息是否存在。
        Map<String, Object> attributes = new HashMap<>(parameters.getAttributes());
        attributes.remove("lingxi.checklist.injected");
        if (current == null) attributes.remove(CONTENT);
        else attributes.put(CONTENT, current);
        parameters.setAttributes(Map.copyOf(attributes));
        execution.getAgentRequest().setRuntimeParameters(parameters);
        ChecklistReminderState.synchronize(execution, snapshot);
    }
}
