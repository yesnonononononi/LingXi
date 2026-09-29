package com.summit.dp.tools.baseTools.file.record;

import com.summit.dp.tools.baseTools.file.record.FileModificationException;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.dp.tools.baseTools.file.record.FileHasher;
import com.summit.dp.tools.baseTools.file.record.FileRecord;
import com.summit.dp.tools.baseTools.file.record.FileRecordManager;
import com.summit.dp.tools.baseTools.file.record.FileRecordStore;
import lombok.NonNull;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import java.io.Serializable;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;

/**
 * Default {@link FileRecordManager}: applies the business rules (hash-based
 * conflict detection, state transitions) on top of the {@link FileRecordStore}
 * and delegates the physical rollback to {@link FileRecordRestorer}.
 *
 * <p>Identity (id, per-file version) is assigned by the store in
 * {@link FileRecordStore#put}; this class never generates ids and never scans
 * the whole session to derive one. Public methods only orchestrate
 * (load → decide → persist/restore); all rules live in private helpers or
 * {@link FileRecordRestorer}.</p>
 */
@Slf4j
@RequiredArgsConstructor
public class DefaultFileRecordManager implements FileRecordManager {

    private final FileRecordStore store;
    private final FileRecordRestorer restorer;
    private final FileHasher fileHasher;

    @Override
    public Serializable record(@NonNull Serializable executionId, @NonNull Serializable turnId,
                               @NonNull FileRecord draft) throws FileModificationException {
        FileRecord normalized = this.normalize(executionId, turnId, draft);
        FileRecord stored = this.store.put(normalized);
        log.info("Recorded file edit {} (turn {}) on {} [v{}]",
                stored.id(), turnId, stored.filePath(), stored.version());
        return stored.id();
    }

    @Override
    public Optional<FileRecord> getRecord(@NonNull Serializable executionId, @NonNull Serializable recordId) {
        return this.store.get(executionId, recordId);
    }

    @Override
    public List<FileRecord> listPendingRecords(@NonNull Serializable executionId) {
        return this.store.listPending(executionId);
    }

    @Override
    public boolean accept(@NonNull Serializable executionId, @NonNull Serializable recordId)
            throws FileModificationException {
        FileRecord record = this.loadExisting(executionId, recordId);
        FileRecord accepted = this.transition(record, FileRecord.State.ACCEPTED);
        this.store.update(accepted);
        log.info("Accepted file edit {} on {}", recordId, record.filePath());
        return true;
    }

    @Override
    public boolean reject(@NonNull Serializable executionId, @NonNull Serializable recordId, @NonNull Workspace workspace)
            throws FileModificationException {
        FileRecord record = this.loadExisting(executionId, recordId);
        FileRecord rejected = this.rollback(record, workspace);
        this.store.update(rejected);
        log.info("Rejected file edit {} on {}", recordId, record.filePath());
        return true;
    }

    @Override
    public int acceptTurn(@NonNull Serializable executionId, @NonNull Serializable turnId)
            throws FileModificationException {
        int accepted = 0;
        for (FileRecord record : this.pendingOfTurn(executionId, turnId)) {
            this.store.update(this.transition(record, FileRecord.State.ACCEPTED));
            accepted++;
        }
        log.info("Accepted turn {} of execution {}: {} file edits", turnId, executionId, accepted);
        return accepted;
    }

    @Override
    public int rejectTurn(@NonNull Serializable executionId, @NonNull Serializable turnId, @NonNull Workspace workspace)
            throws FileModificationException {
        // Roll back per file from the newest edit to the oldest, so each
        // restore is applied on top of the state the edit actually produced.
        List<FileRecord> pending = this.pendingOfTurn(executionId, turnId).stream()
                .sorted(Comparator.comparing(FileRecord::version).reversed())
                .toList();

        List<String> restored = new ArrayList<>();
        List<String> conflicts = new ArrayList<>();
        for (FileRecord record : pending) {
            try {
                this.restorer.restore(record, workspace);
                this.store.update(this.transition(record, FileRecord.State.REJECTED));
                restored.add(record.filePath());
            } catch (FileModificationException e) {
                conflicts.add(e.getMessage());
            }
        }
        if (!conflicts.isEmpty()) {
            throw new FileModificationException(
                    "rejected " + restored.size() + " file edit(s) of turn " + turnId + ", but "
                            + conflicts.size() + " could not be restored: " + String.join("; ", conflicts));
        }
        log.info("Rejected turn {} of execution {}: {} file edits", turnId, executionId, restored.size());
        return restored.size();
    }

    @Override
    public boolean discardRecord(@NonNull Serializable executionId, @NonNull Serializable recordId) {
        return this.store.removeById(executionId, recordId);
    }

    @Override
    public void discardRecords(@NonNull Serializable executionId) {
        this.store.clearByExecutionId(executionId);
    }

    private FileRecord normalize(Serializable executionId, Serializable turnId, FileRecord draft)
            throws FileModificationException {
        if (draft.filePath() == null || draft.newContent() == null) {
            throw new FileModificationException("file record requires at least filePath and newContent");
        }
        // id and version are assigned by the store on put
        return FileRecord.builder()
                .executionId(executionId)
                .turnId(turnId)
                .oldContent(draft.oldContent())
                .newContent(draft.newContent())
                .diff(draft.diff())
                .filePath(draft.filePath())
                .oldContentHash(draft.oldContent() == null ? null : this.fileHasher.hash(draft.oldContent()))
                .newContentHash(this.fileHasher.hash(draft.newContent()))
                .state(FileRecord.State.PENDING)
                .createAt(Instant.now())
                .build();
    }

    /**
     * Lists all pending records of the given session and turn.
     */
    private List<FileRecord> pendingOfTurn(Serializable executionId, Serializable turnId) {
        return this.store.listPendingByTurn(executionId, turnId);
    }
    /**
     * Loads the record with the given id, or throws a {@link FileModificationException}
     * if no such record exists.
     */

    private FileRecord loadExisting(Serializable executionId, Serializable recordId) {
        return this.store.get(executionId, recordId).orElse(null);
    }
    /**
     * Transitions the given record to the given state, unless the record is already
     * in the target state, in which case it is returned unchanged. If the record is
     * already in the target state, a {@link FileModificationException} is thrown.
     */

    private FileRecord transition(FileRecord record, FileRecord.State target) throws FileModificationException {
        return switch (record.state()) {
            case PENDING -> this.withState(record, target);
            case ACCEPTED -> target == FileRecord.State.ACCEPTED
                    ? record
                    : this.conflict(record, "already accepted");
            case REJECTED -> this.conflict(record, "already rejected");
        };
    }
    /**
     * Restores the given record to its state before the edit was made, and transitions
     * it to the REJECTED state.
     */

    private FileRecord rollback(FileRecord record, Workspace workspace) throws FileModificationException {
        FileRecord rejected = this.transition(record, FileRecord.State.REJECTED);
        this.restorer.restore(record, workspace);
        return rejected;
    }
    /**
     * Creates a new record with the given state, copying all other properties
     * from the given record.
     */

    private FileRecord withState(FileRecord record, FileRecord.State state) {
        return FileRecord.builder()
                .id(record.id()).executionId(record.executionId()).turnId(record.turnId())
                .version(record.version()).oldContent(record.oldContent()).newContent(record.newContent())
                .diff(record.diff()).filePath(record.filePath())
                .oldContentHash(record.oldContentHash()).newContentHash(record.newContentHash())
                .state(state).createAt(record.createAt())
                .build();
    }
    /**
     * Throws a {@link FileModificationException} indicating that the given
     * record is in a conflicting state.
     */

    private FileRecord conflict(FileRecord record, String reason) throws FileModificationException {
        throw new FileModificationException(
                "record " + record.id() + " on " + record.filePath() + " is " + reason);
    }
}
