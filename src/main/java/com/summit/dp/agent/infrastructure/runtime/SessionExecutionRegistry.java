package com.summit.dp.agent.infrastructure.runtime;

import com.summit.dp.shared.exception.ClientException;
import org.springframework.stereotype.Component;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Tracks the live parent/child execution relationship independently of conversation persistence.
 *
 * <p>A child conversation may not have been saved when the user presses stop. Keeping the live
 * relationship here lets cancellation reach those children and prevents a child racing with a
 * root cancellation from starting afterwards.</p>
 */
@Component
public class SessionExecutionRegistry {

    private final Map<Long, RootExecution> roots = new ConcurrentHashMap<>();

    /**
     * 注册一次根会话运行，并在同一把锁内强制「单飞」。
     *
     * <p><b>HC-2 结构性兜底</b>：{@code rootSessionId} 必须是 prepare 之后的会话 id；
     * null 意味着调用方在身份解析前就注册了运行——停止链路会对着空气取消。
     * 立即抛出而不是静默跳过，让调用方的顺序错误在第一时间暴露。</p>
     *
     * <p><b>单飞约束</b>：同一根会话同时只允许一个进行中的执行。若已有执行在跑，
     * 再次 {@code beginRoot} 必须抛出，且<b>不覆盖</b> {@code cancelled} 标志、不改动
     * 任何状态——正在取消中的会话不应被新请求悄悄复活。校验与置位在同一临界区内，
     * 天然防并发双开。</p>
     */
    public void beginRoot(Long rootSessionId) {
        Objects.requireNonNull(rootSessionId, "rootSessionId must be resolved before beginRoot (HC-2)");
        RootExecution execution = roots.computeIfAbsent(rootSessionId, ignored -> new RootExecution());
        synchronized (execution) {
            if (execution.rootRunning) {
                throw new ClientException("该会话正在执行中");
            }
            execution.rootRunning = true;
            execution.cancelled = false;
        }
    }

    public void finishRoot(Long rootSessionId) {
        if (rootSessionId == null) return;
        RootExecution execution = roots.get(rootSessionId);
        if (execution == null) return;
        synchronized (execution) {
            execution.rootRunning = false;
            removeIfFinished(rootSessionId, execution);
        }
    }

    /** Returns false when the root has already been cancelled. */
    public boolean registerChild(Long rootSessionId, Long childSessionId, Thread thread) {
        if (rootSessionId == null || childSessionId == null) return true;
        RootExecution execution = roots.computeIfAbsent(rootSessionId, ignored -> new RootExecution());
        synchronized (execution) {
            if (execution.cancelled) return false;
            execution.children.put(childSessionId, thread);
            return true;
        }
    }

    public void unregisterChild(Long rootSessionId, Long childSessionId) {
        if (rootSessionId == null || childSessionId == null) return;
        RootExecution execution = roots.get(rootSessionId);
        if (execution == null) return;
        synchronized (execution) {
            execution.children.remove(childSessionId);
            removeIfFinished(rootSessionId, execution);
        }
    }

    /**
     * Atomically marks the root cancelled and returns all children known at that instant.
     *
     * <p>同时清掉 {@code rootRunning}：停止是会话级收尾动作，若不清位，被 stop 的会话将
     * 永远停在「运行中」而无法再次发起（单飞校验会一直拒绝）。清位后仍保留
     * {@code cancelled=true}，直到某次 {@code beginRoot} 重新开始才复位——保证
     * 停止与下一轮开始之间到达的子任务仍被拦截。</p>
     */
    public List<ChildExecution> cancelRoot(Long rootSessionId) {
        if (rootSessionId == null) return List.of();
        RootExecution execution = roots.computeIfAbsent(rootSessionId, ignored -> new RootExecution());
        synchronized (execution) {
            execution.cancelled = true;
            execution.rootRunning = false;
            return execution.children.entrySet().stream()
                    .map(entry -> new ChildExecution(entry.getKey(), entry.getValue()))
                    .toList();
        }
    }

    public boolean isCancelled(Long rootSessionId) {
        RootExecution execution = rootSessionId == null ? null : roots.get(rootSessionId);
        if (execution == null) return false;
        synchronized (execution) {
            return execution.cancelled;
        }
    }

    private void removeIfFinished(Long rootSessionId, RootExecution execution) {
        if (!execution.rootRunning && execution.children.isEmpty()) {
            roots.remove(rootSessionId, execution);
        }
    }

    public record ChildExecution(Long sessionId, Thread thread) {
    }

    private static final class RootExecution {
        private boolean rootRunning;
        private boolean cancelled;
        private final Map<Long, Thread> children = new HashMap<>();
    }
}
