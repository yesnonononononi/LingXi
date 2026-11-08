package com.summit.dp.email.domain.model;

import java.time.Duration;

/**
 * 邮件投递租约的时长上限。
 *
 * <p>租约只包住「认领」到「检查点提交」这两次短事务，绝不跨模型调用持有；
 * 因此它很短，崩溃后最多等这么久输入就能被重新投递（宁可延迟，不可丢失）。</p>
 */
public final class MailDeliveryLease {

    /** 租约有效期：超过它的认领视为持有者已崩溃，可被重新认领。 */
    public static final Duration DURATION = Duration.ofSeconds(30);

    private MailDeliveryLease() {
    }
}
