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
 *
 * <p>子执行按阶段登记（{@link ChildPhase}）：提交前登记、开跑前绑定运行线程、挂起时期保留、
 * <b>只有真正终态才移除</b>。「未结束」的判定因此含待启动 / 运行 / 挂起三态，避免根在子执行
 * 尚未产出时把它误判成「没有子执行」而提前收尾。</p>
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

    /**
     * 提交子执行前登记「待启动」阶段；根已取消返回 {@code false}。
     *
     * <p>登记早于线程池提交：这样「已受理但线程池拒绝 / 尚未开跑」这段窗口也计入「未结束」，
     * 根不会在这段窗口里判定无子执行而提前收尾。</p>
     */
    public boolean registerPendingChild(Long rootSessionId, Long childSessionId) {
        if (rootSessionId == null || childSessionId == null) return true;
        RootExecution execution = roots.computeIfAbsent(rootSessionId, ignored -> new RootExecution());
        synchronized (execution) {
            if (execution.cancelled) return false;
            execution.children.put(childSessionId, new ChildTrack(ChildPhase.PENDING_START, null));
            return true;
        }
    }

    /** 异步线程开跑前绑定运行线程；根已取消返回 {@code false}（调用方据此撤销登记、不开跑）。 */
    public boolean bindRunningChild(Long rootSessionId, Long childSessionId, Thread thread) {
        if (rootSessionId == null || childSessionId == null) return true;
        RootExecution execution = roots.computeIfAbsent(rootSessionId, ignored -> new RootExecution());
        synchronized (execution) {
            if (execution.cancelled) return false;
            execution.children.put(childSessionId, new ChildTrack(ChildPhase.RUNNING, thread));
            return true;
        }
    }

    /** 子执行挂起（等人工审批）：保留登记、释放死线程引用，父侧仍记为「未结束」。 */
    public void markChildSuspended(Long rootSessionId, Long childSessionId) {
        if (rootSessionId == null || childSessionId == null) return;
        RootExecution execution = roots.get(rootSessionId);
        if (execution == null) return;
        synchronized (execution) {
            ChildTrack track = execution.children.get(childSessionId);
            if (track == null) return;
            track.phase = ChildPhase.SUSPENDED;
            track.thread = null;
        }
    }

    /** 撤销尚未开跑的登记（提交失败 / 根已取消）：无唤醒语义，只是把条目清掉。 */
    public void revokeChild(Long rootSessionId, Long childSessionId) {
        if (rootSessionId == null || childSessionId == null) return;
        RootExecution execution = roots.get(rootSessionId);
        if (execution == null) return;
        synchronized (execution) {
            execution.children.remove(childSessionId);
            removeIfFinished(rootSessionId, execution);
        }
    }

    /**
     * 子执行真正终态时移除登记。
     *
     * @return 「此移除后是否已无未结束子」；这是唤醒门控——只有最后一个子执行终结这一原子跃迁
     *         才唤醒根，避免每有一个子结束就唤醒一次造成无谓的模型轮次。
     */
    public boolean unregisterChild(Long rootSessionId, Long childSessionId) {
        if (rootSessionId == null || childSessionId == null) return false;
        RootExecution execution = roots.get(rootSessionId);
        if (execution == null) return false;
        synchronized (execution) {
            execution.children.remove(childSessionId);
            boolean becameEmpty = execution.children.isEmpty();
            removeIfFinished(rootSessionId, execution);
            return becameEmpty;
        }
    }

    /**
     * 根会话下是否仍有未结束的子执行（待启动 / 运行 / 挂起）。
     *
     * <p>供「根代理收尾前驻留」判定使用：根代理本轮没有工具调用、准备收尾时，若仍有子执行未结束，
     * 它必须保留当前轮次停在非终态等待回信 —— 一旦迁入终态，框架就不再允许 {@code resume}，
     * 子代理随后发出的交付邮件将投进一个再也不会被消费的邮箱。</p>
     *
     * <p>只读、不改动任何状态。注册表条目在 {@code removeIfFinished} 里随「根已收尾且子已清空」
     * 被回收，因此查不到条目即等价于「没有未结束子执行」。</p>
     */
    public boolean hasUnfinishedChildren(Long rootSessionId) {
        if (rootSessionId == null) return false;
        RootExecution execution = roots.get(rootSessionId);
        if (execution == null) return false;
        synchronized (execution) {
            return !execution.children.isEmpty();
        }
    }

    /**
     * Atomically marks the root cancelled and returns all children known at that instant.
     *
     * <p>同时清掉 {@code rootRunning}：停止是会话级收尾动作，若不清位，被 stop 的会话将
     * 永远停在「运行中」而无法再次发起（单飞校验会一直拒绝）。清位后仍保留
     * {@code cancelled=true}，直到某次 {@code beginRoot} 重新开始才复位——保证
     * 停止与下一轮开始之间到达的子任务仍被拦截。</p>
     *
     * <p>快照带 {@code phase}：只有 {@code RUNNING} 才有活线程可打断，待启动 / 挂起无活线程，
     * 靠取消标志与执行状态拦截。</p>
     */
    public List<ChildExecution> cancelRoot(Long rootSessionId) {
        if (rootSessionId == null) return List.of();
        RootExecution execution = roots.computeIfAbsent(rootSessionId, ignored -> new RootExecution());
        synchronized (execution) {
            execution.cancelled = true;
            execution.rootRunning = false;
            return execution.children.entrySet().stream()
                    .map(entry -> new ChildExecution(entry.getKey(), entry.getValue().thread, entry.getValue().phase))
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

    /** 子执行快照：会话 id、运行线程（无活线程时为 null）、存活阶段。 */
    public record ChildExecution(Long sessionId, Thread thread, ChildPhase phase) {
    }

    private static final class RootExecution {
        private boolean rootRunning;
        private boolean cancelled;
        private final Map<Long, ChildTrack> children = new HashMap<>();
    }

    /** 私有可变持有体：跟踪单个子执行的阶段与运行线程。 */
    private static final class ChildTrack {
        private ChildPhase phase;
        private Thread thread;

        private ChildTrack(ChildPhase phase, Thread thread) {
            this.phase = phase;
            this.thread = thread;
        }
    }
}
