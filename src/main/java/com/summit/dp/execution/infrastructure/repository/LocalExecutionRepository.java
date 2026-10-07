package com.summit.dp.execution.infrastructure.repository;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.summit.dp.execution.domain.lifecycle.ExecutionActivity;
import com.summit.dp.execution.domain.lifecycle.ExecutionCoordination;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.session.application.service.SessionAggregateService;
import com.summit.dp.toolcall.application.service.ToolCallReadinessService;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.toolcall.infrastructure.listener.DelegationSettleService;
import com.summit.dp.turn.application.service.ChatTurnService;
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

    private final ExecutionMapper executionMapper;
    private final ObjectMapper objectMapper;
    /** 延迟取服务，避免生命周期处理与执行仓储形成构造期闭环。 */
    private final ObjectProvider<ToolCallReadinessService> readinessService;
    private final ObjectProvider<ToolCallService> toolCallService;
    private final ObjectProvider<DelegationSettleService> delegationService;
    private final ObjectProvider<SessionAggregateService> sessionService;
    private final ObjectProvider<ChatTurnService> chatTurnService;

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

        boolean terminal = ExecutionStatusCodes.isTerminalState(state);
        String snapshot;
        try {
            snapshot = objectMapper.writeValueAsString(execution);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("保存执行检查点失败: executionId=" + execution.getId(), e);
        }

        if (state == ExecutionState.CREATED && executionMapper.selectById(id) == null) {
            create(execution, id, snapshot);
            cacheAfterCommit(execution.getId(), snapshot, terminal);
            return;
        }
        // 审批与取消也会更新已退出控制槽位的暂停检查点。
        ExecutionPO previous = executionMapper.selectOne(Wrappers.<ExecutionPO>lambdaQuery()
                .select(ExecutionPO::getId, ExecutionPO::getStatus, ExecutionPO::getVersion,
                        ExecutionPO::getSessionId, ExecutionPO::getResumeGeneration)
                .eq(ExecutionPO::getId, id));
        if (previous != null && ExecutionStatusCodes.isTerminal(previous.getStatus())
                && previous.getStatus() != resolveStatus(state)) {
            throw new IllegalStateException("执行已结束，不能覆盖为运行状态: executionId=" + id);
        }
        // 「首次落 FAILED」且「本进程没有该执行的控制槽位」⇒ 这是初始化失败路径：框架从未 register
        // （register 只在 loop 启动时发生），因此也不会有人来 unregister，终结信号无人广播。
        boolean firstFailure = state == ExecutionState.FAILED
                && (previous == null || previous.getStatus() == null
                    || previous.getStatus() != ExecutionStatusCodes.FAILED);
        boolean withoutControlSlot = !active.containsKey(execution.getId());
        long expectedVersion = previous == null || previous.getVersion() == null ? 1L : previous.getVersion();
        long expectedGeneration = previous == null || previous.getResumeGeneration() == null
                ? 0L : previous.getResumeGeneration();
        long nextGeneration = resolveNextGeneration(expectedGeneration, previous == null ? null : previous.getStatus(), state);
        ExecutionPO checkpoint = new ExecutionPO();
        checkpoint.setId(id);
        checkpoint.setStatus(resolveStatus(state));
        checkpoint.setResumeGeneration(nextGeneration);
        checkpoint.setSnapshot(snapshot);
        checkpoint.setVersion(expectedVersion + 1);
        applySummary(checkpoint, execution);
        int updated = executionMapper.update(checkpoint, Wrappers.<ExecutionPO>lambdaUpdate()
                .eq(ExecutionPO::getId, id).eq(ExecutionPO::getVersion, expectedVersion));
        if (updated != 1) throw new IllegalStateException("执行检查点不存在: executionId=" + id);
        cacheAfterCommit(execution.getId(), snapshot, terminal);
        // 补一次终结广播，使轮次收口落在框架发布终态事件之前 —— 框架的顺序是
        // 「save(FAILED) → 返回发布任务 → 调用方 run 它」，业务侧没有排序权，只能在这里补。
        // 活跃循环的那次保存走不到这里：那时控制槽位仍在，由 unregister 负责通知（两者互斥）。
        if (firstFailure && withoutControlSlot) {
            afterCommit(() -> notifyFinished(execution));
        }
        }
    }

    /**
     * 恢复代际的递增规则：<b>只在「行前态不是 SUSPENDED 且本次落为 SUSPENDED」时 +1</b>。
     *
     * <p><b>为什么必须用行前态而不是「ACTIVE map 是否为空」</b>：ACTIVE map 表达的是
     * 「本进程此刻有没有控制信号」，与「这次落库是不是一次新的挂起边界」不是同一件事。
     * 用它推断会出现两类错：同态重复 save（暂停检查点被审批、取消路径反复重写）被误判成
     * 新边界而递增；以及进程刚启动、map 空但行已经是 SUSPENDED 时被误判成新边界。
     * 前者会让已受理的恢复任务被判为 superseded 而永远不派发。</p>
     *
     * <p>行前态来自同一次带 {@code version} 条件的事务读，配合 update 的 version 条件，
     * 并发保存只有一方能成功递增，另一方命中 0 行抛错 —— 不会出现两次 +1。</p>
     *
     * <p>COMMAND 的 RUNNING → SUSPENDED 同样是一次新边界，因此不在此排除。</p>
     */
    private static long resolveNextGeneration(long currentGeneration, Integer previousStatus, ExecutionState next) {
        boolean enteringSuspended = next == ExecutionState.SUSPENDED
                && !ExecutionStatusCodes.isSuspended(previousStatus);
        return enteringSuspended ? currentGeneration + 1 : currentGeneration;
    }

    /** 空值不覆盖既有生命周期时间，用量由业务轮次保存。 */
    private void applySummary(ExecutionPO checkpoint, Execution execution) {
        checkpoint.setStartedAt(toLocalDateTime(execution.getStartAt()));
        checkpoint.setCompletedAt(toLocalDateTime(execution.getCompletedAt()));
    }

    /** {@code Instant} → 库列用的本地时间；null 原样透传（调用方据此跳过该列）。 */
    private static LocalDateTime toLocalDateTime(Instant instant) {
        return instant == null ? null : LocalDateTime.ofInstant(instant, ZoneId.systemDefault());
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

    private void create(Execution execution, long id, String snapshot) {
        AgentRequest request = execution.getAgentRequest();
        if (request == null) throw new IllegalArgumentException("执行请求不能为空");
        Map<String, Object> attrs = request.runtimeParametersOrDefault().getAttributes();
        Long sessionId = optionalNumber(attrs.get(ExecutionAttributes.SESSION_ID));
        if (sessionId == null) throw new IllegalArgumentException("执行请求缺少会话 ID");
        ExecutionPO checkpoint = new ExecutionPO();
        checkpoint.setId(id);
        checkpoint.setVersion(1L);
        checkpoint.setSessionId(sessionId);
        checkpoint.setStatus(resolveStatus(execution.getExecutionState()));
        checkpoint.setSnapshot(snapshot);
        checkpoint.setCreatedAt(LocalDateTime.ofInstant(
                execution.getCreateAt() == null ? Instant.now() : execution.getCreateAt(), ZoneId.systemDefault()));
        applySummary(checkpoint, execution);
        if (executionMapper.insert(checkpoint) != 1) {
            throw new IllegalStateException("创建执行检查点失败: executionId=" + id);
        }
    }

    @Override
    public Optional<Execution> findById(String executionId) {
        // 缓存只收已提交快照，恢复时重新解码可变消息集合。
        String snapshot = checkpoints.get(executionId);
        Integer persistedStatus = null;
        LocalDateTime persistedCompletedAt = null;
        if (snapshot == null) {
            ExecutionPO checkpoint = executionMapper.selectById(numericId(executionId));
            snapshot = checkpoint == null ? null : checkpoint.getSnapshot();
            persistedStatus = checkpoint == null ? null : checkpoint.getStatus();
            persistedCompletedAt = checkpoint == null ? null : checkpoint.getCompletedAt();
        }
        if (snapshot == null) return Optional.empty();
        try {
            Execution restored = objectMapper.readValue(snapshot, Execution.class);
            // 启动清理只更新摘要列，不能让旧快照重新开放已终结的执行。
            if (ExecutionStatusCodes.isTerminal(persistedStatus)
                    && !ExecutionStatusCodes.isTerminalState(restored.getExecutionState())) {
                // 校正不是一次状态转换：结论与结束时间都取自已提交的值，
                // 调普通 complete()/fail()/cancel() 会用 Instant.now() 盖掉库里的 completed_at，
                // 收尸记录的时间就会随每次读取漂移。
                restored.restoreTerminalState(ExecutionStatusCodes.decode(persistedStatus),
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
            if (persisted != null && ExecutionStatusCodes.isTerminalState(persisted.getExecutionState())) {
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
        synchronized (ExecutionCoordination.monitor(signal.getExecutionId())) {
            if (!active.remove(signal.getExecutionId(), signal)) {
                throw new IllegalArgumentException("执行控制信号已释放");
            }
            if (signal.isCancelRequired()) {
                Execution cancelled = findById(signal.getExecutionId()).orElse(null);
                if (cancelled != null && cancelled.getExecutionState() == ExecutionState.SUSPENDED) {
                    cancelled.cancelChecked();
                    save(cancelled);
                }
            }
            execution = findById(signal.getExecutionId()).orElse(null);
        }
        if (execution != null) afterCommit(() -> {
            if (execution.getExecutionState() == ExecutionState.SUSPENDED) {
                notifySuspended(execution);
            } else if (ExecutionStatusCodes.isTerminalState(execution.getExecutionState())) {
                notifyFinished(execution);
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
            afterCommit(() -> notifyFinished(execution));
        }
    }

    /** 控制槽位释放且检查点提交后，才能开放卡片并校准委派结果。 */
    private void notifySuspended(Execution execution) {
        invokeLifecycle("开放工具卡片", execution, () -> readinessService.getObject().markReady(execution.getId()));
        invokeLifecycle("校准委派结果", execution, () -> delegationService.getObject().reconcileSuspendedExecution(execution.getId()));
        invokeLifecycle("更新等待轮次", execution, () -> chatTurnService.getObject().markExecutionWaiting(execution));
    }

    /** 传递已提交对象，避免订阅方重复解码检查点。 */
    private void notifyFinished(Execution execution) {
        invokeLifecycle("收口工具卡片", execution, () -> toolCallService.getObject().cancelPendingToolCalls(execution.getId()));
        invokeLifecycle("回填委派结果", execution, () -> delegationService.getObject().backfillFinishedExecution(execution));
        invokeLifecycle("保存会话用量", execution, () -> sessionService.getObject().saveExecutionContextUsage(execution));
        invokeLifecycle("收口业务轮次", execution, () -> chatTurnService.getObject().finishExecution(execution));
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

    private static Long optionalNumber(Object value) {
        if (value == null) return null;
        return value instanceof Number number ? number.longValue() : Long.valueOf(value.toString());
    }

    private static int resolveStatus(ExecutionState state) {
        return ExecutionStatusCodes.encode(state);
    }
}
