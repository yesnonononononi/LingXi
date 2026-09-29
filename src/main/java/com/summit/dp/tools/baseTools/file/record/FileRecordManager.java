package com.summit.dp.tools.baseTools.file.record;


import com.summit.dp.tools.baseTools.file.record.FileModificationException;
import com.summit.core.runtime.workspace.Workspace;
import lombok.NonNull;

import java.io.Serializable;
import java.util.List;
import java.util.Optional;

/**
 * Business facade over the file-edit decision lifecycle.
 *
 * <p>Edits are applied to the workspace first and recorded afterwards, so the
 * user decides on changes that already exist on disk: {@link #accept} keeps
 * them (a pure state change, no file IO) while {@link #reject} restores the
 * recorded previous content through the given {@link Workspace}'s bridge
 * (a real write). A turn is one agent request; {@code acceptTurn} /
 * {@code rejectTurn} decide on all pending edits of that turn as a batch.</p>
 */
public interface FileRecordManager {

    /**
     * Records an edit that has just been applied to the workspace. The draft
     * carries at least {@code filePath}, {@code oldContent}, {@code newContent}
     * and {@code diff}; execution/turn binding, the content hashes and the
     * {@link FileRecord.State#PENDING} state are filled in by the
     * implementation, while id and per-file version are assigned by the
     * {@link FileRecordStore} on {@code put}.
     *
     * @param executionId execution id
     * @param turnId    id of the agent request this edit belongs to
     * @param draft     the not-yet-normalized record
     * @return the record id assigned by the store
     * @throws FileModificationException if the draft is not usable
     */
    Serializable record(@NonNull Serializable executionId, @NonNull Serializable turnId,
                        @NonNull FileRecord draft) throws FileModificationException;

    Optional<FileRecord> getRecord(@NonNull Serializable executionId, @NonNull Serializable recordId);

    /** All PENDING (applied, undecided) records of the execution, in creation order. */
    List<FileRecord> listPendingRecords(@NonNull Serializable executionId);

    /**
     * Keeps an applied edit. Idempotent for already-accepted records; rejects
     * the operation for records already rolled back.
     *
     * @return {@code false} when the record does not exist
     */
    boolean accept(@NonNull Serializable executionId, @NonNull Serializable recordId) throws FileModificationException;

    /**
     * Rolls an applied edit back: restores the recorded previous content (or
     * deletes a file the edit created) through the workspace bridge. Fails
     * when the file's current content no longer matches the hash recorded at
     * edit time.
     *
     * @return {@code false} when the record does not exist
     */
    boolean reject(@NonNull Serializable executionId, @NonNull Serializable recordId,
                   @NonNull Workspace workspace) throws FileModificationException;

    /**
     * Keeps every pending edit of the turn.
     *
     * @return the number of records accepted
     */
    int acceptTurn(@NonNull Serializable executionId, @NonNull Serializable turnId) throws FileModificationException;

    /**
     * Rolls every pending edit of the turn back, highest per-file version
     * first so earlier edits are restored on top of the final state. If any
     * file fails the hash check an exception is thrown listing it; files
     * restored before that point stay restored.
     *
     * @return the number of records rolled back
     */
    int rejectTurn(@NonNull Serializable executionId, @NonNull Serializable turnId,
                   @NonNull Workspace workspace) throws FileModificationException;

    /** Removes a single record from the journal without touching any file. */
    boolean discardRecord(@NonNull Serializable executionId, @NonNull Serializable recordId);

    /** Removes all records of the execution without touching any file. */
    void discardRecords(@NonNull Serializable executionId);
}
