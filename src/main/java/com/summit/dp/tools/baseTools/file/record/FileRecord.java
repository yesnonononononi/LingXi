package com.summit.dp.tools.baseTools.file.record;

import lombok.Builder;

import java.io.Serializable;
import java.time.Instant;

/**
 * A record of one already-applied file edit, kept so the user can accept it
 * (keep the change, a pure state flip) or reject it (restore the previous
 * content, a real disk write).
 *
 * <p>The record is created AFTER the new content has been written to the
 * workspace; {@link State#PENDING} therefore means "applied, awaiting user
 * decision", never "not yet applied". {@code oldContent == null} marks an edit
 * that created a new file: rejecting it deletes the file.</p>
 */
@Builder
public record FileRecord(
        Serializable id,
        Serializable executionId,
        Serializable turnId,
        Integer version,
        String oldContent,
        String newContent,
        String diff,
        String filePath,
        String oldContentHash,
        String newContentHash,
        State state,
        Instant createAt
) {
    public enum State {
        PENDING, ACCEPTED, REJECTED
    }

    public boolean isPending() {
        return state == State.PENDING;
    }
}
