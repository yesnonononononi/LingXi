package com.summit.dp.workflow.infrastructure.tools.file.record;

import com.summit.core.runtime.workspace.Workspace;
import lombok.NonNull;

import java.io.Serializable;
import java.util.List;
import java.util.Optional;

/** 文件先落盘再登记，接受只改记录状态，拒绝才通过原 Workspace 还原文件。 */
public interface FileRecordManager {

    /** 登记必须晚于文件写入，标识和同文件版本由 FileRecordStore 分配。 */
    Serializable record(@NonNull Serializable executionId, @NonNull Serializable turnId,
                        @NonNull FileRecord draft) throws FileModificationException;

    Optional<FileRecord> getRecord(@NonNull Serializable executionId, @NonNull Serializable recordId);

    List<FileRecord> listPendingRecords(@NonNull Serializable executionId);

    /** 已接受记录可重复接受，已回滚记录不能再次接受。 */
    boolean accept(@NonNull Serializable executionId, @NonNull Serializable recordId) throws FileModificationException;

    /** 文件被后续修改时不能回滚，避免覆盖用户的新内容。 */
    boolean reject(@NonNull Serializable executionId, @NonNull Serializable recordId,
                   @NonNull Workspace workspace) throws FileModificationException;

    int acceptTurn(@NonNull Serializable executionId, @NonNull Serializable turnId) throws FileModificationException;

    /** 同文件从最新版本逆序回滚；某条冲突不撤销此前已完成的还原。 */
    int rejectTurn(@NonNull Serializable executionId, @NonNull Serializable turnId,
                   @NonNull Workspace workspace) throws FileModificationException;

    boolean discardRecord(@NonNull Serializable executionId, @NonNull Serializable recordId);

    void discardRecords(@NonNull Serializable executionId);
}
