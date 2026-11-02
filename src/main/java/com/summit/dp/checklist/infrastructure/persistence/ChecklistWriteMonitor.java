package com.summit.dp.checklist.infrastructure.persistence;

import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.util.concurrent.locks.ReentrantLock;

/** 清单内存监视器持有到事务完成，使聚合的多步判断读取到上一笔提交后的状态。 */
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
