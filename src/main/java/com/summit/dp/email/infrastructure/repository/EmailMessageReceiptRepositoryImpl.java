package com.summit.dp.email.infrastructure.repository;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.email.domain.model.EmailMessageReceipt;
import com.summit.dp.email.domain.repository.EmailMessageReceiptRepository;
import com.summit.dp.email.domain.port.MailClaimLiveness;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMessageReceiptMapper;
import com.summit.dp.email.infrastructure.persistence.po.EmailMessageReceiptPO;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Repository;

import java.time.Duration;
import java.time.Instant;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * EmailMessageReceipt 仓储实现。
 */
@Repository
public class EmailMessageReceiptRepositoryImpl
        extends AbstractRepository<EmailMessageReceipt, EmailMessageReceiptPO, Long>
        implements EmailMessageReceiptRepository {

    private final EmailMessageReceiptMapper mapper;
    private final MailClaimLiveness liveness;

    public EmailMessageReceiptRepositoryImpl(EmailMessageReceiptMapper mapper, MailClaimLiveness liveness) {
        this.mapper = mapper;
        this.liveness = liveness;
    }

    @Override
    protected BaseMapper<EmailMessageReceiptPO> mapper() {
        return this.mapper;
    }

    @Override
    public Set<Long> findMessageIdsWithReceipt(Collection<Long> messageIds) {
        if (messageIds == null || messageIds.isEmpty()) {
            return Set.of();
        }
        Set<Long> recorded = new LinkedHashSet<>();
        for (EmailMessageReceiptPO po : mapper.selectList(Wrappers.<EmailMessageReceiptPO>lambdaQuery()
                .select(EmailMessageReceiptPO::getMessageId)
                .in(EmailMessageReceiptPO::getMessageId, messageIds)
                .isNotNull(EmailMessageReceiptPO::getDeliveredAt))) {
            recorded.add(po.getMessageId());
        }
        return recorded;
    }

    @Override
    public List<EmailMessageReceipt> findByMessageIds(Collection<Long> messageIds) {
        if (messageIds == null || messageIds.isEmpty()) {
            return List.of();
        }
        return mapper.selectList(Wrappers.<EmailMessageReceiptPO>lambdaQuery()
                        .in(EmailMessageReceiptPO::getMessageId, messageIds))
                .stream().map(this::toModel).toList();
    }

    /**
     * 认领：先按 message_id 读一次，再决定插入、接管还是放弃。
     *
     * <p>归属判据是<b>持有者存活</b>，不是租约年龄：持有者未结束（运行中或挂起）就绝不接管。
     * 只有证明它已消失（已结束 / 本进程未登记）才允许重新认领；顶层写入一律用条件更新防并发。</p>
     *
     * <p>墙钟租约只兜「未登记持有者」这一种情形：冷启动后登记表是空的，分不清对方是崩了还是
     * 只是还没走到登记，所以先给一个租约期，过了才允许接管。它不是主判据。</p>
     */
    @Override
    public boolean tryClaim(Long messageId, Long emailId, String executionId, Instant now, Duration lease) {
        if (messageId == null || emailId == null || executionId == null || now == null || lease == null) {
            return false;
        }
        EmailMessageReceiptPO existing = findByMessageId(messageId);
        if (existing == null) {
            try {
                mapper.insert(toPO(EmailMessageReceipt.claim(messageId, emailId, executionId, now)));
                return true;
            } catch (DuplicateKeyException collision) {
                // 并发插入：重新读取，按最新状态再判一次。
                existing = findByMessageId(messageId);
                if (existing == null) {
                    return false;
                }
            }
        }
        if (existing.getDeliveredAt() != null) {
            return false;
        }
        if (executionId.equals(existing.getClaimExecutionId())) {
            // 本执行重复认领：幂等放行并续租，同一执行不会因此丢输入。
            mapper.update(null, Wrappers.<EmailMessageReceiptPO>lambdaUpdate()
                    .set(EmailMessageReceiptPO::getClaimedAt, now)
                    .eq(EmailMessageReceiptPO::getMessageId, messageId)
                    .isNull(EmailMessageReceiptPO::getDeliveredAt));
            return true;
        }
        String holder = existing.getClaimExecutionId();
        if (holder != null && !canTakeOver(holder, existing.getClaimedAt(), now, lease)) {
            return false;
        }
        // 条件接管：只有「读到的那个持有者」还成立时才换人，避免两人同时接管。
        int updated = mapper.update(null, Wrappers.<EmailMessageReceiptPO>lambdaUpdate()
                .set(EmailMessageReceiptPO::getClaimExecutionId, executionId)
                .set(EmailMessageReceiptPO::getClaimedAt, now)
                .eq(EmailMessageReceiptPO::getMessageId, messageId)
                .isNull(EmailMessageReceiptPO::getDeliveredAt)
                .and(wrapper -> {
                    if (holder == null) {
                        wrapper.isNull(EmailMessageReceiptPO::getClaimExecutionId);
                    } else {
                        wrapper.eq(EmailMessageReceiptPO::getClaimExecutionId, holder);
                    }
                }));
        return updated == 1;
    }

    /** 能否接管：持有者已结束可以立刻接管；本进程未登记时用租约兜底；其余一律不许。 */
    private boolean canTakeOver(String holder, Instant claimedAt, Instant now, Duration lease) {
        if (this.liveness.isHolderAlive(holder)) {
            return false;
        }
        if (!this.liveness.isHolderRegistered(holder)) {
            // 无从证明对方已死（冷启动后登记表为空）：给一个租约期再接管。
            return claimedAt == null || !claimedAt.isAfter(now.minus(lease));
        }
        return true;
    }

    /**
     * 确认交付：只更新本执行持有投递权的行，绝不覆盖别人的认领与交付。
     *
     * <p>更新后重新读取并按「归属本执行 + 已交付」判定，冲突时不吞掉、不冒充已交付。</p>
     */
    @Override
    public Set<Long> markDelivered(Collection<Long> messageIds, String executionId, Long consumerSessionId, Instant now) {
        if (messageIds == null || messageIds.isEmpty() || executionId == null || now == null) {
            return Set.of();
        }
        mapper.update(null, Wrappers.<EmailMessageReceiptPO>lambdaUpdate()
                .set(EmailMessageReceiptPO::getDeliveredAt, now)
                .set(EmailMessageReceiptPO::getConsumerSessionId, consumerSessionId)
                .in(EmailMessageReceiptPO::getMessageId, messageIds)
                .eq(EmailMessageReceiptPO::getClaimExecutionId, executionId)
                .isNull(EmailMessageReceiptPO::getDeliveredAt));
        Set<Long> confirmed = new LinkedHashSet<>();
        for (EmailMessageReceiptPO po : mapper.selectList(Wrappers.<EmailMessageReceiptPO>lambdaQuery()
                .select(EmailMessageReceiptPO::getMessageId)
                .in(EmailMessageReceiptPO::getMessageId, messageIds)
                .eq(EmailMessageReceiptPO::getClaimExecutionId, executionId)
                .isNotNull(EmailMessageReceiptPO::getDeliveredAt))) {
            confirmed.add(po.getMessageId());
        }
        return confirmed;
    }

    private EmailMessageReceiptPO findByMessageId(Long messageId) {
        return mapper.selectOne(Wrappers.<EmailMessageReceiptPO>lambdaQuery()
                .eq(EmailMessageReceiptPO::getMessageId, messageId));
    }

    @Override
    public List<Long> findMessageIdsByEmailId(Long emailId) {
        if (emailId == null) {
            return List.of();
        }
        return mapper.selectList(Wrappers.<EmailMessageReceiptPO>lambdaQuery()
                        .select(EmailMessageReceiptPO::getMessageId)
                        .eq(EmailMessageReceiptPO::getEmailId, emailId))
                .stream().map(EmailMessageReceiptPO::getMessageId).toList();
    }

    @Override
    protected EmailMessageReceipt toModel(EmailMessageReceiptPO po) {
        return EmailMessageReceipt.builder()
                .id(po.getId())
                .messageId(po.getMessageId())
                .emailId(po.getEmailId())
                .consumerSessionId(po.getConsumerSessionId())
                .deliveredAt(po.getDeliveredAt())
                .claimExecutionId(po.getClaimExecutionId())
                .claimedAt(po.getClaimedAt())
                .build();
    }

    @Override
    protected EmailMessageReceiptPO toPO(EmailMessageReceipt model) {
        return EmailMessageReceiptPO.builder()
                .id(model.getId())
                .messageId(model.getMessageId())
                .emailId(model.getEmailId())
                .consumerSessionId(model.getConsumerSessionId())
                .deliveredAt(model.getDeliveredAt())
                .claimExecutionId(model.getClaimExecutionId())
                .claimedAt(model.getClaimedAt())
                .build();
    }
}
