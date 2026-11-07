package com.summit.dp.execution.application.service;

import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.shared.exception.ClientException;
import lombok.RequiredArgsConstructor;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.Optional;

/**
 * 检查点元数据以版本条件写入，运行时适配不直接访问持久化对象。
 *
 * <p><b>正文不在本服务里</b>：这里只处理「文件标识 + 状态 + resume_generation + 时间」这些
 * 数据库列。正文的流式写入、发布与删除全部在 {@code ExecutionCheckpointStore} 内完成，
 * 调用方（{@code LocalExecutionRepository}）负责把两边按「先发布文件、再提交元数据」的顺序编排。</p>
 */
@Service
@RequiredArgsConstructor
public class ExecutionCheckpointService {
    private final ExecutionRepository repository;
    private final ApplicationEventPublisher events;

    /**
     * 保存检查点元数据（文件已发布之后的那个事务）。
     *
     * <p><b>终态与「待收口」由同一条 UPDATE 写入</b>：{@link Execution#changeCheckpoint} 里按目标状态
     * 维护 {@code closure_pending}，于是不存在「已终结但没人知道要收口」的行 —— 这正是崩溃窗口
     * 可恢复的前提（见 {@code V5__execution_closure_pending.sql}）。</p>
     *
     * @param snapshotFile 本次发布的检查点文件标识
     * @return 首次失败标记 + 被替换掉的旧文件标识（提交后由调用方删除，回滚时删除新文件）
     */
    @Transactional
    public SaveOutcome save(long executionId, Long sessionId, int status, String snapshotFile,
                            Instant createdAt, Instant startedAt, Instant completedAt) {
        if (status == ExecutionStatusCodes.CREATED && repository.findById(executionId).isEmpty()) {
            throwIf(sessionId == null, "执行请求缺少会话标识");
            Execution checkpoint = Execution.createCheckpoint(executionId, sessionId, status, snapshotFile,
                    toLocalTime(createdAt == null ? Instant.now() : createdAt),
                    toLocalTime(startedAt), toLocalTime(completedAt));
            repository.save(checkpoint);
            events.publishEvent(new SessionExecutionStateChanged(sessionId));
            return new SaveOutcome(false, null, ExecutionStatusCodes.isTerminal(status), false);
        }
        Execution checkpoint = repository.findCheckpointSummary(executionId).orElseThrow(ClientException::new);
        boolean firstFailure = status == ExecutionStatusCodes.FAILED
                && (checkpoint.getStatus() == null || checkpoint.getStatus() != ExecutionStatusCodes.FAILED);
        boolean stateChanged = !Integer.valueOf(status).equals(checkpoint.getStatus());
        boolean closureWasPending = Integer.valueOf(1).equals(checkpoint.getClosurePending());
        String previousFile = checkpoint.getSnapshotFile();
        checkpoint.changeCheckpoint(status, snapshotFile, toLocalTime(startedAt), toLocalTime(completedAt));
        repository.updateById(checkpoint);
        if (stateChanged) {
            events.publishEvent(new SessionExecutionStateChanged(checkpoint.getSessionId()));
        }
        return new SaveOutcome(firstFailure, previousFile, ExecutionStatusCodes.isTerminal(status), closureWasPending);
    }

    /**
     * 清掉待收口位（收口脚本全部成功之后调用）。
     *
     * <p>独立小事务、按 id 条件更新：只把 1 改成 0，不碰业务状态与版本，
     * 也不会把别处刚置上的待办事实一起抹掉。</p>
     *
     * @param executionId 执行 id
     * @return 是否真的清掉了一行
     */
    @Transactional
    public boolean clearClosurePending(long executionId) {
        return repository.clearClosurePending(executionId);
    }

    /** 只读数据库里的权威引用；正文由调用方按这个标识去文件里流式读取。 */
    public Optional<StoredCheckpoint> find(long executionId) {
        return repository.findById(executionId)
                .map(execution -> new StoredCheckpoint(execution.getSnapshotFile(), execution.getStatus(),
                        execution.getCompletedAt()));
    }

    private static LocalDateTime toLocalTime(Instant instant) {
        return instant == null ? null : LocalDateTime.ofInstant(instant, ZoneId.systemDefault());
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }

    /** 数据库里的检查点引用（文件标识、状态、结束时间）；正文不在其中。 */
    public record StoredCheckpoint(String snapshotFile, Integer status, LocalDateTime completedAt) { }

    /**
     * 保存结果。
     *
     * @param firstFailure    本次是否为「首次落为 FAILED」（启动失败收口的判据之一）
     * @param previousFile    本次被替换掉的旧文件标识，提交后删除
     * @param terminal        本次写入的状态是否终态（终态即有待收口的活）
     * @param closureWasPending 本次更新之前该行是否已带待收口标记（重试判据）
     */
    public record SaveOutcome(boolean firstFailure, String previousFile, boolean terminal,
                              boolean closureWasPending) { }
}
