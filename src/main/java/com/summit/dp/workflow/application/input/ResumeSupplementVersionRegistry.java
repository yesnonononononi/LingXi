package com.summit.dp.workflow.application.input;

import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 进程内的「补充要求脏版本」事实：{@code executionId → 已知最新补充消息 id}。
 *
 * <p><b>为什么这份事实必须放在检查点之外</b>：检查点里的游标只有「已消费到哪」，回答不了
 * 「之后有没有新的」。要判断「需不需要查库」，必须有一个比检查点更新的信号，
 * 而它恰好天然廉价 —— 补充要求是由本进程的 {@code ResumeSupplementService} 提交的。</p>
 *
 * <p><b>为什么值存「消息 id」而不是计数器</b>：拦截器的判据是检查点游标
 * {@code LAST_RESUME_SUPPLEMENT_ID}（也是消息 id）。只有同一种量纲才能直接比较，
 * 否则还要再维护一层「计数器 ↔ 游标」的对应关系，多一处可能不一致的地方。</p>
 *
 * <p><b>为什么是有界 LRU 而不是无界静态表</b>：无界 map 会随执行数无限增长。
 * 这里按访问序保留最近 {@value #MAX_ENTRIES} 个执行，被挤掉的执行下次问到时得到
 * {@code null}，一律按「证明不了」处理 —— 回退成查库一次，正确性不受影响，
 * 只是多一次查询。执行终结时由生命周期投影显式 {@link #forget(long)}，让条目随执行结束消失。</p>
 *
 * <p><b>可恢复性</b>：本类不做任何持久化。进程重启后表是空的，所有执行都「证明不了」，
 * 于是每个执行第一次拦截都查库一次，查完把结果记回来 —— 这正是冷启动应有的行为。
 * 条目不显式清理：容量由 LRU 封顶，单条值只是一个 {@code long}，
 * 被挤掉的后果只是「下次多查一次库」，不影响正确性。</p>
 */
@Component
public class ResumeSupplementVersionRegistry {

    /** 有界容量：活跃执行数通常在个位到几十，2048 足够，被挤掉只多一次查库。 */
    static final int MAX_ENTRIES = 2048;

    private final Map<Long, Long> latestKnown = new LinkedHashMap<>(64, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<Long, Long> eldest) {
            return size() > MAX_ENTRIES;
        }
    };

    /**
     * 记录某执行已知的最新补充消息 id（取较大值）。
     *
     * <p>由补充提交方在事务提交后调用：提交成功即意味着「该执行至少有这一条」。</p>
     */
    public synchronized void noteAppended(long executionId, long supplementMessageId) {
        Long known = latestKnown.get(executionId);
        if (known == null || supplementMessageId > known) {
            latestKnown.put(executionId, supplementMessageId);
        }
    }

    /** 记录一次查库得到的结论：该执行此刻最新补充 id（没有补充时传游标值或 0）。 */
    public synchronized void remember(long executionId, long latestSupplementMessageId) {
        Long known = latestKnown.get(executionId);
        if (known == null || latestSupplementMessageId > known) {
            latestKnown.put(executionId, latestSupplementMessageId);
        }
    }

    /**
     * 已知最新补充消息 id；{@code null} 表示本进程证明不了（冷启动、被 LRU 挤掉、重启）。
     *
     * <p>调用方必须把 {@code null} 当成「可能有新输入」，即回退查库一次。</p>
     */
    public synchronized Long latestKnown(long executionId) {
        return latestKnown.get(executionId);
    }
}
