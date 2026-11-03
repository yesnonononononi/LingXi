package com.summit.dp.workflow.infrastructure.memory;

import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.SystemMessageEntity;
import com.summit.core.runtime.loop.AgenticLoopListener;
import com.summit.core.runtime.loop.InterceptorResult;
import com.summit.core.runtime.loop.InterceptorType;
import com.summit.core.runtime.loop.LoopContext;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/** 每次调用前检查真实文件，续轮与恢复共用同一个入口。 */
@Component
@RequiredArgsConstructor
public class MemoryMonitorInterceptor {
    private final MemoryMonitor monitor;

    // 消息同步失败必须上抛，避免旧提醒已删除而新提醒未进入检查点。
    @AgenticLoopListener(value = InterceptorType.BEFORE_INVOKE, name = "memoryMonitorInterceptor",
            order = -825)
    public InterceptorResult onBeforeModelInvoke(LoopContext context) {
        Execution execution = context.getLoopMessages().getExecution();
        List<SystemMessageEntity> reminders = monitor.checkMemoryLimits();
        Set<String> pending = new LinkedHashSet<>();
        reminders.forEach(reminder -> pending.add(reminder.text()));
        List<Message> retained = new ArrayList<>();
        for (Message message : execution.getMessages()) {
            if (!(message instanceof SystemMessageEntity)
                    || !message.text().startsWith(MemoryMonitor.REMINDER_PREFIX)
                    || pending.remove(message.text())) {
                retained.add(message);
            }
        }
        // 只清理本模块的独立提醒；以真实消息去重，压缩丢失提醒后仍能重新补入。
        execution.setMessages(retained);
        List<SystemMessageEntity> missing = reminders.stream().filter(reminder -> pending.contains(reminder.text())).toList();
        if (!missing.isEmpty()) context.appendMessage(missing);
        return InterceptorResult.NONE;
    }
}
