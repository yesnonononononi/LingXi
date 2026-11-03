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
            return new SaveOutcome(false, null);
        }
        Execution checkpoint = repository.findCheckpointSummary(executionId).orElseThrow(ClientException::new);
        boolean firstFailure = status == ExecutionStatusCodes.FAILED
                && (checkpoint.getStatus() == null || checkpoint.getStatus() != ExecutionStatusCodes.FAILED);
        boolean stateChanged = !Integer.valueOf(status).equals(checkpoint.getStatus());
        String previousFile = checkpoint.getSnapshotFile();
        checkpoint.changeCheckpoint(status, snapshotFile, toLocalTime(startedAt), toLocalTime(completedAt));
        repository.updateById(checkpoint);
        if (stateChanged) {
            events.publishEvent(new SessionExecutionStateChanged(checkpoint.getSessionId()));
        }
        return new SaveOutcome(firstFailure, previousFile);
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

    /** 保存结果：{@code previousFile} 是本次被替换掉的旧文件标识，提交后删除。 */
    public record SaveOutcome(boolean firstFailure, String previousFile) { }
}
