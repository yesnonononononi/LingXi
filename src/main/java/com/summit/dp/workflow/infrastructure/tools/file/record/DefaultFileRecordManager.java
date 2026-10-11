package com.summit.dp.workflow.infrastructure.tools.file.record;

import com.summit.core.runtime.workspace.Workspace;
import lombok.NonNull;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import java.io.Serializable;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;

/** 标识和版本由存储分配，拒绝前先检查冲突再执行物理还原。 */
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
        log.info("登记文件编辑: recordId={}, turnId={}, filePath={}, version={}",
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
        log.info("接受文件编辑: recordId={}, filePath={}", recordId, record.filePath());
        return true;
    }

    @Override
    public boolean reject(@NonNull Serializable executionId, @NonNull Serializable recordId, @NonNull Workspace workspace)
            throws FileModificationException {
        FileRecord record = this.loadExisting(executionId, recordId);
        FileRecord rejected = this.rollback(record, workspace);
        this.store.update(rejected);
        log.info("回滚文件编辑: recordId={}, filePath={}", recordId, record.filePath());
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
        log.info("接受轮次文件编辑: turnId={}, executionId={}, count={}", turnId, executionId, accepted);
        return accepted;
    }

    @Override
    public int rejectTurn(@NonNull Serializable executionId, @NonNull Serializable turnId, @NonNull Workspace workspace)
            throws FileModificationException {
        // 同文件必须逆序还原，下一条记录才能匹配前一次编辑留下的内容。
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
        log.info("回滚轮次文件编辑: turnId={}, executionId={}, count={}", turnId, executionId, restored.size());
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
            throw new FileModificationException("文件编辑记录缺少路径或新内容");
        }
        // 标识和版本由存储分配，调用方不能绕过其顺序约束。
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

    private List<FileRecord> pendingOfTurn(Serializable executionId, Serializable turnId) {
        return this.store.listPendingByTurn(executionId, turnId);
    }

    private FileRecord loadExisting(Serializable executionId, Serializable recordId) {
        return this.store.get(executionId, recordId).orElse(null);
    }

    private FileRecord transition(FileRecord record, FileRecord.State target) throws FileModificationException {
        return switch (record.state()) {
            case PENDING -> this.withState(record, target);
            case ACCEPTED -> target == FileRecord.State.ACCEPTED
                    ? record
                    : this.conflict(record, "already accepted");
            case REJECTED -> this.conflict(record, "already rejected");
        };
    }

    private FileRecord rollback(FileRecord record, Workspace workspace) throws FileModificationException {
        FileRecord rejected = this.transition(record, FileRecord.State.REJECTED);
        this.restorer.restore(record, workspace);
        return rejected;
    }

    private FileRecord withState(FileRecord record, FileRecord.State state) {
        return FileRecord.builder()
                .id(record.id()).executionId(record.executionId()).turnId(record.turnId())
                .version(record.version()).oldContent(record.oldContent()).newContent(record.newContent())
                .diff(record.diff()).filePath(record.filePath())
                .oldContentHash(record.oldContentHash()).newContentHash(record.newContentHash())
                .state(state).createAt(record.createAt())
                .build();
    }

    private FileRecord conflict(FileRecord record, String reason) throws FileModificationException {
        throw new FileModificationException(
                "record " + record.id() + " on " + record.filePath() + " is " + reason);
    }
}
