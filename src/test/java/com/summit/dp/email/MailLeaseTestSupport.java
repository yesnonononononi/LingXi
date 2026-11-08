package com.summit.dp.email;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMessageReceiptMapper;
import com.summit.dp.email.infrastructure.persistence.po.EmailMessageReceiptPO;

import java.time.Duration;
import java.time.Instant;

/**
 * 测试助手：把未交付的认领整体置为过期租约。
 *
 * <p>用来表达「持有者崩溃且已超过租约期」——只有这之后，另一个执行或重启后的同一执行
 * 才被允许重新认领这条输入（租约内不抢，避免两份上下文各投一次）。</p>
 */
public final class MailLeaseTestSupport {

    private MailLeaseTestSupport() {
    }

    public static void expireClaims(EmailMessageReceiptMapper mapper) {
        mapper.update(null, Wrappers.<EmailMessageReceiptPO>lambdaUpdate()
                .set(EmailMessageReceiptPO::getClaimedAt, Instant.now().minus(Duration.ofHours(1)))
                .isNull(EmailMessageReceiptPO::getDeliveredAt));
    }
}
