package com.summit.dp.workflow.infrastructure.tools.file.record;

import lombok.NonNull;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

import java.io.Serializable;
import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.Optional;

/**
 * 记录登记：只决定「基线是否保留」，其余交给存储。
 *
 * <p><b>基线只留一份</b>：同一 {@code executionId + turnId + filePath} 的首条记录保留
 * {@code baseline}，后续记录一律置空。这样一轮里改同一文件十次，也不再存十份全文 ——
 * 正是这一点把先前「长会话 OOM」的隐患从根上拿掉了。</p>
 */
@Slf4j
@RequiredArgsConstructor
public class DefaultFileRecordManager implements FileRecordManager {

    private final FileRecordStore store;

    @Override
    public Serializable record(@NonNull Serializable executionId, Serializable turnId,
                               @NonNull FileRecord draft) throws FileModificationException {
        FileRecord normalized = this.normalize(executionId, turnId, draft);
        FileRecord stored = this.store.put(normalized);
        // 日志只放无条件取值：把 `baseline != null` 这类派生布尔塞进日志，会留下永远杀不掉的变异体，
        // 而它对行为毫无影响 —— 变异测试的门禁就没法当门禁用了。
        log.info("登记文件编辑: recordId={}, turnId={}, filePath={}, version={}",
                stored.id(), turnId, stored.filePath(), stored.version());
        return stored.id();
    }

    @Override
    public Optional<FileRecord> getRecord(@NonNull Serializable executionId, @NonNull Serializable recordId) {
        return this.store.get(executionId, recordId);
    }

    @Override
    public List<FileRecord> listRecords(@NonNull Serializable executionId) {
        return this.store.listByExecution(executionId);
    }

    private FileRecord normalize(Serializable executionId, Serializable turnId, FileRecord draft)
            throws FileModificationException {
        if (draft.filePath() == null || draft.diff() == null) {
            throw new FileModificationException("文件编辑记录缺少路径或差异");
        }
        // 标识和版本由存储分配，调用方不能绕过其顺序约束。
        return FileRecord.builder()
                .executionId(executionId)
                .turnId(turnId)
                .filePath(draft.filePath())
                .baseline(this.isFirstOfTurnFile(executionId, turnId, draft.filePath()) ? draft.baseline() : null)
                .diff(draft.diff())
                .plusLines(draft.plusLines())
                .minusLines(draft.minusLines())
                .createAt(Instant.now())
                .build();
    }

    /**
     * 本轮是否还没改过这个文件。
     *
     * <p>线性扫一遍该执行的记录：一次执行内的编辑次数是几十量级，比在存储里再维护一份索引
     * 更省心；真到了需要索引的量级，该改的是存储而不是这里。</p>
     */
    private boolean isFirstOfTurnFile(Serializable executionId, Serializable turnId, String filePath) {
        return this.store.listByExecution(executionId).stream()
                .noneMatch(record -> Objects.equals(record.turnId(), turnId)
                        && Objects.equals(record.filePath(), filePath));
    }
}
