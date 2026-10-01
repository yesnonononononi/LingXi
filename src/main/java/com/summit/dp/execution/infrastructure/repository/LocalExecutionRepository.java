package com.summit.dp.execution.infrastructure.repository;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.runtime.loop.ExecutionTransitions;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.domain.lifecycle.ExecutionLifecycleListener;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 本地执行仓储：进程内控制信号 + 数据库检查点。
 *
 * <p>纯本地 harness 实现，不含任何跨 worker 协调语义：</p>
 * <ul>
 *   <li><b>控制面</b>：暂停 / 取消通过进程内的 {@link ExecutionControlSignal} 投递，
 *       在 loop 边界被协作式观察。互斥由 {@code ConcurrentHashMap.putIfAbsent} 保证。</li>
 *   <li><b>数据面</b>：snapshot 落库，使中断的执行可在同进程内恢复，
 *       也便于业务侧查询 execution 记录。</li>
 * </ul>
 *
 * <p>与分布式实现的区别：不再有 worker_id / lease_until / desired_action，
 * 不做租约续期，不做故障检测与跨节点接管。进程崩溃后内存信号丢失，
 * 中断的执行需要业务侧显式发起 resume。</p>
 */
@Repository
@RequiredArgsConstructor
@Slf4j
public class LocalExecutionRepository implements ExecutionRepository {

    private final ExecutionMapper executionMapper;
    private final ObjectMapper objectMapper;
    /**
     * 执行生命周期订阅者：在 loop 边界把「挂起 / 终结」信号广播给关心工具调用卡片生命周期的上层。
     *
     * <p><b>端口反转（评审 P1-⑥）：</b>本仓储不再直接依赖 toolcall 应用服务；
     * {@code execution.infrastructure} 因此不 import 任何 toolcall 类型，
     * 具体响应（推送 pending 卡片 / 收尾残留卡片）由 toolcall 侧的适配器实现本端口完成。</p>
     */
    private final List<ExecutionLifecycleListener> lifecycleListeners;

    /** 进程内活跃执行的控制信号；与框架 InMemoryActiveExecutionRegistry 语义一致。 */
    private final Map<String, ExecutionControlSignal> active = new java.util.concurrent.ConcurrentHashMap<>();
    /** 已提交检查点的不可变缓存；恢复时解码，避免读到未提交的消息追加。 */
    private final Map<String, String> checkpoints = new java.util.concurrent.ConcurrentHashMap<>();

    @Override
    @Transactional
    public void save(Execution execution) {
        if (execution == null || execution.getId() == null || execution.getId().isBlank()) {
            throw new IllegalArgumentException("Execution.id is required");
        }
        long id = numericId(execution.getId());
        ExecutionState state = execution.getExecutionState();

        boolean terminal = state == ExecutionState.COMPLETED || state == ExecutionState.FAILED
                || state == ExecutionState.CANCELLED;
        String snapshot;
        try {
            snapshot = objectMapper.writeValueAsString(execution);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Failed to serialize execution " + execution.getId(), e);
        }

        if (state == ExecutionState.CREATED && executionMapper.selectById(id) == null) {
            create(execution, id, snapshot);
            cacheAfterCommit(execution.getId(), snapshot, terminal);
            return;
        }
        // Approval results and cancellation also update inactive, suspended checkpoints.
        ExecutionPO checkpoint = new ExecutionPO();
        checkpoint.setId(id);
        checkpoint.setStatus(statusOf(state));
        checkpoint.setSnapshot(snapshot);
        applySummary(checkpoint, execution);
        int updated = executionMapper.updateById(checkpoint);
        if (updated != 1) throw new IllegalStateException("Execution checkpoint row missing: " + id);
        cacheAfterCommit(execution.getId(), snapshot, terminal);
    }

    /**
     * 把「查询用摘要」从执行快照摊到独立列：根执行归属与生命周期时间。
     *
     * <p><b>只写有值的字段</b>：null 一律跳过，配合 MyBatis-Plus 默认的 NOT_NULL 更新策略，
     * 未赋值的列不会进入 UPDATE 语句 —— 所以暂停、恢复、甚至一次失败的重试，都不会把已知的
     * 开始时间抹掉（「空值不覆盖已知数据」由此显式成立，而不是碰巧成立）。</p>
     *
     * <p><b>时间语义</b>：{@code startedAt} 只在 {@code Execution.start()} 时设置，恢复不重置，
     * 所以「首次开始时间」天然不被覆盖；{@code completedAt} 只在进入终态时由框架设置，
     * 挂起（SUSPENDED）时为 null → 不写入 → 未结束执行保持 NULL。</p>
     *
     * <p><b>不再摊模型与 token</b>：「用的哪个模型、花了多少 token」是业务事实，权威在
     * {@code chat_turn}（模型由业务受理时解析写入，用量由框架完成事件回填）。
     * 本表只留框架自己的运行记录，同一事实不两处存放。</p>
     */
    private void applySummary(ExecutionPO checkpoint, Execution execution) {
        AgentRequest request = execution.getAgentRequest();
        Map<String, Object> attributes = request == null
                ? Map.of()
                : request.runtimeParametersOrDefault().getAttributes();

        // 主执行没有该属性（ExecutionContext.root 不写），子执行由委派方写入父执行 id。
        checkpoint.setRootExecutionId(
                ExecutionAttributes.readLong(attributes, ExecutionAttributes.ROOT_EXECUTION_ID));

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
        if (request == null) throw new IllegalArgumentException("Execution.agentRequest is required");
        Map<String, Object> attrs = request.runtimeParametersOrDefault().getAttributes();
        Long sessionId = optionalNumber(attrs.get(ExecutionAttributes.SESSION_ID));
        if (sessionId == null) throw new IllegalArgumentException("session id is required");
        ExecutionPO checkpoint = new ExecutionPO();
        checkpoint.setId(id);
        checkpoint.setSessionId(sessionId);
        checkpoint.setStatus(statusOf(execution.getExecutionState()));
        checkpoint.setSnapshot(snapshot);
        checkpoint.setCreatedAt(LocalDateTime.ofInstant(
                execution.getCreateAt() == null ? Instant.now() : execution.getCreateAt(), ZoneId.systemDefault()));
        // 建行时就带上根执行归属：即使执行在首次保存后立刻失败，
        // 也能看出它属于哪个主执行，而不是等到第一轮检查点才有值。
        applySummary(checkpoint, execution);
        if (executionMapper.insert(checkpoint) != 1) {
            throw new IllegalStateException("Failed to create execution checkpoint: " + id);
        }
    }

    @Override
    public Optional<Execution> findById(String executionId) {
        // Only committed, immutable checkpoints enter the cache. Decoding restores
        // mutable message lists without exposing uncommitted changes on resume.
        String snapshot = checkpoints.get(executionId);
        if (snapshot == null) {
            ExecutionPO checkpoint = executionMapper.selectById(numericId(executionId));
            snapshot = checkpoint == null ? null : checkpoint.getSnapshot();
        }
        if (snapshot == null) return Optional.empty();
        try {
            return Optional.of(objectMapper.readValue(snapshot, Execution.class));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Failed to restore execution " + executionId, e);
        }
    }

    @Override
    public synchronized ExecutionControlSignal register(String executionId) {
        if (executionId == null || executionId.isBlank()) {
            throw new IllegalArgumentException("executionId is required");
        }
        Execution persisted = findById(executionId).orElse(null);
        if (persisted != null && (persisted.getExecutionState() == ExecutionState.CANCELLED
                || persisted.getExecutionState() == ExecutionState.COMPLETED
                || persisted.getExecutionState() == ExecutionState.FAILED)) {
            throw new IllegalStateException("execution has ended: " + executionId);
        }
        ExecutionControlSignal signal = new ExecutionControlSignal(executionId);
        if (active.putIfAbsent(executionId, signal) != null) {
            throw new IllegalStateException("execution is already running: " + executionId);
        }
        return signal;
    }

    @Override
    public synchronized void unregister(ExecutionControlSignal signal) {
        if (signal == null || !active.remove(signal.getExecutionId(), signal)) {
            throw new IllegalArgumentException("execution control signal is not active");
        }
        if (signal.isCancelRequired()) requireCancel(signal.getExecutionId());
        findById(signal.getExecutionId()).ifPresent(execution -> {
            if (execution.getExecutionState() == ExecutionState.SUSPENDED) {
                notifySuspended(execution.getId());
            } else if (execution.getExecutionState() == ExecutionState.CANCELLED
                    || execution.getExecutionState() == ExecutionState.FAILED
                    || execution.getExecutionState() == ExecutionState.COMPLETED) {
                notifyFinished(execution);
            }
        });
    }

    @Override
    public void requireSuspend(String executionId) {
        requireActive(executionId).requireSuspend();
    }

    @Override
    public synchronized void requireCancel(String executionId) {
        ExecutionControlSignal signal = active.get(executionId);
        if (signal != null) {
            signal.requireCancel();
            return;
        }
        Execution execution = findById(executionId).orElseThrow(
                () -> new IllegalStateException("execution not found: " + executionId));
        if (execution.getExecutionState() != ExecutionState.SUSPENDED) return;
        ExecutionTransitions.cancel(execution);
        save(execution);
        notifyFinished(execution);
    }

    /** loop 边界：执行挂起 → 广播给订阅者（推送待处理卡片）。 */
    private void notifySuspended(String executionId) {
        for (ExecutionLifecycleListener listener : lifecycleListeners) {
            listener.onExecutionSuspended(executionId);
        }
    }

    /**
     * loop 边界：执行终结（完成 / 失败 / 取消）→ 广播给订阅者（收尾残留卡片等）。
     *
     * <p>把已加载的 {@link Execution} 随信号递出：广播点刚 {@code findById} 过，
     * 订阅方要的 metric 就在对象里，不必再反序列化一次 snapshot。</p>
     */
    private void notifyFinished(Execution execution) {
        for (ExecutionLifecycleListener listener : lifecycleListeners) {
            listener.onExecutionFinished(execution.getId(), execution);
        }
    }

    private ExecutionControlSignal requireActive(String executionId) {
        ExecutionControlSignal signal = active.get(executionId);
        if (signal == null) {
            throw new IllegalStateException("execution is not running: " + executionId);
        }
        return signal;
    }

    private static long numericId(String id) {
        try {
            return Long.parseLong(id);
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("Execution ID must be numeric: " + id, e);
        }
    }

    private static Long optionalNumber(Object value) {
        if (value == null) return null;
        return value instanceof Number number ? number.longValue() : Long.valueOf(value.toString());
    }

    private static int statusOf(ExecutionState state) {
        return switch (state) {
            case CREATED -> 0; case RUNNING -> 1; case SUSPENDED -> 2;
            case COMPLETED -> 3; case FAILED -> 4; case CANCELLED -> 5;
        };
    }
}
