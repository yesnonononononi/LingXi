package com.summit.dp.email.infrastructure.repository;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.email.domain.model.EmailMessage;
import com.summit.dp.email.domain.repository.EmailMessageRepository;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMessageMapper;
import com.summit.dp.email.infrastructure.persistence.po.EmailMessagePO;
import org.jetbrains.annotations.NotNull;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.Collection;
import java.util.List;

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
    protected @NotNull BaseMapper<EmailMessagePO> mapper() {
        return this.mapper;
    }

    @Override
    public Collection<EmailMessage> findList(Collection<Long> ids) {
        return super.findList(ids);
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
                .content(model.getContent())
                .status(model.getStatus() == null ? null : model.getStatus().name())
                .createAt(model.getCreateAt())
                .updateAt(model.getUpdateAt())
                .build();
    }
}
