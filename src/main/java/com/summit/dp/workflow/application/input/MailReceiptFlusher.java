package com.summit.dp.workflow.application.input;

import com.summit.core.agent.Execution;
import com.summit.dp.email.domain.model.EmailMessageReceipt;
import com.summit.dp.email.domain.repository.EmailMessageReceiptRepository;
import com.summit.dp.email.domain.repository.EmailMessageRepository;
import com.summit.dp.execution.ExecutionAttributes;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 把「本轮已投递」落成回执：只在检查点提交的那次事务里执行。
 *
 * <p>必须与检查点同事务：回执是「这封邮件已进过模型上下文」的权威事实，注入时独立提交的话，
 * 「已注入、检查点未落库」崩一次就会因回执已存在而永久丢输入。放进检查点那次事务后只剩两种结局：
 * 没提交则重新注入（重复而非丢失），已提交则与检查点同生、不重复。调用点因此挂在
 * {@code LocalExecutionRepository#commitCheckpoint} 的重试动作内部，重试连同回执一起重放。</p>
 *
 * <p>边界：邮件行只改状态不删除；{@code status → CONSUMED} 只是展示态，失败只记日志，不影响回执。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class MailReceiptFlusher {

    private final EmailMessageReceiptRepository receipts;
    private final EmailMessageRepository messages;

    /**
     * 跟进执行属性里登记的已投递邮件：确认交付、尽力清理展示态、清掉本执行已落库的 id。
     *
     * <p>无待写回执时零查询，普通连续轮次不许多出 SQL。</p>
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
            return;
        }
        String executionId = execution.getId();
        Long consumerSessionId = ExecutionAttributes.readLong(attributes, ExecutionAttributes.SESSION_ID);
        Instant now = Instant.now();
        List<EmailMessageReceipt> rows = receipts.findByMessageIds(delivered);
        Map<Long, EmailMessageReceipt> byMessage = new LinkedHashMap<>();
        for (EmailMessageReceipt row : rows) {
            byMessage.put(row.getMessageId(), row);
        }
        List<Long> toConfirm = new ArrayList<>();
        List<Long> missing = new ArrayList<>();
        List<Long> oursDelivered = new ArrayList<>();
        List<Long> conflicts = new ArrayList<>();
        for (Long messageId : delivered) {
            EmailMessageReceipt row = byMessage.get(messageId);
            if (row == null) {
                // 认领行不在（旧属性/兼容装配）：补一条已交付回执，仍按唯一索引幂等。
                missing.add(messageId);
                continue;
            }
            if (!row.isDelivered()) {
                if (executionId.equals(row.getClaimExecutionId())) {
                    toConfirm.add(messageId);
                } else {
                    conflicts.add(messageId);
                }
                continue;
            }
            if (owns(row, executionId, consumerSessionId)) {
                oursDelivered.add(messageId);
            } else {
                conflicts.add(messageId);
            }
        }
        Set<Long> confirmed = new LinkedHashSet<>(
                receipts.markDelivered(toConfirm, executionId, consumerSessionId, now));
        confirmed.addAll(backfillDelivered(missing, consumerSessionId));
        if (!conflicts.isEmpty()) {
            // 归属冲突不许吞掉：这些邮件不由本执行交付，不能算作已投递，也不能就此清掉属主线索。
            log.error("邮件投递归属冲突，本执行未取得交付权: executionId={}, messageIds={}",
                    execution.getId(), conflicts);
        }
        consumeStatus(execution, confirmed);
        Set<Long> prunable = new LinkedHashSet<>(confirmed);
        prunable.addAll(oursDelivered);
        pruneAfterCommit(execution, List.copyOf(prunable));
    }

    /** 已交付且属主是本执行（认领或消费会话对得上）才算「本执行已落库」。 */
    private boolean owns(EmailMessageReceipt row, String executionId, Long consumerSessionId) {
        return executionId.equals(row.getClaimExecutionId())
                || (consumerSessionId != null && consumerSessionId.equals(row.getConsumerSessionId()));
    }

    /** 为没有认领行的旧登记补写已交付回执；撞唯一索引说明别人先到，按已交付处理。 */
    private Set<Long> backfillDelivered(List<Long> messageIds, Long consumerSessionId) {
        Set<Long> written = new LinkedHashSet<>();
        if (messageIds.isEmpty()) {
            return written;
        }
        Map<Long, Long> emailIds = messages.findEmailIdByIds(messageIds);
        for (Long messageId : messageIds) {
            Long emailId = emailIds.get(messageId);
            if (emailId == null) {
                log.warn("邮件行不存在，无法补写回执: messageId={}", messageId);
                continue;
            }
            try {
                receipts.save(EmailMessageReceipt.create(messageId, emailId, consumerSessionId));
                written.add(messageId);
            } catch (DuplicateKeyException collision) {
                written.add(messageId);
            }
        }
        return written;
    }

    /** 展示态清理：status→CONSUMED 只是角标，失败只记日志，不影响回执这一权威事实。 */
    private void consumeStatus(Execution execution, Set<Long> delivered) {
        if (delivered.isEmpty()) {
            return;
        }
        try {
            messages.consumeByIds(delivered);
        } catch (RuntimeException failure) {
            log.warn("邮件状态清理失败，回执不受影响: executionId={}, count={}, error={}",
                    execution.getId(), delivered.size(), failure.toString());
        }
    }

    /**
     * 交付确认后把已落库的 id 从执行属性里摘掉，避免检查点里的清单随会话无限增长。
     *
     * <p>必须在提交之后做：提交前摘掉而事务又回滚了，就会丢掉同一轮内的去重清单。
     * 摘掉之后仍安全 —— 权威判据是库里的回执。</p>
     */
    private void pruneAfterCommit(Execution execution, List<Long> flushed) {
        if (flushed.isEmpty()) {
            return;
        }
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
