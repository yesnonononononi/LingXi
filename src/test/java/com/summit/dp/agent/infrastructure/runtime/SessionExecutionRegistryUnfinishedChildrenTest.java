package com.summit.dp.agent.infrastructure.runtime;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 独立验证：{@link SessionExecutionRegistry#hasUnfinishedChildren} 与
 * {@code registerPendingChild / bindRunningChild / markChildSuspended / revokeChild /
 * unregisterChild / beginRoot / finishRoot} 的回收语义是否自洽。
 *
 * <p>「未结束」含待启动 / 运行 / 挂起三态。重点盯「条目误删」这一风险：只有当「根已收尾
 * <b>且</b> 子已清空」时才允许回收条目，否则「根已 suspend、子仍在跑」时条目被误删会让驻留判定
 * 漏判，根提前 COMPLETED。</p>
 */
class SessionExecutionRegistryUnfinishedChildrenTest {

    private final SessionExecutionRegistry registry = new SessionExecutionRegistry();

    @Test
    @DisplayName("null 入参：视为无子执行，返回 false 且不抛异常")
    void nullRootHasNoUnfinishedChildren() {
        assertFalse(registry.hasUnfinishedChildren(null));
    }

    @Test
    @DisplayName("注册表无该根会话条目：返回 false（查不到条目等价于没有子执行）")
    void unknownRootHasNoUnfinishedChildren() {
        assertFalse(registry.hasUnfinishedChildren(999L));
    }

    @Test
    @DisplayName("待启动子执行：hasUnfinishedChildren 为 true（提交前登记即计入未结束）")
    void reportsTrueWhenChildPendingStart() {
        assertTrue(registry.registerPendingChild(800L, 555L));

        assertTrue(registry.hasUnfinishedChildren(800L));
    }

    @Test
    @DisplayName("运行中子执行：hasUnfinishedChildren 为 true")
    void reportsTrueWhenChildRunning() {
        assertTrue(registry.bindRunningChild(800L, 555L, Thread.currentThread()));

        assertTrue(registry.hasUnfinishedChildren(800L));
    }

    @Test
    @DisplayName("挂起子执行（等审批）：保留登记，hasUnfinishedChildren 仍为 true")
    void suspendedChildKeepsUnfinishedFlag() {
        registry.bindRunningChild(800L, 555L, Thread.currentThread());

        registry.markChildSuspended(800L, 555L);

        assertTrue(registry.hasUnfinishedChildren(800L),
                "子执行等人工审批期间仍算「未结束」，根不得据此提前收尾");
    }

    @Test
    @DisplayName("子执行注销后：hasUnfinishedChildren 变 false，且条目被回收")
    void reportsFalseAfterChildUnregistered() {
        registry.bindRunningChild(800L, 555L, Thread.currentThread());

        registry.unregisterChild(800L, 555L);

        assertFalse(registry.hasUnfinishedChildren(800L));
    }

    @Test
    @DisplayName("双子在跑：注销其一仍为 true，全部注销才 false；becameEmpty 只在最后一个检出")
    void twoChildrenKeepUnfinishedUntilBothGone() {
        registry.bindRunningChild(800L, 555L, Thread.currentThread());
        registry.bindRunningChild(800L, 556L, Thread.currentThread());

        assertTrue(registry.hasUnfinishedChildren(800L));

        assertFalse(registry.unregisterChild(800L, 555L), "还有 556 在跑，不是最后一个");
        assertTrue(registry.hasUnfinishedChildren(800L), "还有 556 在跑，不能判成无子执行");

        assertTrue(registry.unregisterChild(800L, 556L), "最后一个子执行终结才成为空");
        assertFalse(registry.hasUnfinishedChildren(800L));
    }

    @Test
    @DisplayName("撤销待启动登记：条目移除，未结束判定随之收敛")
    void revokeChildRemovesPendingEntry() {
        registry.registerPendingChild(800L, 555L);
        assertTrue(registry.hasUnfinishedChildren(800L));

        registry.revokeChild(800L, 555L);

        assertFalse(registry.hasUnfinishedChildren(800L));
    }

    @Test
    @DisplayName("【关键·误删风险】根已收尾但子仍在跑：条目绝不能被回收，hasUnfinishedChildren 必须仍为 true")
    void rootFinishedWhileChildRunningIsNotReclaimed() {
        registry.beginRoot(800L);
        registry.bindRunningChild(800L, 555L, Thread.currentThread());

        // 根代理本轮无工具调用、准备收尾：finishRoot 释放根运行资格。
        registry.finishRoot(800L);

        assertTrue(registry.hasUnfinishedChildren(800L),
                "根已 finishRoot 但子仍注册时，removeIfFinished 不得回收条目，否则驻留判定会漏判");

        // 子执行真正收尾后才应回收。
        registry.unregisterChild(800L, 555L);
        assertFalse(registry.hasUnfinishedChildren(800L));
    }

    @Test
    @DisplayName("根未 beginRoot（异步子执行自主注册）：仍能被 hasUnfinishedChildren 观测，注销后回收")
    void childRegisteredWithoutBeginRootStillVisible() {
        // 异步子执行在虚拟线程内注册，注册表的条目由 registerPendingChild 自行创建。
        assertTrue(registry.registerPendingChild(800L, 555L));
        assertTrue(registry.hasUnfinishedChildren(800L));

        registry.unregisterChild(800L, 555L);
        assertFalse(registry.hasUnfinishedChildren(800L));
    }

    @Test
    @DisplayName("根停止（cancelRoot）后：子仍注册时 hasUnfinishedChildren 仍为 true，子注销后回收")
    void cancelledRootStillReportsRunningChildren() {
        registry.beginRoot(800L);
        registry.bindRunningChild(800L, 555L, Thread.currentThread());

        registry.cancelRoot(800L);

        assertTrue(registry.hasUnfinishedChildren(800L),
                "停止只是标记取消，在跑的子执行仍未结束，不能判成无子执行");
        registry.unregisterChild(800L, 555L);
        assertFalse(registry.hasUnfinishedChildren(800L));
    }
}
