package com.summit.dp.email.domain.repository;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.email.domain.model.EmailMessageReceipt;

import java.time.Duration;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Set;

/**
 * EmailMessageReceipt 领域仓储：邮件投递回执的权威读写口。
 */
public interface EmailMessageReceiptRepository extends RepositoryTemplate<EmailMessageReceipt, Long> {

    /**
     * 给定候选消息 id，取出其中<b>已交付</b>的那部分（认领未交付不算）。
     *
     * @param messageIds 候选消息 id，空集合返回空集合
     * @return 已交付的消息 id
     */
    Set<Long> findMessageIdsWithReceipt(Collection<Long> messageIds);

    /**
     * 按消息 id 批量取回执行（判定租约归属与是否已交付）。
     *
     * @param messageIds 候选消息 id，空集合返回空列表
     * @return 命中的回执
     */
    List<EmailMessageReceipt> findByMessageIds(Collection<Long> messageIds);

    /**
     * 逐条认领投递权：拿到（或接管过期租约）返回 {@code true}。
     *
     * <p>唯一索引 {@code message_id} 是最终裁决；本方法自己重新读取，不在碰撞后沿用旧判断。</p>
     *
     * @param messageId   消息 id
     * @param emailId     消息所属邮箱 id
     * @param executionId 申请认领的执行 id
     * @param now         当前时刻
     * @param lease       租约有效期
     * @return 本执行是否取得了投递权
     */
    boolean tryClaim(Long messageId, Long emailId, String executionId, Instant now, Duration lease);

    /**
     * 确认交付：把本执行持有租约的消息置为已交付。
     *
     * @param messageIds        本批消息 id，空集合返回空集合
     * @param executionId       当前执行 id
     * @param consumerSessionId 消费会话 id，可为空
     * @param now               交付时刻
     * @return 本次或此前已由本执行确认交付的消息 id
     */
    Set<Long> markDelivered(Collection<Long> messageIds, String executionId, Long consumerSessionId, Instant now);

    /**
     * 某邮箱下的消息 id（排查与统计用）。
     *
     * @param emailId 邮箱 id
     * @return 消息 id 列表，无回执返回空列表
     */
    List<Long> findMessageIdsByEmailId(Long emailId);
}
