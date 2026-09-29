package com.summit.dp.email.domain.model;

import lombok.Builder;
import lombok.Getter;

import java.time.Instant;

/**
 * EmailMessage 领域模型：邮件聚合内的消息，生命周期为 PENDING → CONSUMED。
 * <p>状态推进收敛为 {@link #consume()}；内容修订收敛为 {@link #updateContent(String)}，
 * 两者均由领域方法维护 {@code updateAt}。</p>
 */
@Builder
@Getter
public class EmailMessage {
    public enum EMStatus {
        PENDING,
        CONSUMED
    }

    private final Long id;
    private final Long emailId;
    private final Long senderId;
    private String content;
    private EMStatus status;
    private final Instant createAt;
    private Instant updateAt;

    public boolean isPending() {
        return status == EMStatus.PENDING;
    }

    public boolean isConsumed() {
        return status == EMStatus.CONSUMED;
    }

    /**
     * 消费消息：PENDING → CONSUMED。是否允许消费（仅 PENDING）由应用层守卫。
     */
    public void consume() {
        this.status = EMStatus.CONSUMED;
        this.updateAt = Instant.now();
    }

    /**
     * 修订消息内容。
     */
    public void updateContent(String content) {
        this.content = content;
        this.updateAt = Instant.now();
    }
}
