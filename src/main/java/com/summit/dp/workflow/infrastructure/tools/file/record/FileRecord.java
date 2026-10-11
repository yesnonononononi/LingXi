package com.summit.dp.workflow.infrastructure.tools.file.record;

import lombok.Builder;

import java.io.Serializable;
import java.time.Instant;

/** 记录必须晚于文件落盘；PENDING 表示已修改但未决策，oldContent 为空表示新建文件。 */
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
