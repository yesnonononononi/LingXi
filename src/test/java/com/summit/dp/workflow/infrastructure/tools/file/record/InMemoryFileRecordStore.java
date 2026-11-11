package com.summit.dp.workflow.infrastructure.tools.file.record;

import lombok.NonNull;

import java.io.Serializable;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
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

    private final Map<Serializable, List<FileRecord>> records = new ConcurrentHashMap<>();

    @Override
    public FileRecord put(@NonNull FileRecord record) {
        FileRecord stored = this.assignIdentity(record);
        this.records.computeIfAbsent(stored.executionId(), key -> new CopyOnWriteArrayList<>()).add(stored);
        return stored;
    }

    @Override
    public Optional<FileRecord> get(@NonNull Serializable executionId, @NonNull Serializable recordId) {
        List<FileRecord> list = this.records.get(executionId);
        return list == null ? Optional.empty()
                : list.stream().filter(record -> recordId.equals(record.id())).findFirst();
    }

    @Override
    public void clearByExecutionId(@NonNull Serializable executionId) {
        this.records.remove(executionId);
    }

    @Override
    public List<FileRecord> listByExecution(@NonNull Serializable executionId) {
        List<FileRecord> list = this.records.get(executionId);
        return list == null ? List.of() : List.copyOf(list);
    }

    @Override
    public List<FileRecord> listByTurn(@NonNull Serializable executionId, Serializable turnId) {
        return this.records.getOrDefault(executionId, List.of()).stream()
                .filter(record -> Objects.equals(record.turnId(), turnId))
                .toList();
    }

    @Override
    public boolean existsForTurn(@NonNull Serializable executionId, Serializable turnId, @NonNull String filePath) {
        return this.records.getOrDefault(executionId, List.of()).stream()
                .anyMatch(record -> Objects.equals(record.turnId(), turnId)
                        && Objects.equals(record.filePath(), filePath));
    }

    @Override
    public int purgeBefore(@NonNull Instant cutoff) {
        int deleted = 0;
        for (Map.Entry<Serializable, List<FileRecord>> entry : this.records.entrySet()) {
            List<FileRecord> kept = new CopyOnWriteArrayList<>();
            for (FileRecord record : entry.getValue()) {
                if (record.createAt() != null && record.createAt().isBefore(cutoff)) {
                    deleted++;
                } else {
                    kept.add(record);
                }
            }
            this.records.put(entry.getKey(), kept);
        }
        return deleted;
    }

    @Override
    public void clear() {
        this.records.clear();
    }

    /** 补齐标识与同文件版本号；与生产实现同一套规则。 */
    private FileRecord assignIdentity(FileRecord record) {
        Serializable id = record.id() != null ? record.id() : this.generateId();
        int version = this.records.getOrDefault(record.executionId(), List.<FileRecord>of()).stream()
                .filter(existing -> Objects.equals(existing.filePath(), record.filePath()))
                .mapToInt(existing -> existing.version() == null ? 0 : existing.version())
                .max().orElse(0) + 1;
        return FileRecord.builder()
                .id(id).executionId(record.executionId()).turnId(record.turnId())
                .version(version).filePath(record.filePath()).baseline(record.baseline())
                .diff(record.diff()).plusLines(record.plusLines()).minusLines(record.minusLines())
                .createAt(record.createAt())
                .build();
    }
}
