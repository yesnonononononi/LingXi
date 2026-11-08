package com.summit.dp.workflow.infrastructure.lifecycle;

import com.summit.core.runtime.loop.ExecutionControlSignal;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * 邮件投递归属的存活口径，直接测<b>生产实现</b>（不是 {@code MailClaimLivenessFake}）。
 *
 * <h2>为什么必须有这一组</h2>
 *
 * <p>「谁还持有投递权」是邮件只投一次的唯一凭据。此前这条口径只由替身表达 ——
 * {@code MailClaimLivenessFake#suspended} 写了「挂起算活」，却没有任何用例碰
 * {@link SessionExecutionRegistry#isHolderAlive} 本身，因此把实现改成「只有 running 算活」
 * 全量用例依然全绿。后果不是少投，而是<b>双投</b>：持有者在挂起期间被他人接管，
 * 恢复后两个执行各自把这封邮件注入一次上下文。</p>
 *
 * <h2>与 {@link SessionExecutionRegistry#isActive} 的分界</h2>
 *
 * <p>{@code isActive} 只表示「此刻正占用运行槽」；投递归属用的是更宽的「未结束即持有」。
 * 两者差的正是「挂起」这一档 —— 本组用例把这一档单独钉死。</p>
 *
 * <p>全部状态都由 registry 的公开 API 拼出（{@code acquire / release / recordExecution /
 * restoreExecution / beginRoot / cancelRoot / forgetFinishedExecution}），不反射改私有字段。</p>
 */
class SessionExecutionRegistryHolderLivenessTest {

    private static final long ROOT_SESSION_ID = 610L;
    private static final long CHILD_SESSION_ID = 611L;

    @Test
    @DisplayName("运行中：登记在、未结束 → alive=true")
    void runningExecutionIsAlive() {
        SessionExecutionRegistry registry = new SessionExecutionRegistry();
        registry.acquire("live-running");

        assertTrue(registry.isActive("live-running"), "拿到运行占用后必须算 running");
        assertTrue(registry.isRegistered("live-running"));
        assertTrue(registry.isHolderAlive("live-running"), "运行中必须算持有者");
    }

    @Test
    @DisplayName("挂起（槽位仍在、非 running、未 finished）→ alive=true")
    void suspendedExecutionStillHoldsOwnership() {
        SessionExecutionRegistry registry = new SessionExecutionRegistry();
        ExecutionControlSignal signal = registry.acquire("live-suspended");
        assertTrue(registry.release(signal), "释放运行占用必须成功");

        assertFalse(registry.isActive("live-suspended"),
                "挂起后不再算 running —— 这正是 isActive 与 isHolderAlive 的分界点");
        assertTrue(registry.isRegistered("live-suspended"), "挂起不摘登记，槽位仍在");
        assertTrue(registry.isHolderAlive("live-suspended"),
                "挂起期间没有检查点提交、恢复后还要继续确认交付，必须仍算持有者");
    }

    @Test
    @DisplayName("已结束：登记可以还在（等清理），但 alive=false")
    void finishedExecutionLosesOwnershipWhileRegistrationRemains() {
        SessionExecutionRegistry registry = new SessionExecutionRegistry();
        registry.restoreExecution(ROOT_SESSION_ID, CHILD_SESSION_ID, "done-child");
        registry.recordExecution(ROOT_SESSION_ID, CHILD_SESSION_ID, "done-child", true);

        assertTrue(registry.isRegistered("done-child"),
                "数据库确认终态后槽位仍可能残留，直到 forgetFinishedExecution 才清理");
        assertFalse(registry.isActive("done-child"));
        assertFalse(registry.isHolderAlive("done-child"),
                "已结束绝不能再算持有者，否则这封邮件永远投不出去");

        registry.forgetFinishedExecution("done-child");
        assertFalse(registry.isRegistered("done-child"), "清理后登记一并消失");
        assertFalse(registry.isHolderAlive("done-child"), "清理后同样不算持有者");
    }

    @Test
    @DisplayName("已取消 → alive=false（即使槽位仍登记）")
    void cancelledExecutionIsNotAlive() {
        SessionExecutionRegistry registry = new SessionExecutionRegistry();
        registry.beginRoot(ROOT_SESSION_ID, "cancelled-root");
        assertEquals(List.of("cancelled-root"), registry.cancelRoot(ROOT_SESSION_ID));

        assertTrue(registry.isRegistered("cancelled-root"), "取消不摘登记");
        assertTrue(registry.isExecutionCancelled("cancelled-root"));
        assertFalse(registry.isHolderAlive("cancelled-root"),
                "已取消不会再来确认交付，不能算持有者");
    }

    @Test
    @DisplayName("未登记：冷启动口径 alive=false 且 isRegistered=false")
    void unregisteredExecutionIsNeitherAliveNorRegistered() {
        SessionExecutionRegistry registry = new SessionExecutionRegistry();

        assertFalse(registry.isHolderAlive("never-seen"),
                "冷启动后登记表为空：无从证明它还活着，必须返回 false（交给墙钟兜底）");
        assertFalse(registry.isRegistered("never-seen"));
        assertFalse(registry.isHolderAlive(null), "空 id 绝不能算活着");
        assertFalse(registry.isRegistered(null));
    }

    @Test
    @DisplayName("别的执行在登记时，未登记的 id 依然 alive=false（不因登记表非空而误判）")
    void registrationOfOthersDoesNotMakeUnknownHolderAlive() {
        SessionExecutionRegistry registry = new SessionExecutionRegistry();
        registry.acquire("live-other");
        assertTrue(registry.isHolderAlive("live-other"));

        assertFalse(registry.isHolderAlive("never-seen"),
                "登记表非空不等于谁都被登记：未登记的 id 必须判为已消失");
        assertFalse(registry.isRegistered("never-seen"));
    }
}
