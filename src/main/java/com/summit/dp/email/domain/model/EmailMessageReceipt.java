package com.summit.dp.email.domain.model;

import cn.hutool.core.util.IdUtil;
import lombok.Builder;
import lombok.Getter;

import java.time.Duration;
import java.time.Instant;

/**
 * 邮件投递回执：某条邮件消息已被某个消费会话认领过。
 *
 * <p><b>为什么它是注入去重的权威判据</b>：信箱是会话级共享资源（键＝根会话＋收件 Agent），
 * 执行每轮新建，把「已投递」记在执行属性里必然在下一轮丢失。回执落在库里、逐条认领，
 * 冷启动/重启都能重新证明。</p>
 *
 * <p><b>与消息 status 的分工</b>：邮件行只改状态不删除，{@code status = CONSUMED} 只是展示态；
 * 判据只看有没有回执。曾经的「已被清理但没记录回执」窗口由此不再丢输入。</p>
 *
 * <p><b>两种状态</b>：{@code deliveredAt == null} 是「已认领未交付」的租约，持有者崩溃后过期可被重新认领；
 * {@code deliveredAt != null} 才是权威交付事实。租约只包住两次短事务，绝不跨模型调用持有。</p>
 */
@Builder
@Getter
public class EmailMessageReceipt {

    private final Long id;
    /** 被认领的邮件消息 id，全局唯一（一封信只投递一次）。 */
    private final Long messageId;
    /** 消息所属邮箱，仅供排查与按邮箱统计。 */
    private final Long emailId;
    /** 真正把这条消息交付进上下文并提交了检查点的会话 id；未交付时为空。 */
    private final Long consumerSessionId;
    /** 权威交付时刻；为空表示「已认领未交付」，租约过期后可被重新认领。 */
    private final Instant deliveredAt;
    /** 持有投递租约的执行 id。 */
    private final String claimExecutionId;
    /** 租约取得时刻，用于判定是否过期（持有者崩溃后的可重认领窗口）。 */
    private final Instant claimedAt;

    /**
     * 新建一条「已认领未交付」的租约行。
     *
     * @param messageId       被认领的消息 id，不能为空
     * @param emailId         消息所属邮箱 id，不能为空
     * @param executionId     取得租约的执行 id，不能为空
     * @param claimedAt       取得租约的时刻，不能为空
     * @return 待落库的租约回执
     */
    public static EmailMessageReceipt claim(Long messageId, Long emailId, String executionId, Instant claimedAt) {
        if (messageId == null || emailId == null || executionId == null || claimedAt == null) {
            throw new IllegalArgumentException("邮件回执认领必须带上消息 id、邮箱 id、执行 id 与时刻");
        }
        return EmailMessageReceipt.builder()
                .id(IdUtil.getSnowflakeNextId())
                .messageId(messageId)
                .emailId(emailId)
                .claimExecutionId(executionId)
                .claimedAt(claimedAt)
                .build();
    }

    /**
     * 新建一条已交付回执（历史补写与兼容装配使用）。
     *
     * @param messageId         被认领的消息 id，不能为空
     * @param emailId           消息所属邮箱 id，不能为空
     * @param consumerSessionId 消费会话 id，可为空（只作审计）
     * @return 待落库的已交付回执
     */
    public static EmailMessageReceipt create(Long messageId, Long emailId, Long consumerSessionId) {
        if (messageId == null || emailId == null) {
            throw new IllegalArgumentException("邮件回执必须带上消息 id 与邮箱 id");
        }
        return EmailMessageReceipt.builder()
                .id(IdUtil.getSnowflakeNextId())
                .messageId(messageId)
                .emailId(emailId)
                .consumerSessionId(consumerSessionId)
                .deliveredAt(Instant.now())
                .build();
    }

    /** 是否已是权威交付事实（认领只是租约，不算交付）。 */
    public boolean isDelivered() {
        return this.deliveredAt != null;
    }

    /** 租约是否仍在本执行手上且尚未过期。 */
    public boolean isClaimedBy(String executionId, Instant now, Duration lease) {
        if (isDelivered() || this.claimExecutionId == null || !this.claimExecutionId.equals(executionId)) {
            return false;
        }
        return this.claimedAt != null && this.claimedAt.plus(lease).isAfter(now);
    }
}

