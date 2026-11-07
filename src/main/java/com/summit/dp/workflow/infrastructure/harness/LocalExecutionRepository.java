package com.summit.dp.workflow.infrastructure.harness;

import com.summit.dp.workflow.application.input.InputAutomationPolicy;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.application.port.ExecutionActivity;
import com.summit.dp.execution.application.port.ExecutionCheckpointStore;
import com.summit.dp.execution.application.service.ExecutionCheckpointService;
import com.summit.dp.shared.persistence.TransactionRetryTemplate;
import com.summit.dp.workflow.application.lifecycle.ExecutionLifecycleProjection;
import com.summit.dp.workflow.infrastructure.lifecycle.ExecutionCoordination;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import jakarta.annotation.PostConstruct;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.io.IOException;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.Map;
import java.util.Optional;

/** 本机控制信号与已提交检查点分开保存，恢复时不暴露未提交的消息。 */
@Repository
@RequiredArgsConstructor
@Slf4j
public class LocalExecutionRepository implements ExecutionRepository, ExecutionActivity {

    /** 重试器动作名，只用于日志与指标区分。 */
    private static final String RETRY_OPERATION = "保存执行检查点";

    private final ExecutionCheckpointService checkpointService;
    private final ObjectMapper objectMapper;
    /** 检查点正文的存储端口：文件命名、路径校验、流式读写、发布与删除都在实现里。 */
    private final ExecutionCheckpointStore checkpointStore;
    /**
     * 业务投影：状态提交之后「卡片 / 子执行 / 用量 / 轮次 / 事件」各自该做什么，全部在那边。
     *
     * <p>仓储只依赖这一个门面，不再逐个持有业务协作方 —— 否则存储组件会再次变成编排器。
     * 经 {@link ObjectProvider} 延迟取用，断开与执行仓储的构造期闭环。</p>
     */
    private final ObjectProvider<ExecutionLifecycleProjection> lifecycle;

    @Autowired
    private SessionExecutionRegistry executionRegistry = new SessionExecutionRegistry();

    /**
     * 事务管理器：仅用于「自己拥有事务时，每次重试开一个全新事务」。
     *
     * <p>可选注入 —— 直接 {@code new} 出来的用例没有事务基础设施，那就保持一次尝试、
     * 不做事务包装（与改造前行为一致）。</p>
     */
    @Autowired(required = false)
    private PlatformTransactionManager transactionManager;

    /**
     * 整笔保存的重试器：{@link #initRetryTemplate()} 里预建，读路径只做一次 volatile 读。
     *
     * <p>直接 {@code new} 出来的用例没走 Spring 生命周期，该字段为 {@code null}，
     * 由 {@link #checkpointSaveRetryTemplate()} 现场造一个降级使用（不持有、不加锁）。</p>
     */
    private volatile TransactionRetryTemplate saveRetry;

    /**
     * 预建保存重试器。
     *
     * <p>字段注入的 {@link PlatformTransactionManager} 发生在 {@code @PostConstruct} 之前，
     * 因此这里能拿到事务管理器。放在这里建而不是每次保存时 double-check，
     * 是为了让保存热路径在初始化之后**完全无锁**，同时指标在同一实例上累计。</p>
     */
    @PostConstruct
    void initRetryTemplate() {
        this.saveRetry = new TransactionRetryTemplate(transactionManager, RETRY_OPERATION);
    }

    /**
     * 保存执行：正文写文件、元数据写库。
     *
     * <p><b>事务边界在这里显式化</b>（不再用方法级 {@code @Transactional}）：方法自己拥有事务时，
     * 「开事务」交给 {@link #commitCheckpoint} 里的 {@link TransactionRetryTemplate} 逐次开启，
     * 于是每次重试都是全新事务/新快照；代理最外层那个大事务会把重试困在同一个过期快照里。</p>
     *
     * <p>调用方已经有事务时（受理阶段：轮次 + 用户消息 + 执行行一起提交），保存加入该事务、
     * 不重试，保住原子性。</p>
     */
    @Override
    public void save(Execution execution) {
        try (ExecutionPersistenceScope scope = ExecutionPersistenceScope.open()) {
            if (execution == null || execution.getId() == null || execution.getId().isBlank()) {
                throw new IllegalArgumentException("执行 ID 不能为空");
            }
            synchronized (ExecutionCoordination.monitor(execution.getId())) {
                long id = numericId(execution.getId());
                ExecutionState state = execution.getExecutionState();
                // 暂停意图的补写规则在投影里：哪些状态要落 USER_PAUSED 属于业务语义，不属于存储。
                projection().applyPauseIntent(execution, executionRegistry.isSuspendRequired(execution.getId()));

                Map<String, Object> attributes = execution.getAgentRequest().runtimeParametersOrDefault().getAttributes();
                Long sessionId = ExecutionAttributes.readLong(attributes, ExecutionAttributes.SESSION_ID);

                // 保存顺序不可调换：先把正文流式写成独立临时文件 → fsync → 原子发布成新文件名
                // （不覆盖旧文件）→ 再用版本条件把「新文件标识 + 状态 + resume_generation」提交进库。
                ExecutionCheckpointStore.CheckpointWriter writer = checkpointStore.begin(execution.getId());
                String fileId = writer.fileId();
                try {
                    // 直接流式写 OutputStream：不生成完整 JSON 字符串，也不建 JsonNode 树。
                    objectMapper.writeValue(writer.stream(), execution);
                    writer.publish();
                } catch (IOException failure) {
                    writer.rollback();
                    throw new IllegalStateException("保存执行检查点失败: executionId=" + execution.getId(), failure);
                } catch (RuntimeException failure) {
                    writer.rollback();
                    throw new IllegalStateException("保存执行检查点失败: executionId=" + id, failure);
                }

                String previousFile;
                boolean firstFailure;
                try {
                    ExecutionCheckpointService.SaveOutcome outcome = commitCheckpoint(execution, id, sessionId,
                            resolveStatus(state), fileId);
                    firstFailure = outcome.firstFailure();
                    previousFile = outcome.previousFile();
                } catch (RuntimeException failure) {
                    // 整笔最终失败（含重试耗尽）：删掉本次新文件，库内仍指向旧文件。
                    writer.rollback();
                    throw new IllegalStateException("保存执行检查点失败: executionId=" + id, failure);
                }

                // 事务结果决定文件归属：提交 = 释放登记并回收旧文件；回滚 = 删掉本次新文件、库内仍指向旧文件。
                String committedFile = fileId;
                String replacedFile = previousFile;
                if (!TransactionSynchronizationManager.isSynchronizationActive()) {
                    writer.complete();
                    reclaim(execution.getId(), committedFile, replacedFile);
                } else {
                    TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                        @Override public void afterCommit() {
                            writer.complete();
                            // 旧的已提交文件在提交后回收；删除失败不影响已提交事实，留给后续清理。
                            reclaim(execution.getId(), committedFile, replacedFile);
                        }

                        @Override public void afterCompletion(int status) {
                            if (status != STATUS_COMMITTED) {
                                writer.rollback();
                            }
                        }
                    });
                }

                Long rootSessionId = ExecutionAttributes.mailboxSessionId(attributes);
                boolean terminal = ExecutionStateCodec.isTerminalState(state);
                afterCommit(() -> executionRegistry.recordExecution(rootSessionId, sessionId, execution.getId(), terminal));
                boolean withoutControlSlot = !executionRegistry.isActive(execution.getId());
                // 上一次收口不完整时的补偿：这次落库顺带把收口补做一遍（投影内部按状态判据去重）。
                boolean closurePending = Boolean.TRUE.equals(
                        InputAutomationPolicy.attributes(execution).get(ExecutionLifecycleProjection.CLOSURE_INCOMPLETE));
                // 补一次终结投影，使轮次收口落在框架发布终态事件之前 —— 框架的顺序是
                // 「save(FAILED) → 返回发布任务 → 调用方 run 它」，业务侧没有排序权，只能在这里补。
                // 活跃循环的那次保存走不到这里：那时控制槽位仍在，由 unregister 负责通知（两者互斥）。
                if (firstFailure && withoutControlSlot) {
                    afterCommit(() -> projection().onFinished(execution));
                } else if (closurePending) {
                    // 崩溃或步骤失败留下的不完整收口：下一次落库时补做，标记随本次提交一起持久化。
                    afterCommit(() -> projection().completeClosure(execution));
                }
            }
        }
    }

    /** 保存冲突只重试数据库事务；整笔失败删除新正文，提交后才回收旧正文。 */
    private ExecutionCheckpointService.SaveOutcome commitCheckpoint(Execution execution, long id, Long sessionId,
                                                                    int status, String fileId) {
        return checkpointSaveRetryTemplate().execute(() -> checkpointService.save(id, sessionId, status, fileId,
                execution.getCreateAt(), execution.getStartAt(), execution.getCompletedAt()));
    }

    /**
     * 取保存重试器：初始化完成后只有一次 volatile 读，**不抢监视器**（每次保存都会调用）。
     *
     * <p>降级路径：直接 {@code new} 出来的用例没有 Spring 生命周期，{@code @PostConstruct}
     * 不会执行，字段为 {@code null} —— 此时现场造一个用完就丢的实例（不持有、不加锁）。
     * 这些用例靠反射注入事务管理器，读的是调用时刻的字段值，因此照样能重试；
     * 生产实例永远来自 {@link #initRetryTemplate()}，指标在同一实例上累计。</p>
     */
    private TransactionRetryTemplate checkpointSaveRetryTemplate() {
        TransactionRetryTemplate prebuilt = saveRetry;
        if (prebuilt != null) {
            return prebuilt;
        }
        // 仅直接 new 的用例会走到这里：不写回字段，避免多个线程争着发布实例。
        return new TransactionRetryTemplate(transactionManager, RETRY_OPERATION);
    }

    /**
     * 回收被替换掉的旧检查点文件。
     *
     * <p>与 {@link #findById(String)} 用同一把 {@code executionId} 锁：读取方「已查到旧引用、
     * 尚未打开文件」的窗口必须被保护，否则旧文件会在打开前被删掉，读变成莫名其妙的失败。</p>
     *
     * <p>删除失败只是垃圾文件，不能把已提交的保存伪报成失败，留给后续手动清理。</p>
     */
    private void reclaim(String executionId, String committedFile, String replacedFile) {
        if (replacedFile == null || replacedFile.equals(committedFile)) {
            return;
        }
        synchronized (ExecutionCoordination.monitor(executionId)) {
            checkpointStore.delete(executionId, replacedFile);
        }
    }

    @Override
    public void afterCommit(Runnable notification) {
        Runnable durableNotification = () -> {
            try (ExecutionPersistenceScope scope = ExecutionPersistenceScope.open()) {
                notification.run();
            }
        };
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            durableNotification.run();
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override public void afterCommit() { durableNotification.run(); }
        });
    }

    @Override
    public Optional<Execution> findById(String executionId) {
        try (ExecutionPersistenceScope scope = ExecutionPersistenceScope.open()) {
            // 只认数据库里的权威引用：没有应用级正文缓存，改了库内文件标识就立刻读到另一份内容。
            // 读文件必须在同一把 executionId 门闩内完成：保护「已查到引用、尚未打开文件」的窗口，
            // 让同一执行的保存/回收不会在中间把旧文件删掉。
            synchronized (ExecutionCoordination.monitor(executionId)) {
                ExecutionCheckpointService.StoredCheckpoint checkpoint =
                        checkpointService.find(numericId(executionId)).orElse(null);
                if (checkpoint == null || checkpoint.snapshotFile() == null) {
                    return Optional.empty();
                }
                // 流式反序列化，每次都是独立可变对象：修改返回值不会影响已提交的检查点文件。
                Execution restored = checkpointStore.read(executionId, checkpoint.snapshotFile(), Execution.class);
                // 启动清理只更新摘要列，不能让旧快照重新开放已终结的执行。
                if (ExecutionStatusCodes.isTerminal(checkpoint.status())
                        && !ExecutionStateCodec.isTerminalState(restored.getExecutionState())) {
                    // 校正不是一次状态转换：结论与结束时间都取自已提交的值，
                    // 调普通 complete()/fail()/cancel() 会用 Instant.now() 盖掉库里的 completed_at，
                    // 收尸记录的时间就会随每次读取漂移。
                    restored.restoreTerminalState(ExecutionStateCodec.decode(checkpoint.status()),
                            toInstant(checkpoint.completedAt()), interruptionReason(checkpoint.status()));
                }
                return Optional.of(restored);
            }
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
            if (persisted != null && Boolean.TRUE.equals(InputAutomationPolicy.attributes(persisted)
                    .get(InputAutomationPolicy.USER_PAUSED))) {
                throw new IllegalStateException("执行已由用户暂停，请主动恢复");
            }
            if (persisted != null) {
                executionRegistry.restoreExecution(
                        ExecutionAttributes.mailboxSessionId(InputAutomationPolicy.attributes(persisted)),
                        ExecutionAttributes.readLong(InputAutomationPolicy.attributes(persisted), ExecutionAttributes.SESSION_ID),
                        executionId);
            }
            return executionRegistry.acquire(executionId);
        }
    }

    @Override
    public void unregister(ExecutionControlSignal signal) {
        if (signal == null) throw new IllegalArgumentException("执行控制信号不能为空");
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override public void afterCompletion(int status) {
                    if (status != STATUS_COMMITTED) {
                        synchronized (ExecutionCoordination.monitor(signal.getExecutionId())) {
                            executionRegistry.release(signal);
                        }
                    }
                }
            });
        }
        afterCommit(() -> {
            Execution execution;
            boolean cancelledOnRelease;
            synchronized (ExecutionCoordination.monitor(signal.getExecutionId())) {
                if (!executionRegistry.release(signal)) {
                    throw new IllegalArgumentException("执行控制信号已释放");
                }
                execution = findById(signal.getExecutionId()).orElse(null);
                cancelledOnRelease = signal.isCancelRequired() && execution != null
                        && execution.getExecutionState() == ExecutionState.SUSPENDED;
                if (cancelledOnRelease) {
                    execution.cancelChecked();
                    save(execution);
                }
                if (execution != null && execution.getExecutionState() == ExecutionState.SUSPENDED) {
                    projection().onSuspended(execution);
                }
            }
            if (execution != null && ExecutionStateCodec.isTerminalState(execution.getExecutionState())) {
                if (cancelledOnRelease) projection().onCancelled(execution);
                else projection().onFinished(execution);
            }
            if (execution != null && execution.getExecutionState() == ExecutionState.SUSPENDED) {
                projection().resumeInputIfPending(execution);
            }
        });
    }

    @Override
    public boolean isActive(String executionId) {
        return executionRegistry.isActive(executionId);
    }

    @Override
    public void requireSuspend(String executionId) {
        synchronized (ExecutionCoordination.monitor(executionId)) {
            if (executionRegistry.requireSuspend(executionId)) return;
            Execution execution = findById(executionId).orElseThrow(
                    () -> new IllegalStateException("执行不存在: executionId=" + executionId));
            if (execution.getExecutionState() != ExecutionState.SUSPENDED) {
                throw new IllegalStateException("执行尚未运行或已经结束，无法暂停");
            }
            projection().applyPauseIntent(execution, true);
            save(execution);
        }
    }

    @Override
    public void requireCancel(String executionId) {
        synchronized (ExecutionCoordination.monitor(executionId)) {
            if (executionRegistry.requireCancel(executionId)) return;
            Execution execution = findById(executionId).orElseThrow(
                    () -> new IllegalStateException("执行不存在: executionId=" + executionId));
            // 异常退出后可能仍留着运行态；没有控制槽位就直接收口，不能只处理挂起态。
            ExecutionState state = execution.getExecutionState();
            if (ExecutionStateCodec.isTerminalState(state)) {
                executionRegistry.forgetFinishedExecution(executionId);
                return;
            }
            execution.cancelChecked();
            save(execution);
            afterCommit(() -> projection().onCancelled(execution));
        }
    }

    /**
     * 投影门面：状态提交之后「卡片 / 子执行 / 用量 / 轮次 / 事件」各自该做什么，只在
     * {@link ExecutionLifecycleProjection} 里定义 —— 仓储不再持有任何业务协作方。
     */
    private ExecutionLifecycleProjection projection() {
        return lifecycle.getObject();
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
