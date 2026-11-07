package com.summit.dp.email.domain.model;

import cn.hutool.core.util.IdUtil;
import lombok.Builder;
import lombok.Getter;

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
 */
@Builder
@Getter
public class EmailMessageReceipt {

    private final Long id;
    /** 被认领的邮件消息 id，全局唯一（一封信只投递一次）。 */
    private final Long messageId;
    /** 消息所属邮箱，仅供排查与按邮箱统计。 */
    private final Long emailId;
    /** 认领这条消息的消费会话 id，只作审计展示。 */
    private final Long consumerSessionId;
    private final Instant deliveredAt;

    /**
     * 新建一条回执（id 由应用层雪花生成，交付时刻取当前）。
     *
     * @param messageId         被认领的消息 id，不能为空
     * @param emailId           消息所属邮箱 id，不能为空
     * @param consumerSessionId 消费会话 id，可为空（只作审计）
     * @return 待落库的回执
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
}
