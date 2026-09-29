package com.summit.dp.tools.baseTools.file.record;

import lombok.NonNull;

import java.io.Serializable;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;

/**
 * Persistence SPI for {@link FileRecord}s.
 *
 * <p>Implementers only provide the storage primitives ({@link #put}, {@link #get},
 * {@link #update}, {@link #removeById}, {@link #listByExecution}, {@link #clearByExecutionId},
 * {@link #clear}); the business-oriented queries below are {@code default} methods
 * built on {@link #listByExecution} and may be overridden with native queries
 * (indexed SQL, Redis sets, ...) where the in-memory filtering would be wasteful.</p>
 *
 * <p>Identity and ordering are owned by the store, not by callers: {@link #put}
 * assigns the record id via {@link #generateId()} when absent, and assigns the
 * per-file {@code version} when absent. Callers therefore never generate ids
 * themselves.</p>
 */
public interface FileRecordStore {

    /**
     * Generates the id for records stored without one. The default is a random
     * UUID; persistent implementations may override it (auto-increment, Redis
     * INCR, ...) — override {@link #put} accordingly if the backend assigns
     * ids itself.
     */
    default Serializable generateId() {
        return UUID.randomUUID().toString();
    }

    /**
     * Stores the record. When {@code record.id()} is {@code null} an id is
     * generated via {@link #generateId()}; when {@code record.version()} is
     * {@code null} the next per-file version (max version of the same
     * execution + filePath, plus one) is assigned. Returns the stored record
     * carrying its final id/version.
     */
    FileRecord put(@NonNull FileRecord record);

    Optional<FileRecord> get(@NonNull Serializable executionId, @NonNull Serializable recordId);

    /** Replaces the stored record (same execution + id) with the given state/content. */
    void update(@NonNull FileRecord record);

    boolean removeById(@NonNull Serializable executionId, @NonNull Serializable recordId);

    void clearByExecutionId(@NonNull Serializable executionId);

    /** All records of the execution, in insertion order. */
    List<FileRecord> listByExecution(@NonNull Serializable executionId);

    void clear();


    /** All PENDING (applied, undecided) records of the execution. */
    default List<FileRecord> listPending(@NonNull Serializable executionId) {
        return this.listByExecution(executionId).stream()
                .filter(FileRecord::isPending)
                .toList();
    }

    /** All PENDING records of the execution belonging to the given turn. */
    default List<FileRecord> listPendingByTurn(@NonNull Serializable executionId, @NonNull Serializable turnId) {
        return this.listPending(executionId).stream()
                .filter(r -> Objects.equals(r.turnId(), turnId))
                .toList();
    }

    /** All records of the execution for the given file, in insertion order. */
    default List<FileRecord> listByFile(@NonNull Serializable executionId, @NonNull String filePath) {
        return this.listByExecution(executionId).stream()
                .filter(r -> Objects.equals(r.filePath(), filePath))
                .toList();
    }
}
