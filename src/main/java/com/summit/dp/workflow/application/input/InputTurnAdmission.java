package com.summit.dp.workflow.application.input;

import com.summit.core.agent.Execution;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.email.application.vo.EmailMessageVO;
import com.summit.dp.task.domain.model.Task;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.workflow.application.chat.PreparedChatExecutor;
import com.summit.dp.workflow.application.chat.RuntimeContext;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskNotifications;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** 新轮、选中邮件和旧任务回执一起提交，重复检查不能创建第二轮。 */
@Component
@RequiredArgsConstructor
public class InputTurnAdmission {
    private final PreparedChatExecutor executor;
    private final EmailService emails;
    private final ChatTurnRepository turns;
    private final ObjectProvider<ExecutionRepository> executions;
    private final BackgroundTaskNotifications notifications;

    @Transactional
    public RuntimeContext admit(RuntimeContext context, Execution previous, String commandId,
                                List<EmailMessageVO> mail, List<Task> tasks) {
        if (turns.findByCommandId(commandId).isPresent()) return null;
        RuntimeContext admitted = executor.admit(context, commandId);
        InputAutomationPolicy.putAttribute(admitted.execution(), InputAutomationPolicy.AUTO_ROUNDS,
                InputAutomationPolicy.autoRounds(previous) + 1);
        executions.getObject().save(admitted.execution());
        emails.consumePendingItems(mail);
        if (!tasks.isEmpty()) {
            Set<String> receipts = new HashSet<>(notifications.readReceipts(previous));
            tasks.forEach(task -> receipts.add(task.getId().toString()));
            InputAutomationPolicy.putAttribute(previous, BackgroundTaskNotifications.RECEIPTS, List.copyOf(receipts));
            executions.getObject().save(previous);
        }
        return admitted;
    }
}
