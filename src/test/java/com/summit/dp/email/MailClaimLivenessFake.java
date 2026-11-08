package com.summit.dp.email;

import com.summit.dp.email.domain.port.MailClaimLiveness;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 存活判定的测试替身：显式表达「持有者还活着 / 已结束 / 本进程没有它的登记」。
 *
 * <p>默认什么都没登记（冷启动后的形态），因此不显式声明的执行一律按已消失处理 ——
 * 需要「持有者仍活着」的用例必须调用 {@link #alive} 或 {@link #suspended} 说清楚。</p>
 */
public class MailClaimLivenessFake implements MailClaimLiveness {

    private final Set<String> alive = ConcurrentHashMap.newKeySet();
    private final Set<String> registered = ConcurrentHashMap.newKeySet();

    /** 运行中：登记在、未结束。 */
    public MailClaimLivenessFake alive(String executionId) {
        this.registered.add(executionId);
        this.alive.add(executionId);
        return this;
    }

    /** 挂起：登记还在、正跑模型途中没有检查点提交，但恢复后会继续确认交付 —— 仍算持有者。 */
    public MailClaimLivenessFake suspended(String executionId) {
        this.registered.add(executionId);
        this.alive.add(executionId);
        return this;
    }

    /** 已结束：登记可能还在，但执行不会再确认交付。 */
    public MailClaimLivenessFake finished(String executionId) {
        this.registered.add(executionId);
        this.alive.remove(executionId);
        return this;
    }

    /** 冷启动/崩溃恢复后的形态：本进程完全没有它的登记。 */
    public MailClaimLivenessFake forgotten(String executionId) {
        this.registered.remove(executionId);
        this.alive.remove(executionId);
        return this;
    }

    @Override
    public boolean isHolderAlive(String executionId) {
        return this.alive.contains(executionId);
    }

    @Override
    public boolean isHolderRegistered(String executionId) {
        return this.registered.contains(executionId);
    }
}
