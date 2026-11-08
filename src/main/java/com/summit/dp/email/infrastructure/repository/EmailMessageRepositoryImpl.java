package com.summit.dp.email.infrastructure.repository;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.email.domain.model.EmailMessage;
import com.summit.dp.email.domain.repository.EmailMessageRepository;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMessageMapper;
import com.summit.dp.email.infrastructure.persistence.po.EmailMessagePO;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * EmailMessage 仓储实现。
 */
@Repository
public class EmailMessageRepositoryImpl extends AbstractRepository<EmailMessage, EmailMessagePO, Long>
        implements EmailMessageRepository {

    private final EmailMessageMapper mapper;

    public EmailMessageRepositoryImpl(EmailMessageMapper mapper) {
        this.mapper = mapper;
    }

    @Override
    protected BaseMapper<EmailMessagePO> mapper() {
        return this.mapper;
    }

    @Override
    public Collection<EmailMessage> findList(Collection<Long> ids) {
        return super.findList(ids);
    }

    @Override
    public Optional<EmailMessage> findByDedupKeyForUpdate(String dedupKey) {
        // 消息只投递一次，由唯一索引裁决重复写入。
        EmailMessagePO po = mapper.selectOne(Wrappers.<EmailMessagePO>lambdaQuery()
                .eq(EmailMessagePO::getDedupKey, dedupKey).last("FOR UPDATE"));
        return po == null ? Optional.empty() : Optional.of(toModel(po));
    }

    @Override
    public List<EmailMessage> findByEmailId(Long emailId) {
        return mapper.selectList(Wrappers.<EmailMessagePO>lambdaQuery()
                        .eq(EmailMessagePO::getEmailId, emailId)
                        .orderByAsc(EmailMessagePO::getCreateAt)
                        .orderByAsc(EmailMessagePO::getId))
                .stream().map(this::toModel).toList();
    }

    @Override
    public void deleteByEmailId(Long emailId) {
        if (emailId == null) {
            return;
        }
        mapper.delete(Wrappers.<EmailMessagePO>lambdaQuery()
                .eq(EmailMessagePO::getEmailId, emailId));
    }

    @Override
    public List<EmailMessage> findPendingByEmailIds(Collection<Long> emailIds) {
        if (emailIds == null || emailIds.isEmpty()) {
            return List.of();
        }
        return mapper.selectList(Wrappers.<EmailMessagePO>lambdaQuery()
                        .in(EmailMessagePO::getEmailId, emailIds)
                        .eq(EmailMessagePO::getStatus, EmailMessage.EMStatus.PENDING.name())
                        .orderByAsc(EmailMessagePO::getCreateAt)
                        .orderByAsc(EmailMessagePO::getId))
                .stream().map(this::toModel).toList();
    }

    @Override
    public List<EmailMessage> findUndeliveredByEmailIds(Collection<Long> emailIds) {
        if (emailIds == null || emailIds.isEmpty()) {
            return List.of();
        }
        // 判据是「没有已交付回执」：已认领未交付仍算待投递（由认领裁决归属），与 status、id 大小都无关。
        return mapper.selectList(Wrappers.<EmailMessagePO>lambdaQuery()
                        .in(EmailMessagePO::getEmailId, emailIds)
                        .notExists("SELECT 1 FROM email_message_receipt r WHERE r.message_id = email_message.id"
                                + " AND r.delivered_at IS NOT NULL")
                        .orderByAsc(EmailMessagePO::getCreateAt)
                        .orderByAsc(EmailMessagePO::getId))
                .stream().map(this::toModel).toList();
    }

    @Override
    public Map<Long, Long> findEmailIdByIds(Collection<Long> messageIds) {
        if (messageIds == null || messageIds.isEmpty()) {
            return Map.of();
        }
        Map<Long, Long> emailIds = new HashMap<>();
        for (EmailMessagePO po : mapper.selectList(Wrappers.<EmailMessagePO>lambdaQuery()
                .select(EmailMessagePO::getId, EmailMessagePO::getEmailId)
                .in(EmailMessagePO::getId, messageIds))) {
            if (po.getId() != null && po.getEmailId() != null) {
                emailIds.put(po.getId(), po.getEmailId());
            }
        }
        return emailIds;
    }

    @Override
    public int consumeByIds(Collection<Long> messageIds) {
        if (messageIds == null || messageIds.isEmpty()) {
            return 0;
        }
        // 只影响展示态：仍为 PENDING 才置 CONSUMED，已消费的行不重复触碰 update_at。
        return mapper.update(null, Wrappers.<EmailMessagePO>lambdaUpdate()
                .set(EmailMessagePO::getStatus, EmailMessage.EMStatus.CONSUMED.name())
                .set(EmailMessagePO::getUpdateAt, Instant.now())
                .in(EmailMessagePO::getId, messageIds)
                .eq(EmailMessagePO::getStatus, EmailMessage.EMStatus.PENDING.name()));
    }

    @Override
    public int consumePendingById(Long id) {
        // 条件更新：仅 PENDING 可被置为 CONSUMED，where 条件兜住并发下的重复消费
        return mapper.update(null, Wrappers.<EmailMessagePO>lambdaUpdate()
                .set(EmailMessagePO::getStatus, EmailMessage.EMStatus.CONSUMED.name())
                .set(EmailMessagePO::getUpdateAt, Instant.now())
                .eq(EmailMessagePO::getId, id)
                .eq(EmailMessagePO::getStatus, EmailMessage.EMStatus.PENDING.name()));
    }

    @Override
    public int consumePendingByIds(Collection<EmailMessage> messages) {
        if (messages == null || messages.isEmpty()) {
            return 0;
        }
        // 单条条件 UPDATE：in ids 且仍 PENDING 才置 CONSUMED，生效行数供事务内乐观校验
        return mapper.update(null, Wrappers.<EmailMessagePO>lambdaUpdate()
                .set(EmailMessagePO::getStatus, EmailMessage.EMStatus.CONSUMED.name())
                .set(EmailMessagePO::getUpdateAt, Instant.now())
                .in(EmailMessagePO::getId, messages.stream().map(EmailMessage::getId).toList())
                .eq(EmailMessagePO::getStatus, EmailMessage.EMStatus.PENDING.name()));
    }

    @Override
    protected EmailMessage toModel(EmailMessagePO po) {
        return EmailMessage.builder()
                .id(po.getId())
                .emailId(po.getEmailId())
                .senderId(po.getSenderId())
                .dedupKey(po.getDedupKey())
                .content(po.getContent())
                .status(po.getStatus() == null ? null : EmailMessage.EMStatus.valueOf(po.getStatus()))
                .createAt(po.getCreateAt())
                .updateAt(po.getUpdateAt())
                .build();
    }

    @Override
    protected EmailMessagePO toPO(EmailMessage model) {
        return EmailMessagePO.builder()
                .id(model.getId())
                .emailId(model.getEmailId())
                .senderId(model.getSenderId())
                .dedupKey(model.getDedupKey())
                .content(model.getContent())
                .status(model.getStatus() == null ? null : model.getStatus().name())
                .createAt(model.getCreateAt())
                .updateAt(model.getUpdateAt())
                .build();
    }
}
