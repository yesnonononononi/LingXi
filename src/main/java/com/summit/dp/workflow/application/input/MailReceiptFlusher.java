package com.summit.dp.workflow.application.input;

import com.summit.core.agent.Execution;
import com.summit.dp.email.domain.model.EmailMessageReceipt;
import com.summit.dp.email.domain.repository.EmailMessageReceiptRepository;
import com.summit.dp.email.domain.repository.EmailMessageRepository;
import com.summit.dp.execution.ExecutionAttributes;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 把「本轮已投递」落成回执：只在检查点提交的那次事务里执行。
 *
 * <h2>为什么必须与检查点同事务</h2>
 *
 * <p>回执是「这封邮件已经进过模型上下文」的权威事实。若它在注入时就独立提交，那么
 * 「已注入、检查点未落库」崩一次之后，重启会因为回执已存在而<b>永久丢掉</b>这条输入。
 * 放进检查点那次事务后，崩溃点只有两种：事务没提交（回执没有 → 重新注入，重复而非丢失）
 * 或已提交（回执与检查点同生，不重复）。</p>
 *
 * <p>调用点因此挂在 {@code LocalExecutionRepository#commitCheckpoint} 的重试动作内部：
 * 重试会连同回执一起重放，失败事务已回滚，不会留下半条回执。</p>
 *
 * <h2>边界</h2>
 *
 * <p>邮件行只改状态、不删除；{@code status → CONSUMED} 只是展示态，失败只记日志，
 * 不影响回执这一权威事实。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class MailReceiptFlusher {

    private final EmailMessageReceiptRepository receipts;
    private final EmailMessageRepository messages;

    /**
     * 为执行属性里登记的已投递邮件补写回执（幂等：已有回执的消息跳过）。
     *
     * @param execution 正在保存检查点的执行，不能为空
     */
    public void flush(Execution execution) {
        if (execution == null) {
            return;
        }
        Map<String, Object> attributes = InputAutomationPolicy.attributes(execution);
        List<Long> delivered = ExecutionAttributes.readLongs(attributes, ExecutionAttributes.DELIVERED_MAIL_IDS);
        if (delivered.isEmpty()) {
            // 绝大多数保存没有邮件要认领：这里必须零查询，普通连续轮次不许多出 SQL。
            return;
        }
        Set<Long> recorded = receipts.findMessageIdsWithReceipt(delivered);
        List<Long> pending = delivered.stream().filter(id -> !recorded.contains(id)).toList();
        if (pending.isEmpty()) {
            return;
        }
        Map<Long, Long> emailIds = messages.findEmailIdByIds(pending);
        Long consumerSessionId = ExecutionAttributes.readLong(attributes, ExecutionAttributes.SESSION_ID);
        for (Long messageId : pending) {
            Long emailId = emailIds.get(messageId);
            if (emailId == null) {
                // 邮件行已不存在（历史数据/被人工清理）：没有可归属的邮箱，跳过即可。
                log.warn("邮件回执缺少邮箱归属，已跳过: executionId={}, messageId={}",
                        execution.getId(), messageId);
                continue;
            }
            receipts.save(EmailMessageReceipt.create(messageId, emailId, consumerSessionId));
        }
        try {
            messages.consumeByIds(pending);
        } catch (RuntimeException failure) {
            // 展示态清理失败不影响「已投递」这一权威事实。
            log.warn("邮件状态清理失败，回执不受影响: executionId={}, count={}, error={}",
                    execution.getId(), pending.size(), failure.toString());
        }
        pruneAfterCommit(execution, pending);
    }

    /**
     * 回执落库后把已认领的 id 从执行属性里摘掉，避免检查点里的清单随会话无限增长。
     *
     * <p>必须在提交之后做：提交前摘掉、事务又回滚了，就会丢掉同一轮内的去重清单。
     * 摘掉之后仍安全 —— 权威判据已经是库里的回执。</p>
     */
    private void pruneAfterCommit(Execution execution, List<Long> flushed) {
        Runnable prune = () -> {
            List<Long> remaining = ExecutionAttributes.readLongs(InputAutomationPolicy.attributes(execution),
                    ExecutionAttributes.DELIVERED_MAIL_IDS).stream()
                    .filter(id -> !flushed.contains(id)).toList();
            InputAutomationPolicy.putAttribute(execution, ExecutionAttributes.DELIVERED_MAIL_IDS,
                    remaining.isEmpty() ? null : remaining);
        };
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            prune.run();
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                prune.run();
            }
        });
    }
}
