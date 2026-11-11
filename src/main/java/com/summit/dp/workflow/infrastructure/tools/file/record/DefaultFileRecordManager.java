package com.summit.dp.workflow.infrastructure.tools.file.record;

import lombok.NonNull;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

import java.io.Serializable;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

/**
 * 记录登记：只决定「基线是否保留」，其余交给存储。
 *
 * <p><b>基线只在分段起点保留</b>：同一 {@code executionId + turnId + filePath} 的改动本是一条
 * 「基线 + 逐条 diff」的链，正常情况下一轮里改同一文件十次也只留一份全文 —— 正是这一点把先前
 * 「长会话 OOM」的隐患从根上拿掉了。</p>
 *
 * <p><b>但链会被打断</b>：只有 {@code edit_file} 会登记记录，用 shell / python 直写、
 * 或者 {@code del} 掉重建都不留痕。那时链上少一段，后续 diff 的上下文对不上，整份差异就
 * 再也重建不出来。所以每次登记都拿「上一条记录的末态摘要」和「本次改之前的摘要」比一次：
 * 对不上就把这条当成新的分段起点、重新保留基线。代价只是一段历史不连续，
 * 而不是把可观测性全丢掉。</p>
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
    public List<FileRecord> listTurnRecords(@NonNull Serializable executionId, Serializable turnId) {
        return this.store.listByTurn(executionId, turnId);
    }

    @Override
    public List<FileRecord> listRecords(@NonNull Serializable executionId) {
        return this.store.listByExecution(executionId);
    }

    @Override
    public Optional<FileRecord> findLatestRecord(@NonNull String filePath, @NonNull Collection<String> turnIds) {
        return this.store.findLatestRecord(filePath, turnIds);
    }

    private FileRecord normalize(Serializable executionId, Serializable turnId, FileRecord draft)
            throws FileModificationException {
        if (draft.filePath() == null || draft.diff() == null) {
            throw new FileModificationException("文件编辑记录缺少路径或差异");
        }
        // 「改之前是什么」由调用方如实给出（null = 文件不存在），摘要据此算出链上应有的前一段末态。
        String sourceDigest = ContentDigest.compute(draft.baseline());
        Optional<RecordTail> tail = this.store.findTurnFileTail(executionId, turnId, draft.filePath());
        boolean segmentStart = this.startsNewSegment(draft, tail, sourceDigest);
        // 标识和版本由存储分配，调用方不能绕过其顺序约束。
        return FileRecord.builder()
                .executionId(executionId)
                .turnId(turnId)
                .filePath(draft.filePath())
                .baseline(segmentStart ? draft.baseline() : null)
                .diff(draft.diff())
                .plusLines(draft.plusLines())
                .minusLines(draft.minusLines())
                .contentDigest(draft.contentDigest())
                .segmentStart(segmentStart)
                .createAt(Instant.now())
                .build();
    }

    /**
     * 这条是不是新分段的起点：本轮首次改这个文件，或者上一次的末态与本次改之前的内容对不上。
     *
     * <p>老记录没有 {@code contentDigest}（V16 之前落库的），链不可验证，一律当作已断 ——
     * 多留一份基线是安全的；猜「还连着」会让升级后的第一次编辑把整份差异弄丢。</p>
     */
    private boolean startsNewSegment(FileRecord draft, Optional<RecordTail> tail, String sourceDigest) {
        if (tail.isEmpty()) {
            return true;
        }
        RecordTail previous = tail.get();
        if (previous.contentDigest() == null) {
            log.warn("编辑链不可验证，另起分段: recordId={}, filePath={}, reason=上一条记录没有内容摘要",
                    previous.id(), draft.filePath());
            return true;
        }
        if (previous.contentDigest().equals(sourceDigest)) {
            return false;
        }
        log.warn("编辑链断裂，另起分段: recordId={}, filePath={}, reason=上一条记录的末态与本次改之前的内容不一致"
                + "（多半是绕过 edit_file 的修改）", previous.id(), draft.filePath());
        return true;
    }
}
