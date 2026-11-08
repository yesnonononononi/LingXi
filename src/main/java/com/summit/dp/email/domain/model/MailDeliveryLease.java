package com.summit.dp.email.domain.model;

import java.time.Duration;

/**
 * 邮件投递租约的兜底时长。
 *
 * <p>归属判据是持有者存活（见 {@code MailClaimLiveness}），本常量只兜「持有者在本进程未登记」
 * 这一种情形：冷启动后登记表为空，分不清对方是崩了还是还没登记，先等一个租约期再接管。
 * 它不是主判据，也不靠「设长一点」来避免冲突 —— 那样只是把墙钟赌博拉长。</p>
 */
public final class MailDeliveryLease {

    /** 未登记持有者的兜底等待时长。 */
    public static final Duration DURATION = Duration.ofSeconds(30);

    private MailDeliveryLease() {
    }
}
