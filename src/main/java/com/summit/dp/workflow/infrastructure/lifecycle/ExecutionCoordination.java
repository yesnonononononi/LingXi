package com.summit.dp.workflow.infrastructure.lifecycle;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.IntStream;

/** 固定数量的门闩避免按执行创建的锁永久积累；锁内禁止运行模型或命令。 */
public final class ExecutionCoordination {

    /**
     * 门闩条数：固定 256 条锁，按 executionId 哈希取模命中。
     *
     * <p>依据：并发执行的量级是「同时在跑的工具 / 子代理数」，通常个位数到几十；
     * 256 条足以让并发执行几乎不撞锁（撞锁只是多等一轮，不会死锁），
     * 同时把锁数组常驻内存钉在几 KB。</p>
     */
    private static final int LOCK_STRIPES = 256;

    private static final Object[] LOCKS = IntStream.range(0, LOCK_STRIPES).mapToObj(index -> new Object()).toArray();
    private static final Set<Long> RESUMING_SESSIONS = ConcurrentHashMap.newKeySet();

    private ExecutionCoordination() { }

    public static Object monitor(String executionId) {
        return LOCKS[Math.floorMod(executionId.hashCode(), LOCKS.length)];
    }

    /** 恢复没有普通受理槽位，终态先于上下文回写时仍需让新需求入队。 */
    public static void resumeSession(long sessionId, Runnable resumeAndWriteContext) {
        synchronized (monitor("session:" + sessionId)) {
            boolean first = RESUMING_SESSIONS.add(sessionId);
            try {
                resumeAndWriteContext.run();
            } finally {
                if (first) RESUMING_SESSIONS.remove(sessionId);
            }
        }
    }

    public static boolean isResumingSession(long sessionId) {
        return RESUMING_SESSIONS.contains(sessionId);
    }
}
