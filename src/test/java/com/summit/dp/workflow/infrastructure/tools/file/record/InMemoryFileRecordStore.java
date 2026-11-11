package com.summit.dp.workflow.infrastructure.tools.file.record;

import lombok.NonNull;

import java.io.Serializable;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * 测试用内存存储（生产实现是 {@link H2FileRecordStore}）。
 *
 * <p>只服务「不该为持久化付出代价」的用例：编辑编码、行尾、契约回归、汇总服务等，
 * 它们关心的是记录语义而不是存放地点。基线在这里是字符串，不产生任何磁盘副作用。<b>顺序</b>
 * 语义与生产一致：插入顺序即重放顺序，且存在性判定与过期回收的行为也保持一致，
 * 避免测试跑在与生产不同的语义上。</p>
 */
public class InMemoryFileRecordStore implements FileRecordStore {

    /** 单一真源：全局插入顺序就是生产实现里的 {@code seq}，跨执行的「最新」判定也靠它。 */
    private final List<FileRecord> insertionOrder = new CopyOnWriteArrayList<>();

    @Override
    public FileRecord put(@NonNull FileRecord record) {
        FileRecord stored = this.assignIdentity(record);
        this.insertionOrder.add(stored);
        return stored;
    }

    @Override
    public Optional<FileRecord> get(@NonNull Serializable executionId, @NonNull Serializable recordId) {
        return this.insertionOrder.stream()
                .filter(record -> executionId.equals(record.executionId()) && recordId.equals(record.id()))
                .findFirst();
    }

    @Override
    public void clearByExecutionId(@NonNull Serializable executionId) {
        this.insertionOrder.removeIf(record -> executionId.equals(record.executionId()));
    }

    @Override
    public List<FileRecord> listByExecution(@NonNull Serializable executionId) {
        return this.insertionOrder.stream()
                .filter(record -> executionId.equals(record.executionId()))
                .toList();
    }

    @Override
    public List<FileRecord> listByTurn(@NonNull Serializable executionId, Serializable turnId) {
        return this.insertionOrder.stream()
                .filter(record -> executionId.equals(record.executionId()))
                .filter(record -> Objects.equals(record.turnId(), turnId))
                .toList();
    }

    /** 倒着扫就是「最新优先」：与生产实现 {@code ORDER BY seq DESC} 同一口径。 */
    @Override
    public Optional<FileRecord> findLatestRecord(@NonNull String filePath, @NonNull Collection<String> turnIds) {
        FileRecord latest = null;
        for (FileRecord record : this.insertionOrder) {
            if (!Objects.equals(record.filePath(), filePath) || record.turnId() == null
                    || !turnIds.contains(String.valueOf(record.turnId()))) {
                continue;
            }
            latest = record;
        }
        return Optional.ofNullable(latest);
    }

    @Override
    public boolean existsForTurn(@NonNull Serializable executionId, Serializable turnId, @NonNull String filePath) {
        return this.insertionOrder.stream()
                .filter(record -> executionId.equals(record.executionId()))
                .anyMatch(record -> Objects.equals(record.turnId(), turnId)
                        && Objects.equals(record.filePath(), filePath));
    }

    @Override
    public int purgeBefore(@NonNull Instant cutoff) {
        List<FileRecord> expired = this.insertionOrder.stream()
                .filter(record -> record.createAt() != null && record.createAt().isBefore(cutoff))
                .toList();
        this.insertionOrder.removeAll(expired);
        return expired.size();
    }

    @Override
    public void clear() {
        this.insertionOrder.clear();
    }

    /** 补齐标识与同文件版本号；与生产实现同一套规则（版本按执行 + 文件递增）。 */
    private FileRecord assignIdentity(FileRecord record) {
        Serializable id = record.id() != null ? record.id() : this.generateId();
        int version = this.insertionOrder.stream()
                .filter(existing -> Objects.equals(existing.executionId(), record.executionId())
                        && Objects.equals(existing.filePath(), record.filePath()))
                .mapToInt(existing -> existing.version() == null ? 0 : existing.version())
                .max().orElse(0) + 1;
        return FileRecord.builder()
                .id(id).executionId(record.executionId()).turnId(record.turnId())
                .version(version).filePath(record.filePath()).baseline(record.baseline())
                .diff(record.diff()).plusLines(record.plusLines()).minusLines(record.minusLines())
                .createAt(record.createAt())
                // 缺失标记原样保留：测试靠它造出「基线被回收」的记录，否则这条路径没法覆盖。
                .baselineMissing(record.baselineMissing())
                .build();
    }
}
