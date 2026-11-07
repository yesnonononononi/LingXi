package com.summit.dp.workflow.application.input;

import com.summit.core.agent.Execution;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.email.application.vo.EmailMessageVO;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.task.domain.model.Task;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.workflow.application.chat.PreparedChatExecutor;
import com.summit.dp.workflow.application.chat.RuntimeContext;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 新轮、选中邮件和旧任务回执一起提交，重复检查不能创建第二轮。
 *
 * <h2>事务边界（本条是完成态跨轮的正确性核心）</h2>
 *
 * <p>三件事必须在<b>同一个事务</b>里：创建新执行、把这一批邮件的全局消费态推进、把任务回执写回旧执行。
 * 分开提交会出现「轮次建好了但邮件没标已消费」或反过来 —— 前者导致下一轮把同一批邮件再注入一次，
 * 后者导致创建失败时输入被静默吞掉。</p>
 *
 * <p>幂等由两道判据共同保证：进入时 {@code findByCommandId} 判重（同一批输入只建一轮），
 * 以及各通道把游标/回执写在随检查点落库的执行属性上。因此重复调用 {@code admit} 只会返回
 * {@code null}，不会再建一轮。</p>
 */
@Component
@RequiredArgsConstructor
public class InputTurnAdmission {
    private final PreparedChatExecutor executor;
    private final EmailService emails;
    private final ChatTurnRepository turns;
    private final ObjectProvider<ExecutionRepository> executions;
    private final MailInputChannel mailChannel;
    private final BackgroundTaskChannel taskChannel;

    @Transactional
    public RuntimeContext admit(RuntimeContext context, Execution previous, String commandId,
                                List<EmailMessageVO> mail, List<Task> tasks) {
        if (turns.findByCommandId(commandId).isPresent()) return null;
        RuntimeContext admitted = executor.admit(context, commandId);
        InputAutomationPolicy.putAttribute(admitted.execution(), InputAutomationPolicy.AUTO_ROUNDS,
                InputAutomationPolicy.autoRounds(previous) + 1);
        executions.getObject().save(admitted.execution());
        // 游标推进改的是内存里的执行对象，事务回滚时库不变而内存变了 —— 那样后续重试会把
        // 同一批输入当成「已注入」而静默丢弃。回滚就把内存恢复到进方法时的样子。
        Map<String, Object> attributesBefore = new HashMap<>(InputAutomationPolicy.attributes(previous));
        restoreOnRollback(previous, attributesBefore);
        mailChannel.markConsumed(previous, mail);
        taskChannel.markConsumed(previous, tasks);
        // 新执行继承已注入游标：不继承的话，每一轮新执行都会把同一批历史邮件再注入一次。
        inheritMailCursor(admitted.execution(), previous);
        if (!mail.isEmpty()) {
            emails.consumePendingItems(mail);
        }
        if (!mail.isEmpty() || !tasks.isEmpty()) {
            // 游标与回执写在同一份旧执行对象上，必须落库；否则下一轮会把同一批再注入一次。
            executions.getObject().save(previous);
        }
        return admitted;
    }

    /** 回滚补偿：把内存游标恢复原样，保证「没提交就等于没注入」。 */
    private void restoreOnRollback(Execution previous, Map<String, Object> attributesBefore) {
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCompletion(int status) {
                if (status == TransactionSynchronization.STATUS_ROLLED_BACK) {
                    previous.getAgentRequest().runtimeParametersOrDefault()
                            .setAttributes(new HashMap<>(attributesBefore));
                }
            }
        });
    }

    /**
     * 把旧执行的邮件游标写到新执行上：邮件属于会话级邮箱，跨轮共享同一批消息。
     *
     * <p>不继承的后果很具体：每一轮新执行游标都从 0 开始，会把整段历史邮件都当成新输入注入一次。</p>
     */
    private void inheritMailCursor(Execution admitted, Execution previous) {
        Long cursor = ExecutionAttributes.readLong(InputAutomationPolicy.attributes(previous),
                ExecutionAttributes.LAST_MAIL_ID);
        if (cursor != null) {
            InputAutomationPolicy.putAttribute(admitted, ExecutionAttributes.LAST_MAIL_ID, cursor);
        }
    }
}

