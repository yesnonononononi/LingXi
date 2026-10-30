package com.summit.dp.workflow.infrastructure.harness;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.event.ExecutionCancelledEvent;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.event.TokenInfo;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.application.port.ExecutionCheckpointStore;
import com.summit.dp.execution.application.service.ExecutionCheckpointService;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.application.port.ExecutionActivity;
import com.summit.dp.workflow.infrastructure.lifecycle.ExecutionCoordination;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.workflow.infrastructure.lifecycle.SubExecutionLifecycle;
import com.summit.dp.workflow.application.projection.SessionContextUsageProjector;
import com.summit.dp.workflow.application.approval.ToolCallReadinessService;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.workflow.application.projection.ChatTurnLifecycleProjector;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.CannotAcquireLockException;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.IOException;
import java.sql.SQLException;
import java.sql.SQLTransientException;
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
    /** 检查点正文的存储端口：文件命名、路径校验、流式读写、发布与删除都在实现里。 */
    private final ExecutionCheckpointStore checkpointStore;
    /** 延迟取服务，避免生命周期处理与执行仓储形成构造期闭环。 */
    private final ObjectProvider<ToolCallReadinessService> readinessService;
    private final ObjectProvider<ToolCallService> toolCallService;
    /** 子执行「结束事实」协作器；经 ObjectProvider 断开与执行仓储的构造期闭环。 */
    private final ObjectProvider<SubExecutionLifecycle> subExecutionLifecycle;
    private final ObjectProvider<SessionContextUsageProjector> sessionService;
    private final ObjectProvider<ChatTurnLifecycleProjector> chatTurnService;
    private final ObjectProvider<RuntimeEventPublisher> runtimeEvents;

    /** 进程内活跃执行的控制信号；与框架 InMemoryActiveExecutionRegistry 语义一致。 */
    private final Map<String, ExecutionControlSignal> active = new ConcurrentHashMap<>();

    /** 保存的整笔重试上限（含首次尝试）；只对 SQLite 锁冲突生效。 */
    private static final int SAVE_MAX_ATTEMPTS = 4;
    /** 每次重试前的线性退避基数（毫秒）。 */
    private static final long SAVE_RETRY_BACKOFF_MILLIS = 20L;

    /**
     * 事务管理器：仅用于「自己拥有事务时，每次重试开一个全新事务」。
     *
     * <p>可选注入 —— 直接 {@code new} 出来的用例没有事务基础设施，那就保持一次尝试、
     * 不做事务包装（与改造前行为一致）。</p>
     */
    @Autowired(required = false)
    private PlatformTransactionManager transactionManager;

    /**
     * 保存执行：正文写文件、元数据写库。
     *
     * <p><b>事务边界在这里显式化</b>（不再用方法级 {@code @Transactional}）：方法自己拥有事务时，
     * 「开事务」交给 {@link #commitCheckpoint} 里的 {@link TransactionTemplate} 逐次开启，
     * 于是每次重试都是全新事务/新快照；代理最外层那个大事务会把重试困在同一个过期快照里。</p>
     *
     * <p>调用方已经有事务时（受理阶段：轮次 + 用户消息 + 执行行一起提交），保存加入该事务、
     * 不重试，保住原子性。</p>
     */
    @Override
    public void save(Execution execution) {
        if (execution == null || execution.getId() == null || execution.getId().isBlank()) {
            throw new IllegalArgumentException("执行 ID 不能为空");
        }
        synchronized (ExecutionCoordination.monitor(execution.getId())) {
            long id = numericId(execution.getId());
            ExecutionState state = execution.getExecutionState();

            Map<String, Object> attributes = execution.getAgentRequest() == null ? Map.of()
                    : execution.getAgentRequest().runtimeParametersOrDefault().getAttributes();
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

            boolean withoutControlSlot = !active.containsKey(execution.getId());
            // 补一次终结广播，使轮次收口落在框架发布终态事件之前 —— 框架的顺序是
            // 「save(FAILED) → 返回发布任务 → 调用方 run 它」，业务侧没有排序权，只能在这里补。
            // 活跃循环的那次保存走不到这里：那时控制槽位仍在，由 unregister 负责通知（两者互斥）。
            if (firstFailure && withoutControlSlot) {
                afterCommit(() -> notifyFinished(execution));
            }
        }
    }

    /**
     * 把「新文件标识 + 状态 + 时间」提交进库；自己拥有事务时对整笔保存做有限重试。
     *
     * <p><b>为什么必须整笔重试，而不是只重试 UPDATE</b>：SQLite 的事务第一次读就固定了快照。
     * 两个不同执行并发保存时，A 提交后 B 在自己的旧快照上写会立刻收到
     * {@code SQLITE_BUSY_SNAPSHOT} —— 在同一个已过期的读事务里重试 UPDATE 永远不会成功，
     * 必须丢弃整个事务、用全新事务重新读一遍再写。</p>
     *
     * <p><b>为什么重试只能发生在事务外</b>：{@code LocalExecutionRepository.save} 自己开事务时，
     * 每次尝试都由 {@link TransactionTemplate} 重新开启（{@code REQUIRES_NEW}），
     * 于是每次尝试都是新快照。若调用方已经有事务（例如受理阶段要把轮次、消息、执行行一起提交），
     * 保存必须加入那个事务以保住原子性 —— 那条路径不重试，锁冲突如实上抛。</p>
     *
     * <p><b>文件归属</b>：正文只发布一次（重试的是数据库事务，不是文件），
     * 每次失败的尝试只回滚数据库；整笔最终失败时由调用方 {@code writer.rollback()} 删掉本次新文件；
     * 提交成功后才删旧文件。</p>
     */
    private ExecutionCheckpointService.SaveOutcome commitCheckpoint(Execution execution, long id, Long sessionId,
                                                                    int status, String fileId) {
        if (TransactionSynchronizationManager.isActualTransactionActive() || transactionManager == null) {
            // 加入调用方事务（原子性与受理等场景绑定），或测试里没有任何事务基础设施：
            // 两者都只尝试一次，不在这里另开事务。
            return checkpointService.save(id, sessionId, status, fileId, execution.getCreateAt(),
                    execution.getStartAt(), execution.getCompletedAt());
        }
        RuntimeException lastFailure = null;
        for (int attempt = 1; attempt <= SAVE_MAX_ATTEMPTS; attempt++) {
            TransactionTemplate transaction = new TransactionTemplate(transactionManager);
            // 每次尝试都是全新事务/新快照：这是 SQLITE_BUSY_SNAPSHOT 能重试成功的唯一前提。
            transaction.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
            try {
                return transaction.execute(state -> checkpointService.save(id, sessionId, status, fileId,
                        execution.getCreateAt(), execution.getStartAt(), execution.getCompletedAt()));
            } catch (RuntimeException failure) {
                lastFailure = failure;
                if (attempt == SAVE_MAX_ATTEMPTS || !isLockConflict(failure)) {
                    throw failure;
                }
                log.warn("检查点保存遇到数据库锁冲突，换新事务重试: executionId={}, attempt={}/{}, cause={}",
                        execution.getId(), attempt, SAVE_MAX_ATTEMPTS, rootMessage(failure));
                backoffBeforeRetry(attempt);
            }
        }
        throw lastFailure == null ? new IllegalStateException("保存执行检查点失败") : lastFailure;
    }

    /**
     * 只对数据库锁冲突重试。
     *
     * <p>SQLite 单写者下，并发写同一库必然有 {@code SQLITE_BUSY}（库被写）/
     * {@code SQLITE_BUSY_SNAPSHOT}（读快照已过期）；这类冲突换新事务重放就能成功。
     * 其它异常（约束、SQL 错误、业务校验）一律不重试 —— 重放同样的输入只会得到同样的失败。</p>
     */
    private static boolean isLockConflict(Throwable failure) {
        for (Throwable cause = failure; cause != null; cause = cause.getCause()) {
            if (cause instanceof CannotAcquireLockException || cause instanceof SQLTransientException) {
                return true;
            }
            if (cause instanceof SQLException sqlFailure) {
                int code = sqlFailure.getErrorCode();
                // 5=SQLITE_BUSY, 6=SQLITE_LOCKED, 517=SQLITE_BUSY_SNAPSHOT, 262=SQLITE_LOCKED_SHAREDCACHE
                if (code == 5 || code == 6 || code == 517 || code == 262) {
                    return true;
                }
            }
            String message = cause.getMessage();
            if (message != null && (message.contains("SQLITE_BUSY") || message.contains("SQLITE_LOCKED"))) {
                return true;
            }
            if (cause.getCause() == cause) {
                break;
            }
        }
        return false;
    }

    private static String rootMessage(Throwable failure) {
        Throwable cause = failure;
        while (cause.getCause() != null && cause.getCause() != cause) {
            cause = cause.getCause();
        }
        return cause.getMessage();
    }

    /** 退避随尝试次数线性增长（20ms、40ms、60ms）：SQLite 的写冲突窗口很短，不需要更长。 */
    private static void backoffBeforeRetry(int attempt) {
        try {
            Thread.sleep((long) SAVE_RETRY_BACKOFF_MILLIS * attempt);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
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
