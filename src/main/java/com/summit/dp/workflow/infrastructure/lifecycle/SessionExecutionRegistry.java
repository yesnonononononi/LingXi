package com.summit.dp.workflow.infrastructure.lifecycle;

import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.dp.shared.exception.ClientException;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;

/** 根会话统一持有执行槽；挂起释放运行占用，真正结束才移除登记。 */
@Component
public class SessionExecutionRegistry {
    private final Map<Long, RootExecution> roots = new ConcurrentHashMap<>();
    private final Map<String, ExecutionControlSlot> slots = new ConcurrentHashMap<>();

    public void beginRoot(Long rootSessionId, String executionId) {
        Objects.requireNonNull(rootSessionId, "登记运行前必须解析根会话标识");
        Objects.requireNonNull(executionId, "登记运行前必须解析执行标识");
        synchronized (ExecutionCoordination.monitor("control:" + rootSessionId)) {
            RootExecution root = roots.computeIfAbsent(rootSessionId, ignored -> new RootExecution());
            throwIf(root.admittedExecutionId != null || hasOpenRoot(rootSessionId, root), "该会话正在执行中");
            root.cancelled = false;
            root.admittedExecutionId = executionId;
            attach(rootSessionId, rootSessionId, executionId, root);
        }
    }

    public boolean isRootRunning(Long rootSessionId) {
        RootExecution root = roots.get(rootSessionId);
        if (root == null) return false;
        synchronized (ExecutionCoordination.monitor("control:" + rootSessionId)) {
            return root.admittedExecutionId != null || root.controls.values().stream()
                    .anyMatch(slot -> rootSessionId.equals(slot.sessionId()) && slot.isRunning());
        }
    }

    /** 自动接续不能清除停止意图，只有用户发起的新一轮可以重新开放受理。 */
    public boolean tryBeginAutomaticRoot(Long rootSessionId, String executionId) {
        Objects.requireNonNull(executionId, "登记运行前必须解析执行标识");
        synchronized (ExecutionCoordination.monitor("control:" + rootSessionId)) {
            RootExecution root = roots.computeIfAbsent(rootSessionId, ignored -> new RootExecution());
            if (root.admittedExecutionId != null || root.cancelled || hasOpenRoot(rootSessionId, root)) return false;
            root.admittedExecutionId = executionId;
            attach(rootSessionId, rootSessionId, executionId, root);
            return true;
        }
    }

    /** 按执行身份释放受理资格，迟到的旧收尾不能释放新一轮。 */
    public void finishRoot(Long rootSessionId, String executionId) {
        if (rootSessionId == null) return;
        synchronized (ExecutionCoordination.monitor("control:" + rootSessionId)) {
            RootExecution root = roots.get(rootSessionId);
            if (root == null || !Objects.equals(root.admittedExecutionId, executionId)) return;
            root.admittedExecutionId = null;
            ExecutionControlSlot slot = root.controls.get(executionId);
            if (slot != null && (!slot.isCommitted() || slot.isFinished()) && !slot.isRunning()) {
                removeSlot(root, slot);
            }
            removeIfFinished(rootSessionId, root);
        }
    }

    /** 请求已有权威执行 ID，提交前即可把排队窗口纳入取消范围。 */
    public boolean registerPendingChild(Long rootSessionId, Long childSessionId, String executionId,
                                        String parentExecutionId) {
        Objects.requireNonNull(rootSessionId, "子执行必须提供根会话标识");
        Objects.requireNonNull(childSessionId, "子执行必须提供会话标识");
        Objects.requireNonNull(executionId, "子执行必须提供执行标识");
        synchronized (ExecutionCoordination.monitor("control:" + rootSessionId)) {
            RootExecution root = roots.computeIfAbsent(rootSessionId, ignored -> new RootExecution());
            ExecutionControlSlot parent = parentExecutionId == null ? null : slots.get(parentExecutionId);
            if (root.cancelled || parentExecutionId != null
                    && (parent == null || parent.isCancelled() || parent.isFinished())) return false;
            ExecutionControlSlot existing = slots.get(executionId);
            if (existing != null && existing.isCancelled()) return false;
            throwIf(root.controls.values().stream().anyMatch(slot -> childSessionId.equals(slot.sessionId())
                    && !executionId.equals(slot.executionId()) && !slot.isFinished()), "该子会话正在执行中");
            attach(rootSessionId, childSessionId, executionId, root);
            return true;
        }
    }

    /** 只认提交前的槽位，排队任务不能在停止或撤销后自行重新登记。 */
    public boolean tryStartChild(String executionId) {
        ExecutionControlSlot slot = slots.get(executionId);
        return slot != null && !slot.isCancelled() && !slot.isFinished();
    }

    public void revokeChild(Long rootSessionId, Long childSessionId, String executionId) {
        unregisterChild(rootSessionId, childSessionId, executionId);
    }

    /** 同一子会话可被再次委派，移除必须限定到这次执行。 */
    public boolean unregisterChild(Long rootSessionId, Long childSessionId, String executionId) {
        if (rootSessionId == null || childSessionId == null) return false;
        synchronized (ExecutionCoordination.monitor("control:" + rootSessionId)) {
            RootExecution root = roots.get(rootSessionId);
            if (root == null) return false;
            ExecutionControlSlot slot = root.controls.get(executionId);
            if (slot != null && childSessionId.equals(slot.sessionId()) && !slot.isRunning()) removeSlot(root, slot);
            boolean empty = !hasChildren(rootSessionId, root);
            removeIfFinished(rootSessionId, root);
            return empty;
        }
    }

    public boolean hasUnfinishedChildren(Long rootSessionId) {
        if (rootSessionId == null) return false;
        synchronized (ExecutionCoordination.monitor("control:" + rootSessionId)) {
            RootExecution root = roots.get(rootSessionId);
            return root != null && hasChildren(rootSessionId, root);
        }
    }

    /** 先关闭登记，再在同一临界区标记所有槽位；数据库收尾在锁外完成。 */
    public List<String> cancelRoot(Long rootSessionId) {
        if (rootSessionId == null) return List.of();
        synchronized (ExecutionCoordination.monitor("control:" + rootSessionId)) {
            RootExecution root = roots.computeIfAbsent(rootSessionId, ignored -> new RootExecution());
            root.cancelled = true;
            root.controls.values().forEach(ExecutionControlSlot::requireCancel);
            return List.copyOf(root.controls.keySet());
        }
    }

    public boolean isCancelled(Long rootSessionId) {
        if (rootSessionId == null) return false;
        synchronized (ExecutionCoordination.monitor("control:" + rootSessionId)) {
            RootExecution root = roots.get(rootSessionId);
            return root != null && root.cancelled;
        }
    }

    public boolean isExecutionCancelled(String executionId) {
        ExecutionControlSlot slot = executionId == null ? null : slots.get(executionId);
        return slot != null && slot.isCancelled();
    }

    /** 冷启动恢复和已提交检查点共用登记口，不从运行线程推测执行关系。 */
    public void restoreExecution(Long rootSessionId, Long sessionId, String executionId) {
        synchronized (ExecutionCoordination.monitor("control:" + rootSessionId)) {
            RootExecution root = roots.computeIfAbsent(rootSessionId, ignored -> new RootExecution());
            attach(rootSessionId, sessionId, executionId, root).record(false);
        }
    }

    public void recordExecution(Long rootSessionId, Long sessionId, String executionId, boolean finished) {
        if (rootSessionId == null || sessionId == null) return;
        synchronized (ExecutionCoordination.monitor("control:" + rootSessionId)) {
            RootExecution root = roots.computeIfAbsent(rootSessionId, ignored -> new RootExecution());
            ExecutionControlSlot slot = attach(rootSessionId, sessionId, executionId, root);
            slot.record(finished);
            removeFinishedRootSlot(rootSessionId, root, slot);
            removeIfFinished(rootSessionId, root);
        }
    }

    public ExecutionControlSignal acquire(String executionId) {
        return slots.computeIfAbsent(executionId, ExecutionControlSlot::new).acquire();
    }

    public boolean release(ExecutionControlSignal signal) {
        ExecutionControlSlot slot = slots.get(signal.getExecutionId());
        if (slot == null || !slot.release(signal)) return false;
        Long rootSessionId = slot.rootSessionId();
        if (rootSessionId == null) {
            if (slot.isFinished()) slots.remove(signal.getExecutionId(), slot);
        } else {
            // 释放占用不证明检查点已提交，首次保存失败仍须允许受理入口撤销槽位。
            synchronized (ExecutionCoordination.monitor("control:" + rootSessionId)) {
                RootExecution root = roots.get(rootSessionId);
                if (root != null) {
                    removeFinishedRootSlot(rootSessionId, root, slot);
                    removeIfFinished(rootSessionId, root);
                }
            }
        }
        return true;
    }

    public boolean isActive(String executionId) {
        ExecutionControlSlot slot = slots.get(executionId);
        return slot != null && slot.isRunning();
    }

    /**
     * 该执行在当前进程里是否仍有登记。
     *
     * <p>冷启动之后登记表是空的，一律返回 {@code false} —— 调用方只能把它当「无从判断」。</p>
     */
    public boolean isRegistered(String executionId) {
        return executionId != null && slots.containsKey(executionId);
    }

    /**
     * 投递归属的存活口径：<b>未结束即算持有者</b>。
     *
     * <p>运行中与挂起都算活（挂起期间没有检查点提交，恢复后会继续确认交付）；
     * 已结束、已取消、未登记都算已消失。与 {@link #isActive} 的区别就在「挂起」这一档。</p>
     */
    public boolean isHolderAlive(String executionId) {
        ExecutionControlSlot slot = executionId == null ? null : slots.get(executionId);
        return slot != null && !slot.isFinished() && !slot.isCancelled();
    }

    public boolean requireSuspend(String executionId) {
        ExecutionControlSlot slot = slots.get(executionId);
        return slot != null && slot.requireSuspend();
    }

    public boolean isSuspendRequired(String executionId) {
        ExecutionControlSlot slot = slots.get(executionId);
        return slot != null && slot.isSuspendRequired();
    }

    public boolean requireCancel(String executionId) {
        ExecutionControlSlot slot = slots.get(executionId);
        if (slot == null) return false;
        slot.requireCancel();
        return slot.isRunning();
    }

    /** 数据库已确认终态，批量补齐读到的旧摘要不能继续占着槽位。 */
    public void forgetFinishedExecution(String executionId) {
        ExecutionControlSlot slot = slots.get(executionId);
        if (slot == null || slot.isRunning()) return;
        Long rootSessionId = slot.rootSessionId();
        if (rootSessionId == null) {
            slots.remove(executionId, slot);
            return;
        }
        synchronized (ExecutionCoordination.monitor("control:" + rootSessionId)) {
            RootExecution root = roots.get(rootSessionId);
            if (root == null || slot.isRunning()) return;
            removeSlot(root, slot);
            removeIfFinished(rootSessionId, root);
        }
    }

    private ExecutionControlSlot attach(Long rootSessionId, Long sessionId, String executionId, RootExecution root) {
        Objects.requireNonNull(executionId, "登记运行前必须解析执行标识");
        ExecutionControlSlot slot = slots.computeIfAbsent(executionId, ExecutionControlSlot::new);
        slot.attach(rootSessionId, sessionId);
        if (root.cancelled) slot.requireCancel();
        root.controls.put(executionId, slot);
        return slot;
    }

    private boolean hasOpenRoot(Long rootSessionId, RootExecution root) {
        return root.controls.values().stream()
                .anyMatch(slot -> rootSessionId.equals(slot.sessionId()) && !slot.isFinished());
    }

    private boolean hasChildren(Long rootSessionId, RootExecution root) {
        return root.controls.values().stream().anyMatch(slot -> !rootSessionId.equals(slot.sessionId()));
    }

    private void removeSlot(RootExecution root, ExecutionControlSlot slot) {
        root.controls.remove(slot.executionId(), slot);
        slots.remove(slot.executionId(), slot);
    }

    private void removeFinishedRootSlot(Long rootSessionId, RootExecution root, ExecutionControlSlot slot) {
        if (slot.isFinished() && rootSessionId.equals(slot.sessionId()) && !slot.isRunning()
                && !slot.executionId().equals(root.admittedExecutionId)) removeSlot(root, slot);
    }

    private void removeIfFinished(Long rootSessionId, RootExecution root) {
        if (root.admittedExecutionId == null && !root.cancelled && root.controls.isEmpty()) {
            roots.remove(rootSessionId, root);
        }
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }

    private static final class RootExecution {
        private String admittedExecutionId;
        private boolean cancelled;
        private final Map<String, ExecutionControlSlot> controls = new LinkedHashMap<>();
    }
}
