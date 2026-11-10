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

    /**
     * 本轮是否已经为这个文件登记过记录（决定基线还要不要留）。
     *
     * <p><b>为什么单独一个方法</b>：登记器每次编辑都要问一次这个问题。用
     * {@link #listByExecution} 再过滤的写法在持久化实现上会把**每条基线正文都读进内存**，
     * 一轮里改十次就是十轮全量读 —— 大文件下正是 OOM 的形态。落库实现用一条计数查询回答，
     * 内存实现退化成一次线性比较，两边都不引入额外状态。</p>
     */
    boolean existsForTurn(@NonNull Serializable executionId, Serializable turnId, @NonNull String filePath);

    /**
     * 回收 {@code cutoff} 之前建立的记录（含基线大文本），返回删除条数。
     *
     * <p>整条回收而不是只删基线：只删基线会留下 {@code baseline} 悬空的记录，读回来变成
     * 「本轮新建文件」，历史差异就会被算成整份新增 —— 静默骗人。记录本身过期后也没人再看。</p>
     */
    int purgeBefore(@NonNull java.time.Instant cutoff);

    void clearByExecutionId(@NonNull Serializable executionId);

    /** 返回顺序必须保持插入顺序：差异重放按写入顺序叠加。 */
    List<FileRecord> listByExecution(@NonNull Serializable executionId);

    void clear();
}

