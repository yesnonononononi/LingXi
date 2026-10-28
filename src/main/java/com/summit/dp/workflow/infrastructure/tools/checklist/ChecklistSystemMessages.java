package com.summit.dp.workflow.infrastructure.tools.checklist;

import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.SystemMessageEntity;

import java.util.ArrayList;
import java.util.List;

/** 只替换本模块记录过的完整文本，保留同一附件中的计划与其他系统指令。 */
final class ChecklistSystemMessages {
    private ChecklistSystemMessages() { }

    static boolean synchronize(Execution execution, String previous, String current) {
        List<Message> source = execution.getMessages();
        if (source == null) return false;
        int target = -1;
        for (int index = 0; current != null && index < source.size(); index++) {
            Message message = source.get(index);
            if (!(message instanceof SystemMessageEntity)) continue;
            boolean matches = message.text().contains(current)
                    || previous != null && message.text().contains(previous);
            if (matches && (target < 0 || source.get(target).text().equals(current)
                    || previous != null && source.get(target).text().equals(previous))) target = index;
        }
        List<Message> retained = new ArrayList<>();
        for (int index = 0; index < source.size(); index++) {
            Message message = source.get(index);
            if (!(message instanceof SystemMessageEntity)) { retained.add(message); continue; }
            String text = message.text();
            if (index == target) {
                if (!text.contains(current)) text = text.replace(previous, current);
                else if (previous != null && !previous.equals(current)) text = text.replace(previous, "");
            } else {
                if (previous != null) text = text.replace(previous, "");
                if (current != null) text = text.replace(current, "");
            }
            if (!text.isBlank()) retained.add(text.equals(message.text()) ? message
                    : SystemMessageEntity.builder().text(text).build());
        }
        execution.setMessages(retained);
        return target >= 0;
    }
}
