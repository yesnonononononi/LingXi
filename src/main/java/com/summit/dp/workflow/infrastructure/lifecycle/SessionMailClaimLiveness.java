package com.summit.dp.workflow.infrastructure.lifecycle;

import com.summit.dp.email.domain.port.MailClaimLiveness;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/**
 * 存活判定的 workflow 侧适配器：把执行登记表的语义接到邮件投递归属的领域端口上。
 *
 * <p>放在基础设施层是为了让邮件域不依赖 workflow：领域只知道「持有者是否仍未结束」。</p>
 */
@Component
@RequiredArgsConstructor
public class SessionMailClaimLiveness implements MailClaimLiveness {

    private final SessionExecutionRegistry registry;

    @Override
    public boolean isHolderAlive(String executionId) {
        return this.registry.isHolderAlive(executionId);
    }

    @Override
    public boolean isHolderRegistered(String executionId) {
        return this.registry.isRegistered(executionId);
    }
}
