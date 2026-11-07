package com.summit.dp.email.domain.repository;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.email.domain.model.EmailMessageReceipt;

import java.util.Collection;
import java.util.List;
import java.util.Set;

/**
 * EmailMessageReceipt 领域仓储：邮件投递回执的权威读写口。
 */
public interface EmailMessageReceiptRepository extends RepositoryTemplate<EmailMessageReceipt, Long> {

    /**
     * 给定候选消息 id，取出其中已有回执的那部分。
     *
     * <p>回执落库前先查一次，避免重试或并发下重复 INSERT 撞唯一索引；
     * 唯一索引仍是最终裁决。</p>
     *
     * @param messageIds 候选消息 id，空集合返回空集合
     * @return 已有回执的消息 id
     */
    Set<Long> findMessageIdsWithReceipt(Collection<Long> messageIds);

    /**
     * 某邮箱下已认领的消息 id（排查与统计用）。
     *
     * @param emailId 邮箱 id
     * @return 消息 id 列表，无回执返回空列表
     */
    List<Long> findMessageIdsByEmailId(Long emailId);
}
