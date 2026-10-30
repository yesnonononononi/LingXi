package com.summit.dp.checklist.infrastructure.persistence;

import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.util.concurrent.locks.ReentrantLock;

/**
 * 清单聚合的进程内写监视器（替代 SQLite 上不存在的 {@code SELECT ... FOR UPDATE}）。
 *
 * <p><b>为什么需要它</b>：清单的写路径是「读聚合 → 按业务规则判断 → 写回」，中间有无法用
 * 单条条件更新表达的业务判断（步骤推进、提醒收口、重新激活）。SQLite 只有一个写者、没有行锁，
 * 这类逻辑只能靠应用级串行化保证「同一时刻只有一方在裁决清单」。</p>
 *
 * <p><b>为什么是单锁而不是按 id 分片</b>：{@code findByIdForUpdate} 在拿到 checklistId 之前
 * 还不知道归属会话，分片键无法统一；清单写入本身是低频操作，一把公平锁足够，
 * 也避免「同一聚合被不同键分别加锁」导致的互不排斥。</p>
 *
 * <p><b>锁的生命周期 = 所在事务</b>：事务里获取的锁登记为 {@code afterCompletion} 释放，
 * 这样锁一直持有到提交/回滚完成，竞争方在锁上等待期间不会执行任何语句
 * （SQLite 的读快照在第一条语句才固定），拿到锁后读到的一定是已提交的新状态。</p>
 */
public final class ChecklistWriteMonitor {

    /** 公平锁：先到先得，避免提醒线程长期抢不到锁。 */
    private static final ReentrantLock LOCK = new ReentrantLock(true);

    private ChecklistWriteMonitor() {
    }

    /**
     * 获取清单写监视器；当前事务结束时自动释放。
     *
     * <p>可重入：同一线程在事务内多次进入（例如先锁定位再推进步骤）只在最外层真正生效，
     * 每层各登记一次释放，计数天然平衡。</p>
     *
     * <p>不在事务里时立即释放：没有事务就没有「读后判断再写」的临界区，
     * 单条语句本身是原子的，不需要额外串行化。</p>
     */
    public static void acquireForCurrentTransaction() {
        LOCK.lock();
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            LOCK.unlock();
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCompletion(int status) {
                LOCK.unlock();
            }
        });
    }
}
