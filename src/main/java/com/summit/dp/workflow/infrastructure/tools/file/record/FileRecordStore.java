package com.summit.dp.workflow.infrastructure.tools.file.record;

import lombok.NonNull;

import java.io.Serializable;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * 记录只追加、不原地改：一条记录描述一次修改，改状态的需求随撤销功能一起移除。
 *
 * <p><b>顺序是契约的一部分</b>：{@link #listByExecution} 必须按写入顺序返回，
 * 差异重放依赖它（基线在前、后续修改依次叠加），所以实现不能返回无序集合。</p>
 */
public interface FileRecordStore {

    /** 存储可覆盖标识生成方式，但必须与 put 的分配规则一致。 */
    default Serializable generateId() {
        return UUID.randomUUID().toString();
    }

    /** 缺少标识或版本时由存储补齐，版本按同一 executionId 和 filePath 递增。 */
    FileRecord put(@NonNull FileRecord record);

    Optional<FileRecord> get(@NonNull Serializable executionId, @NonNull Serializable recordId);

    void clearByExecutionId(@NonNull Serializable executionId);

    /** 返回顺序必须保持插入顺序：差异重放按写入顺序叠加。 */
    List<FileRecord> listByExecution(@NonNull Serializable executionId);

    void clear();
}

