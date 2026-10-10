package com.summit.dp.agent.infrastructure.runtime;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@link SessionExecutionRegistry} 的分阶段生命周期判据（T01）。
 *
 * <p>五条判据覆盖「待启动 → 运行 → 挂起 → 终态」的完整跃迁与取消快照的阶段语义，
 * 重点验证：① 待启动即计入「未结束」（提交前登记的窗口不漏判）；② 挂起保留登记但释放死线程引用；
 * ③ 只有真正终态才移除并返回 {@code becameEmpty}；④ 撤销路径不留残留；⑤ 取消快照按阶段区分活线程。</p>
 */
class SessionExecutionRegistryLifecycleTest {

    private static final long ROOT_SESSION = 100L;
    private static final long CHILD_SESSION = 200L;

    /** 判据 1：提交前登记「待启动」即计入未结束，且此时无活线程。 */
    @Test
    @DisplayName("判据1 待启动阶段：登记后未结束；取消快照 phase=PENDING_START 且无活线程")
    void pendingStartIsTrackedWithoutLiveThread() {
        SessionExecutionRegistry registry = new SessionExecutionRegistry();

        assertTrue(registry.registerPendingChild(ROOT_SESSION, CHILD_SESSION));
        assertTrue(registry.hasUnfinishedChildren(ROOT_SESSION));

        List<SessionExecutionRegistry.ChildExecution> snapshot = registry.cancelRoot(ROOT_SESSION);
        assertEquals(1, snapshot.size());
        assertEquals(ChildPhase.PENDING_START, snapshot.getFirst().phase());
        assertNull(snapshot.getFirst().thread(), "待启动子执行没有可打断的活线程");
    }

    /** 判据 2：开跑绑定运行线程；取消快照带该活线程。 */
    @Test
    @DisplayName("判据2 运行阶段：绑定后未结束；取消快照 phase=RUNNING 且携带活线程")
    void runningStageCarriesLiveThread() {
        SessionExecutionRegistry registry = new SessionExecutionRegistry();
        registry.registerPendingChild(ROOT_SESSION, CHILD_SESSION);

        Thread loopThread = Thread.currentThread();
        assertTrue(registry.bindRunningChild(ROOT_SESSION, CHILD_SESSION, loopThread));
        assertTrue(registry.hasUnfinishedChildren(ROOT_SESSION));

        List<SessionExecutionRegistry.ChildExecution> snapshot = registry.cancelRoot(ROOT_SESSION);
        assertEquals(1, snapshot.size());
        assertEquals(ChildPhase.RUNNING, snapshot.getFirst().phase());
        assertSame(loopThread, snapshot.getFirst().thread(), "运行阶段必须携带可 interrupt 的活线程");
    }

    /** 判据 3：挂起保留登记、释放死线程引用，父侧仍记「未结束」。 */
    @Test
    @DisplayName("判据3 挂起阶段：仍算未结束；取消快照 phase=SUSPENDED 且线程已置空")
    void suspendedStageKeepsEntryButDropsThread() {
        SessionExecutionRegistry registry = new SessionExecutionRegistry();
        registry.bindRunningChild(ROOT_SESSION, CHILD_SESSION, Thread.currentThread());

        registry.markChildSuspended(ROOT_SESSION, CHILD_SESSION);

        assertTrue(registry.hasUnfinishedChildren(ROOT_SESSION),
                "子执行等人工审批期间父侧仍须记为未结束，否则根会提前收尾、唤醒丢失");
        List<SessionExecutionRegistry.ChildExecution> snapshot = registry.cancelRoot(ROOT_SESSION);
        assertEquals(ChildPhase.SUSPENDED, snapshot.getFirst().phase());
        assertNull(snapshot.getFirst().thread(), "挂起后不再持有死线程引用");
    }

    /** 判据 4：真正终态移除登记并回报 becameEmpty（唤醒门控）。 */
    @Test
    @DisplayName("判据4 终态移除：单一子终结返回 becameEmpty=true；多子逐个终结只在末次为 true")
    void terminalRemovalReportsBecameEmpty() {
        SessionExecutionRegistry registry = new SessionExecutionRegistry();
        registry.bindRunningChild(ROOT_SESSION, CHILD_SESSION, Thread.currentThread());
        registry.bindRunningChild(ROOT_SESSION, CHILD_SESSION + 1, Thread.currentThread());

        assertFalse(registry.unregisterChild(ROOT_SESSION, CHILD_SESSION), "非最后一个不得误报空");
        assertTrue(registry.unregisterChild(ROOT_SESSION, CHILD_SESSION + 1), "最后一个终结才成为空");
        assertFalse(registry.hasUnfinishedChildren(ROOT_SESSION));
    }

    /** 判据 5：撤销路径只清条目、无唤醒语义；对未知子执行是幂等 no-op。 */
    @Test
    @DisplayName("判据5 撤销路径：撤销待启动登记后未结束收敛；撤销不存在的子执行不抛异常且 retains 不动")
    void revokeClearsWithoutWakeSideEffects() {
        SessionExecutionRegistry registry = new SessionExecutionRegistry();
        registry.registerPendingChild(ROOT_SESSION, CHILD_SESSION);
        registry.bindRunningChild(ROOT_SESSION, CHILD_SESSION + 1, Thread.currentThread());

        registry.revokeChild(ROOT_SESSION, CHILD_SESSION);
        assertTrue(registry.hasUnfinishedChildren(ROOT_SESSION), "仅撤销其一，另一个仍在跑");

        registry.revokeChild(ROOT_SESSION, 999L);
        assertTrue(registry.hasUnfinishedChildren(ROOT_SESSION), "撤销不存在的子执行是无害 no-op");

        registry.revokeChild(ROOT_SESSION, CHILD_SESSION + 1);
        assertFalse(registry.hasUnfinishedChildren(ROOT_SESSION));
    }
}
