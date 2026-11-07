package com.summit.dp.email.infrastructure.repository;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.email.domain.model.EmailMessageReceipt;
import com.summit.dp.email.domain.repository.EmailMessageReceiptRepository;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMessageReceiptMapper;
import com.summit.dp.email.infrastructure.persistence.po.EmailMessageReceiptPO;
import org.springframework.stereotype.Repository;

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

    public EmailMessageReceiptRepositoryImpl(EmailMessageReceiptMapper mapper) {
        this.mapper = mapper;
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
                .in(EmailMessageReceiptPO::getMessageId, messageIds))) {
            recorded.add(po.getMessageId());
        }
        return recorded;
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
                .build();
    }
}
