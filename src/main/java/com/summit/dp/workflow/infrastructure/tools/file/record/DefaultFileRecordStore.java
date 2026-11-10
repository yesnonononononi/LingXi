package com.summit.dp.workflow.infrastructure.tools.file.record;

import lombok.NonNull;

import java.io.Serializable;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * 内存存储：只追加，按执行分区。
 *
 * <p><b>顺序是契约</b>：差异重放按写入顺序叠加，所以用 {@link CopyOnWriteArrayList}
 * 保持插入顺序，且不提供任何重排手段。</p>
 *
 * <p><b>已知边界</b>：进程重启即丢，历史会话的改动清单因此重建不出来。落库是下一步的事，
 * 这里不做半个持久化 —— 那只会让「有时有、有时没有」更难排查。</p>
 */
public class DefaultFileRecordStore implements FileRecordStore {

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
    public void clear() {
        this.records.clear();
    }

    /** 补齐标识与同文件版本号；顺序语义由此确定，调用方不能自己造。 */
    private FileRecord assignIdentity(FileRecord record) {
        if (record.id() != null && record.version() != null) {
            return record;
        }
        Serializable id = record.id() != null ? record.id() : this.generateId();
        Integer version = record.version();
        if (version == null) {
            version = this.records.getOrDefault(record.executionId(), List.<FileRecord>of()).stream()
                    .filter(existing -> Objects.equals(existing.filePath(), record.filePath()))
                    .mapToInt(existing -> existing.version() == null ? 0 : existing.version())
                    .max().orElse(0) + 1;
        }
        return FileRecord.builder()
                .id(id).executionId(record.executionId()).turnId(record.turnId())
                .version(version).filePath(record.filePath()).baseline(record.baseline())
                .diff(record.diff()).plusLines(record.plusLines()).minusLines(record.minusLines())
                .createAt(record.createAt())
                .build();
    }
}
