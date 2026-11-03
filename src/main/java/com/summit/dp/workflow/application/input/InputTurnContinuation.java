package com.summit.dp.workflow.application.input;

import cn.hutool.crypto.digest.DigestUtil;
import com.summit.core.agent.Execution;
import com.summit.dp.email.application.vo.EmailMessageVO;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.task.domain.model.Task;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.workflow.application.chat.ChatCommand;
import com.summit.dp.workflow.application.chat.PreparedChatExecutor;
import com.summit.dp.workflow.application.chat.RequestPreparer;
import com.summit.dp.workflow.application.chat.RuntimeContext;
import com.summit.dp.workflow.infrastructure.harness.ExecutionIdentity;
import com.summit.dp.workflow.infrastructure.lifecycle.ExecutionCoordination;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.communication.MailInputSource;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskInputSource;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskNotifications;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;
import org.springframework.beans.factory.ObjectProvider;

import java.util.List;

/** 正常完成后的新输入经标准受理创建真实身份，不复活旧执行。 */
@Component
@RequiredArgsConstructor
public class InputTurnContinuation {
    private final ExecutionRepository executions;
    private final ChatTurnRepository turns;
    private final SessionExecutionRegistry registry;
    private final MailInputSource mailSource;
    private final BackgroundTaskInputSource taskSource;
    private final BackgroundTaskNotifications notifications;
    private final InputTurnAdmission admission;
    private final RequestPreparer preparer;
    private final PreparedChatExecutor executor;
    private final ObjectProvider<InputWakeupService> wakeups;

    public void continueTurn(Execution previous) {
        if (ExecutionAttributes.readLong(InputAutomationPolicy.attributes(previous), ExecutionAttributes.ROOT_EXECUTION_ID) != null) return;
        long sessionId = ExecutionIdentity.sessionId(previous);
        RuntimeContext admitted;
        synchronized (ExecutionCoordination.monitor("session:" + sessionId)) {
            if (registry.isRootRunning(sessionId) || registry.isCancelled(sessionId)
                    || !executions.findUnfinishedBySessions(List.of(sessionId)).isEmpty()) return;
            Long latest = executions.findLatestBySessionAndStatus(List.of(sessionId)).stream()
                    .map(summary -> summary.getId()).max(Long::compareTo).orElse(null);
            if (latest != null && latest > Long.parseLong(previous.getId())) {
                wakeups.getObject().resumeIfInputPending(latest);
                return;
            }
            List<EmailMessageVO> mail = mailSource.pendingItems(previous);
            List<Task> tasks = taskSource.pendingItems(previous);
            if (mail.isEmpty() && tasks.isEmpty()) return;
            String commandId = "auto-input:" + sessionId + ":" + DigestUtil.sha256Hex(
                    mail.stream().map(item -> "mail:" + item.getId()).toList().toString()
                    + tasks.stream().map(task -> "task:" + task.getId()).toList());
            if (turns.findByCommandId(commandId).isPresent()) return;
            StringBuilder text = new StringBuilder("以下是新到达的协作与任务输入，请接续处理：\n");
            for (EmailMessageVO item : mail) text.append("成员 @").append(item.getSenderId())
                    .append(" 发来消息：\n").append(item.getContent()).append('\n');
            for (Task task : tasks) text.append(notifications.format(task)).append('\n');
            ChatCommand command = new ChatCommand(text.toString(), sessionId, null, null, null,
                    ExecutionAttributes.readLong(InputAutomationPolicy.attributes(previous), ExecutionAttributes.AGENT_ID),
                    false, List.of(), List.of());
            RuntimeContext context = preparer.prepare(command);
            if (!registry.tryBeginAutomaticRoot(sessionId, context.executionContext().executionId())) return;
            try {
                preparer.freezeRuntimeConfigurations(context);
                if (registry.isCancelled(sessionId)) {
                    registry.finishRoot(sessionId, context.executionContext().executionId());
                    return;
                }
                admitted = admission.admit(context, previous, commandId, mail, tasks);
            } catch (RuntimeException failure) {
                registry.finishRoot(sessionId, context.executionContext().executionId());
                throw failure;
            }
            if (admitted == null) {
                registry.finishRoot(sessionId, context.executionContext().executionId());
                return;
            }
        }
        executor.submitAsync(admitted);
    }
}
