package com.summit.dp.workflow.infrastructure.harness;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.event.ExecutionCancelledEvent;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.event.TokenInfo;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.application.service.ExecutionCheckpointService;
import com.summit.dp.execution.application.service.ExecutionCheckpointService.StoredCheckpoint;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.application.port.ExecutionActivity;
import com.summit.dp.workflow.infrastructure.lifecycle.ExecutionCoordination;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.workflow.infrastructure.lifecycle.SubExecutionLifecycle;
import com.summit.dp.workflow.application.projection.SessionContextUsageProjector;
import com.summit.dp.workflow.application.approval.ToolCallReadinessService;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.workflow.application.projection.ChatTurnLifecycleProjector;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.Instant;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/** 本机控制信号与已提交检查点分开保存，恢复时不暴露未提交的消息。 */
@Repository
@RequiredArgsConstructor
@Slf4j
public class LocalExecutionRepository implements ExecutionRepository, ExecutionActivity {

    private final ExecutionCheckpointService checkpointService;
    private final ObjectMapper objectMapper;
    /** 延迟取服务，避免生命周期处理与执行仓储形成构造期闭环。 */
    private final ObjectProvider<ToolCallReadinessService> readinessService;
    private final ObjectProvider<ToolCallService> toolCallService;
    /** 子执行「结束事实」协作器；经 ObjectProvider 断开与执行仓储的构造期闭环。 */
    private final ObjectProvider<SubExecutionLifecycle> subExecutionLifecycle;
    private final ObjectProvider<SessionContextUsageProjector> sessionService;
    private final ObjectProvider<ChatTurnLifecycleProjector> chatTurnService;
    private final ObjectProvider<RuntimeEventPublisher> runtimeEvents;
    private final ExecutionSnapshotReader snapshotReader;

    /** 进程内活跃执行的控制信号；与框架 InMemoryActiveExecutionRegistry 语义一致。 */
    private final Map<String, ExecutionControlSignal> active = new ConcurrentHashMap<>();
    /** 已提交检查点的不可变缓存；恢复时解码，避免读到未提交的消息追加。 */
    private final Map<String, String> checkpoints = new ConcurrentHashMap<>();

    @Override
    @Transactional
    public void save(Execution execution) {
        if (execution == null || execution.getId() == null || execution.getId().isBlank()) {
            throw new IllegalArgumentException("执行 ID 不能为空");
        }
        synchronized (ExecutionCoordination.monitor(execution.getId())) {
            long id = numericId(execution.getId());
            ExecutionState state = execution.getExecutionState();

            boolean terminal = ExecutionStateCodec.isTerminalState(state);
            String snapshot;
            try {
                snapshot = objectMapper.writeValueAsString(execution);
            } catch (JsonProcessingException e) {
                throw new IllegalStateException("保存执行检查点失败: executionId=" + execution.getId(), e);
            }

            Map<String, Object> attributes = execution.getAgentRequest() == null ? Map.of()
                    : execution.getAgentRequest().runtimeParametersOrDefault().getAttributes();
            Long sessionId = ExecutionAttributes.readLong(attributes, ExecutionAttributes.SESSION_ID);
            boolean firstFailure;
            try {
                firstFailure = checkpointService.save(id, sessionId, resolveStatus(state), snapshot,
                        execution.getCreateAt(), execution.getStartAt(), execution.getCompletedAt());
            } catch (ClientException failure) {
                throw new IllegalStateException("保存执行检查点失败: executionId=" + id, failure);
            }
            boolean withoutControlSlot = !active.containsKey(execution.getId());
            cacheAfterCommit(execution.getId(), snapshot, terminal);
            // 补一次终结广播，使轮次收口落在框架发布终态事件之前 —— 框架的顺序是
            // 「save(FAILED) → 返回发布任务 → 调用方 run 它」，业务侧没有排序权，只能在这里补。
            // 活跃循环的那次保存走不到这里：那时控制槽位仍在，由 unregister 负责通知（两者互斥）。
            if (firstFailure && withoutControlSlot) {
                afterCommit(() -> notifyFinished(execution));
            }
        }
    }

    private void cacheAfterCommit(String id, String snapshot, boolean terminal) {
        Runnable update = () -> {
            if (terminal) checkpoints.remove(id);
            else checkpoints.put(id, snapshot);
        };
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            update.run();
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override public void afterCommit() { update.run(); }
        });
    }

    @Override
    public void afterCommit(Runnable notification) {
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            notification.run();
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override public void afterCommit() { notification.run(); }
        });
    }

    @Override
    public Optional<Execution> findById(String executionId) {
        // 缓存只收已提交快照，恢复时重新解码可变消息集合。
        String snapshot = checkpoints.get(executionId);
        Integer persistedStatus = null;
        LocalDateTime persistedCompletedAt = null;
        if (snapshot == null) {
            StoredCheckpoint checkpoint = checkpointService.find(numericId(executionId)).orElse(null);
            snapshot = checkpoint == null ? null : checkpoint.snapshot();
            persistedStatus = checkpoint == null ? null : checkpoint.status();
            persistedCompletedAt = checkpoint == null ? null : checkpoint.completedAt();
        }
        if (snapshot == null) return Optional.empty();
        try {
            Execution restored = snapshotReader.read(snapshot);
            // 启动清理只更新摘要列，不能让旧快照重新开放已终结的执行。
            if (ExecutionStatusCodes.isTerminal(persistedStatus)
                    && !ExecutionStateCodec.isTerminalState(restored.getExecutionState())) {
                // 校正不是一次状态转换：结论与结束时间都取自已提交的值，
                // 调普通 complete()/fail()/cancel() 会用 Instant.now() 盖掉库里的 completed_at，
                // 收尸记录的时间就会随每次读取漂移。
                restored.restoreTerminalState(ExecutionStateCodec.decode(persistedStatus),
                        toInstant(persistedCompletedAt), interruptionReason(persistedStatus));
            }
            return Optional.of(restored);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("恢复执行检查点失败: executionId=" + executionId, e);
        }
    }

    /** 失败结局带原因；完成与取消本身不构成失败，失败信息留空。 */
    private static String interruptionReason(int persistedStatus) {
        return persistedStatus == ExecutionStatusCodes.FAILED ? "执行在服务重启时中断" : null;
    }

    /** 库列本地时间 → {@code Instant}；null 原样透传，由恢复入口兜底当前时刻。 */
    private static Instant toInstant(LocalDateTime local) {
        return local == null ? null : local.atZone(ZoneId.systemDefault()).toInstant();
    }

    @Override
    public ExecutionControlSignal register(String executionId) {
        if (executionId == null || executionId.isBlank()) {
            throw new IllegalArgumentException("执行 ID 不能为空");
        }
        synchronized (ExecutionCoordination.monitor(executionId)) {
            Execution persisted = findById(executionId).orElse(null);
            if (persisted != null && ExecutionStateCodec.isTerminalState(persisted.getExecutionState())) {
                throw new IllegalStateException("执行已结束，不能重新登记: executionId=" + executionId);
            }
            ExecutionControlSignal signal = new ExecutionControlSignal(executionId);
            if (active.putIfAbsent(executionId, signal) != null) {
                throw new IllegalStateException("执行已在运行: executionId=" + executionId);
            }
            return signal;
        }
    }

    @Override
    public void unregister(ExecutionControlSignal signal) {
        if (signal == null) throw new IllegalArgumentException("执行控制信号不能为空");
        Execution execution;
        boolean cancelledOnRelease;
        synchronized (ExecutionCoordination.monitor(signal.getExecutionId())) {
            if (!active.remove(signal.getExecutionId(), signal)) {
                throw new IllegalArgumentException("执行控制信号已释放");
            }
            execution = findById(signal.getExecutionId()).orElse(null);
            cancelledOnRelease = signal.isCancelRequired() && execution != null
                    && execution.getExecutionState() == ExecutionState.SUSPENDED;
            if (cancelledOnRelease) {
                execution.cancelChecked();
                save(execution);
            }
        }
        if (execution != null) afterCommit(() -> {
            if (execution.getExecutionState() == ExecutionState.SUSPENDED) {
                notifySuspended(execution);
            } else if (ExecutionStateCodec.isTerminalState(execution.getExecutionState())) {
                if (cancelledOnRelease) notifyCancelled(execution);
                else notifyFinished(execution);
            }
        });
    }

    @Override
    public boolean isActive(String executionId) {
        return active.containsKey(executionId);
    }

    @Override
    public void requireSuspend(String executionId) {
        requireActive(executionId).requireSuspend();
    }

    @Override
    public void requireCancel(String executionId) {
        synchronized (ExecutionCoordination.monitor(executionId)) {
            ExecutionControlSignal signal = active.get(executionId);
            if (signal != null) {
                signal.requireCancel();
                return;
            }
            Execution execution = findById(executionId).orElseThrow(
                    () -> new IllegalStateException("执行不存在: executionId=" + executionId));
            if (execution.getExecutionState() != ExecutionState.SUSPENDED) return;
            execution.cancelChecked();
            save(execution);
            afterCommit(() -> notifyCancelled(execution));
        }
    }

    /** 控制槽位释放且检查点提交后，才能开放卡片并处理结束事实（子执行挂起 / 根重放保留唤醒）。 */
    private void notifySuspended(Execution execution) {
        invokeLifecycle("开放工具卡片", execution, () -> readinessService.getObject().markReady(execution.getId()));
        invokeLifecycle("结束事实-挂起", execution, () -> subExecutionLifecycle.getObject().onSuspended(execution));
        invokeLifecycle("更新等待轮次", execution, () -> chatTurnService.getObject().markExecutionWaiting(execution));
    }

    /** 传递已提交对象，避免订阅方重复解码检查点。 */
    private void notifyFinished(Execution execution) {
        invokeLifecycle("收口工具卡片", execution, () -> toolCallService.getObject().cancelPendingToolCalls(execution.getId()));
        invokeLifecycle("结束事实-终结", execution, () -> subExecutionLifecycle.getObject().onFinished(execution));
        invokeLifecycle("保存会话用量", execution, () -> sessionService.getObject().saveExecutionContextUsage(execution));
        invokeLifecycle("收口业务轮次", execution, () -> chatTurnService.getObject().finishExecution(execution));
    }

    /** 挂起取消没有活跃循环发布终态事件，须在检查点提交与轮次收口后补发用量。 */
    private void notifyCancelled(Execution execution) {
        notifyFinished(execution);
        invokeLifecycle("发布挂起取消", execution, () -> runtimeEvents.getObject().onExecutionCancelled(
                new ExecutionCancelledEvent(execution.getId(), TokenInfo.from(execution.getTokenUsage()),
                        execution.eventMetaData())));
    }

    /** 各模块独立隔离失败，不能让一项失败阻止其余终结处理。 */
    private void invokeLifecycle(String action, Execution execution, Runnable callback) {
        try {
            callback.run();
        } catch (RuntimeException error) {
            log.error("执行生命周期处理失败: executionId={}, action={}", execution.getId(), action, error);
        }
    }

    private ExecutionControlSignal requireActive(String executionId) {
        ExecutionControlSignal signal = active.get(executionId);
        if (signal == null) {
            throw new IllegalStateException("执行未在运行: executionId=" + executionId);
        }
        return signal;
    }

    private static long numericId(String id) {
        try {
            return Long.parseLong(id);
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("执行 ID 必须是数字: executionId=" + id, e);
        }
    }

    private static int resolveStatus(ExecutionState state) {
        return ExecutionStateCodec.encode(state);
    }
}
