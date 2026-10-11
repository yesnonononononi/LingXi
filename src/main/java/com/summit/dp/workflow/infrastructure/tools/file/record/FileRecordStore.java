package com.summit.dp.workflow.infrastructure.tools.file.record;

import lombok.NonNull;

import java.io.Serializable;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;

/** 记录标识和同文件版本由存储分配，调用方不能自行推导顺序。 */
public interface FileRecordStore {

    /** 存储可覆盖标识生成方式，但必须与 put 的分配规则一致。 */
    default Serializable generateId() {
        return UUID.randomUUID().toString();
    }

    /** 缺少标识或版本时由存储补齐，版本按同一 executionId 和 filePath 递增。 */
    FileRecord put(@NonNull FileRecord record);

    Optional<FileRecord> get(@NonNull Serializable executionId, @NonNull Serializable recordId);

    void update(@NonNull FileRecord record);

    boolean removeById(@NonNull Serializable executionId, @NonNull Serializable recordId);

    void clearByExecutionId(@NonNull Serializable executionId);

    /** 返回顺序必须保持插入顺序，回滚依赖版本顺序。 */
    List<FileRecord> listByExecution(@NonNull Serializable executionId);

    void clear();

    default List<FileRecord> listPending(@NonNull Serializable executionId) {
        return this.listByExecution(executionId).stream()
                .filter(FileRecord::isPending)
                .toList();
    }

    default List<FileRecord> listPendingByTurn(@NonNull Serializable executionId, @NonNull Serializable turnId) {
        return this.listPending(executionId).stream()
                .filter(r -> Objects.equals(r.turnId(), turnId))
                .toList();
    }

    default List<FileRecord> listByFile(@NonNull Serializable executionId, @NonNull String filePath) {
        return this.listByExecution(executionId).stream()
                .filter(r -> Objects.equals(r.filePath(), filePath))
                .toList();
    }
}
