package com.summit.dp.execution.application.service;

import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.shared.exception.ClientException;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.Optional;

/** 检查点以版本条件写入，运行时适配不直接访问持久化对象。 */
@Service
@RequiredArgsConstructor
public class ExecutionCheckpointService {
    private final ExecutionRepository repository;

    @Transactional
    public boolean save(long executionId, Long sessionId, int status, String snapshot,
                        Instant createdAt, Instant startedAt, Instant completedAt) {
        if (status == ExecutionStatusCodes.CREATED && repository.findById(executionId).isEmpty()) {
            throwIf(sessionId == null, "执行请求缺少会话标识");
            Execution checkpoint = Execution.createCheckpoint(executionId, sessionId, status, snapshot,
                    toLocalTime(createdAt == null ? Instant.now() : createdAt),
                    toLocalTime(startedAt), toLocalTime(completedAt));
            repository.save(checkpoint);
            return false;
        }
        Execution checkpoint = repository.findCheckpointSummary(executionId).orElseThrow(ClientException::new);
        boolean firstFailure = status == ExecutionStatusCodes.FAILED
                && (checkpoint.getStatus() == null || checkpoint.getStatus() != ExecutionStatusCodes.FAILED);
        checkpoint.changeCheckpoint(status, snapshot, toLocalTime(startedAt), toLocalTime(completedAt));
        repository.updateById(checkpoint);
        return firstFailure;
    }

    public Optional<StoredCheckpoint> find(long executionId) {
        return repository.findById(executionId)
                .map(execution -> new StoredCheckpoint(execution.getSnapshot(), execution.getStatus(), execution.getCompletedAt()));
    }

    private static LocalDateTime toLocalTime(Instant instant) {
        return instant == null ? null : LocalDateTime.ofInstant(instant, ZoneId.systemDefault());
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }

    public record StoredCheckpoint(String snapshot, Integer status, LocalDateTime completedAt) { }
}
