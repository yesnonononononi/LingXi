package com.summit.dp.workflow.infrastructure.tools.file.record;

import org.jspecify.annotations.NonNull;

import java.io.Serializable;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

/** 原位更新必须保留插入顺序，拒绝回滚依赖同文件版本的稳定顺序。 */
public class DefaultFileRecordStore implements FileRecordStore {
    private final Map<Serializable, List<FileRecord>> records = new ConcurrentHashMap<>();

    @Override
    public FileRecord put(@NonNull FileRecord record) {
        FileRecord stored = this.assignIdentity(record);
        this.records.computeIfAbsent(stored.executionId(), k -> new CopyOnWriteArrayList<>()).add(stored);
        return stored;
    }

    @Override
    public Optional<FileRecord> get(@NonNull Serializable executionId, @NonNull Serializable recordId) {
        List<FileRecord> list = this.records.get(executionId);
        return list == null ? Optional.empty()
                : list.stream().filter(r -> recordId.equals(r.id())).findFirst();
    }

    @Override
    public void update(@NonNull FileRecord record) {
        List<FileRecord> list = this.records.get(record.executionId());
        if (list == null) return;
        for (int i = 0; i < list.size(); i++) {
            if (record.id().equals(list.get(i).id())) {
                list.set(i, record);
                return;
            }
        }
    }

    @Override
    public boolean removeById(@NonNull Serializable executionId, @NonNull Serializable recordId) {
        List<FileRecord> list = this.records.get(executionId);
        return list != null && list.removeIf(r -> recordId.equals(r.id()));
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

    private FileRecord assignIdentity(FileRecord record) {
        Serializable id = record.id() != null ? record.id() : this.generateId();
        Integer version = record.version();
        if (version == null) {
            version = this.records.getOrDefault(record.executionId(), List.<FileRecord>of()).stream()
                    .filter(r -> Objects.equals(r.filePath(), record.filePath()))
                    .mapToInt(r -> r.version() == null ? 0 : r.version())
                    .max().orElse(0) + 1;
        }
        if (record.id() != null && version.equals(record.version())) {
            return record;
        }
        return this.withIdentity(record, id, version);
    }

    private FileRecord withIdentity(FileRecord record, Serializable id, Integer version) {
        return FileRecord.builder()
                .id(id).executionId(record.executionId()).turnId(record.turnId())
                .version(version).oldContent(record.oldContent()).newContent(record.newContent())
                .diff(record.diff()).filePath(record.filePath())
                .oldContentHash(record.oldContentHash()).newContentHash(record.newContentHash())
                .state(record.state()).createAt(record.createAt())
                .build();
    }
}
