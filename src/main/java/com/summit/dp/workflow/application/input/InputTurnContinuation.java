package com.summit.dp.workflow.application.input;

import cn.hutool.crypto.digest.DigestUtil;
import com.summit.core.agent.Execution;
import com.summit.dp.email.application.vo.EmailMessageVO;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.task.domain.model.Task;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.workflow.application.chat.ChatCommand;
import com.summit.dp.workflow.application.chat.PendingChatQueue;
import com.summit.dp.workflow.application.chat.PreparedChatExecutor;
import com.summit.dp.workflow.application.chat.RequestPreparer;
import com.summit.dp.workflow.application.chat.RuntimeContext;
import com.summit.dp.workflow.infrastructure.harness.ExecutionIdentity;
import com.summit.dp.workflow.infrastructure.lifecycle.ExecutionCoordination;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 正常完成后的新输入经标准受理创建真实身份，不复活旧执行。
 *
 * <p><b>文本只由通道拼</b>：这里不再感知「邮件长什么样、任务结果长什么样」，
 * 只负责按通道顺序取 {@link InputInjectionStage#CONTINUATION} 阶段的文本并串起来。
 * 改造前这里另有一份「成员 @x 发来消息」的拼装，与循环内拦截器那份是同一件事的两份代码，
 * 改一处忘一处就会出现「循环内注入的话术和续跑的不一样」。</p>
 */
@Component
@RequiredArgsConstructor
public class InputTurnContinuation {
    private final ExecutionRepository executions;
    private final ChatTurnRepository turns;
    private final SessionExecutionRegistry registry;
    private final MailInputChannel mailChannel;
    private final BackgroundTaskChannel taskChannel;
    private final InputTurnAdmission admission;
    private final RequestPreparer preparer;
    private final PreparedChatExecutor executor;
    private final ObjectProvider<InputWakeupService> wakeups;
    private final PendingChatQueue pendingChats;

    public void continueTurn(Execution previous) {
        if (ExecutionAttributes.readLong(InputAutomationPolicy.attributes(previous), ExecutionAttributes.ROOT_EXECUTION_ID) != null) return;
        long sessionId = ExecutionIdentity.sessionId(previous);
        long previousExecutionId = Long.parseLong(previous.getId());
        RuntimeContext admitted;
        synchronized (ExecutionCoordination.monitor("session:" + sessionId)) {
            if (pendingChats.deferAutomatic(sessionId, previousExecutionId)
                    || registry.isRootRunning(sessionId) || registry.isCancelled(sessionId)
                    || !executions.findUnfinishedBySessions(List.of(sessionId)).isEmpty()) return;
            Long latest = executions.findLatestBySessionAndStatus(List.of(sessionId)).stream()
                    .map(summary -> summary.getId()).max(Long::compareTo).orElse(null);
            if (latest != null && latest > previousExecutionId) {
                wakeups.getObject().resumeIfInputPending(latest);
                return;
            }
            List<EmailMessageVO> mail = mailChannel.pollPendingItems(previous);
            List<Task> tasks = taskChannel.pollPendingItems(previous);
            if (mail.isEmpty() && tasks.isEmpty()) return;
            String commandId = "auto-input:" + sessionId + ":" + DigestUtil.sha256Hex(
                    mail.stream().map(item -> "mail:" + item.getId()).toList().toString()
                    + tasks.stream().map(task -> "task:" + task.getId()).toList());
            if (turns.findByCommandId(commandId).isPresent()) return;
            StringBuilder text = new StringBuilder(PendingInputTexts.CONTINUATION_HEADER);
            mailChannel.formatForModelContext(previous, mail, InputInjectionStage.CONTINUATION)
                    .forEach(text::append);
            taskChannel.formatForModelContext(previous, tasks, InputInjectionStage.CONTINUATION)
                    .forEach(line -> text.append(line).append('\n'));
            ChatCommand command = new ChatCommand(text.toString(), sessionId, null, null, null,
                    ExecutionAttributes.readLong(InputAutomationPolicy.attributes(previous), ExecutionAttributes.AGENT_ID),
                    false, List.of(), List.of());
            RuntimeContext context = preparer.prepare(command);
            context.pendingUserMessage().markPendingCompaction();
            synchronized (ExecutionCoordination.monitor("control:" + sessionId)) {
                if (pendingChats.deferAutomatic(sessionId, previousExecutionId)
                        || !registry.tryBeginAutomaticRoot(sessionId, context.executionContext().executionId())) return;
            }
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

