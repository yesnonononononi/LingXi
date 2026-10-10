package com.summit.dp.agent.infrastructure.runtime;

import com.summit.dp.shared.exception.ClientException;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@link SessionExecutionRegistry} 的最小行为验证，重点是 HC-2 的结构性兜底与单飞约束：
 * {@code beginRoot(null)} 必须立刻抛出；同一根会话重复 {@code beginRoot} 必须被拒绝。
 */
class SessionExecutionRegistryTest {

    /** HC-2：身份未解析就注册运行 = 调用方顺序错误，必须炸。 */
    @Test
    void beginRootRejectsNullSessionId() {
        SessionExecutionRegistry registry = new SessionExecutionRegistry();
        assertThrows(NullPointerException.class, () -> registry.beginRoot(null));
    }

    @Test
    void beginRootRegistersRootAndFinishCleansUp() {
        SessionExecutionRegistry registry = new SessionExecutionRegistry();
        assertDoesNotThrow(() -> registry.beginRoot(42L));
        assertFalse(registry.isCancelled(42L));
        registry.finishRoot(42L);
        // 清理后对同一会话可以再次 beginRoot（下一轮对话）。
        assertDoesNotThrow(() -> registry.beginRoot(42L));
        assertFalse(registry.isCancelled(42L));
    }

    @Test
    void cancelRootMarksCancelledAndBlocksNewChildren() {
        SessionExecutionRegistry registry = new SessionExecutionRegistry();
        registry.beginRoot(7L);
        assertTrue(registry.bindRunningChild(7L, 8L, Thread.currentThread()));
        registry.cancelRoot(7L);
        assertTrue(registry.isCancelled(7L));
        // 根已取消后，新的子任务不允许再启动。
        assertFalse(registry.bindRunningChild(7L, 9L, Thread.currentThread()));
    }

    /** 单飞：同一会话已有执行在跑时，重入 beginRoot 必须抛 ClientException。 */
    @Test
    void beginRootRejectsConcurrentRun() {
        SessionExecutionRegistry registry = new SessionExecutionRegistry();
        registry.beginRoot(11L);
        assertThrows(ClientException.class, () -> registry.beginRoot(11L),
                "同一会话已在进行中，重入应被拒绝");
    }

    /** 单飞：finishRoot 清位后，同一会话可立即重新发起。 */
    @Test
    void beginRootAllowedAfterFinish() {
        SessionExecutionRegistry registry = new SessionExecutionRegistry();
        registry.beginRoot(21L);
        registry.finishRoot(21L);
        assertDoesNotThrow(() -> registry.beginRoot(21L), "上一轮结束后应可重新发起");
    }

    /**
     * 单飞：cancelRoot（stop 路径）清位后，同一会话可立即重新发起；
     * 且 cancelRoot 不改变「根已取消则新子任务被拒」的既有语义。
     */
    @Test
    void beginRootAllowedAfterCancel() {
        SessionExecutionRegistry registry = new SessionExecutionRegistry();
        registry.beginRoot(31L);

        // stop 之前：未取消，子任务可注册。
        assertTrue(registry.bindRunningChild(31L, 32L, Thread.currentThread()));
        assertFalse(registry.isCancelled(31L));

        registry.cancelRoot(31L);

        // stop 语义回归：已取消 → 新子任务被拒。
        assertTrue(registry.isCancelled(31L));
        assertFalse(registry.bindRunningChild(31L, 33L, Thread.currentThread()));

        // stop 后必须能立即重新发起：cancelRoot 已清 rootRunning，新的 beginRoot 又复位 cancelled。
        assertDoesNotThrow(() -> registry.beginRoot(31L), "stop 之后应可重新发起");
        assertFalse(registry.isCancelled(31L), "重新发起后取消标志应复位");
        assertTrue(registry.bindRunningChild(31L, 34L, Thread.currentThread()),
                "重新发起后子任务应可注册");
    }

    /** HC-2 回归：beginRoot(null) 仍抛 NPE，且不残留任何注册痕迹。 */
    @Test
    void beginRootNullLeavesNoResidue() {
        SessionExecutionRegistry registry = new SessionExecutionRegistry();
        assertThrows(NullPointerException.class, () -> registry.beginRoot(null));
        assertFalse(registry.isCancelled(null));
    }
}
