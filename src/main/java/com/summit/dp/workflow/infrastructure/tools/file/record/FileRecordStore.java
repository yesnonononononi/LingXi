package com.summit.dp.workflow.infrastructure.tools.file.record;

import lombok.NonNull;

import java.io.Serializable;
import java.time.Instant;
import java.util.Collection;
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

    /**
     * 登记一条记录：标识与版本都由存储分配。
     *
     * <p>版本号一律由存储按同一 {@code executionId + filePath} 递增发放，调用方传入的值不参与
     * （唯一索引 {@code ux_file_record_file_version} 就是靠这个前提成立的）。</p>
     */
    FileRecord put(@NonNull FileRecord record);

    Optional<FileRecord> get(@NonNull Serializable executionId, @NonNull Serializable recordId);

    /**
     * 本轮这个文件最后一条记录的位置与末态摘要（决定下一条是接在链上还是另起一段）。
     *
     * <p><b>为什么单独一个方法</b>：登记器每次编辑都要问一次。用 {@link #listByExecution} 再过滤
     * 的写法在持久化实现上会把**每条基线正文都读进内存**，一轮里改十次就是十轮全量读 ——
     * 大文件下正是 OOM 的形态。落库实现只取 {@code id + content_digest} 两列，一条窄查询回答；
     * 内存实现退化成一次线性扫描，两边都不引入额外状态。</p>
     *
     * @return 最后一条记录；本轮还没改过这个文件时为空
     */
    Optional<RecordTail> findTurnFileTail(@NonNull Serializable executionId, Serializable turnId,
                                          @NonNull String filePath);

    /**
     * 回收 {@code cutoff} 之前建立的记录（含基线大文本），返回删除条数。
     *
     * <p>整条回收而不是只删基线：只删基线会留下 {@code baseline} 悬空的记录，读回来变成
     * 「本轮新建文件」，历史差异就会被算成整份新增 —— 静默骗人。</p>
     */
    int purgeBefore(@NonNull Instant cutoff);

    void clearByExecutionId(@NonNull Serializable executionId);

    /** 返回顺序必须保持插入顺序：差异重放按写入顺序叠加。 */
    List<FileRecord> listByExecution(@NonNull Serializable executionId);

    /**
     * 只取某一轮的记录（{@code turnId} 为 {@code null} 时取「无轮次」那一桶），顺序同上。
     *
     * <p>单轮汇总必须走这条窄查询：先用 {@link #listByExecution} 再过滤，会把其它轮次的
     * 基线大文本一起读进内存，长会话下正是 OOM 的形态。</p>
     */
    List<FileRecord> listByTurn(@NonNull Serializable executionId, Serializable turnId);

    /**
     * 取「这些轮次里、这个文件」最新的一条记录。
     *
     * <p>跨轮次差异视图用它定位：作用域（本会话还是整棵会话树）由调用方解析成轮次集合，
     * 存储层只做本表的窄查询 —— 不 join 别的模块的表，也不读其它文件的基线。</p>
     *
     * @param filePath 文件路径，与记录里的 {@code filePath} 等值匹配
     * @param turnIds  作用域内的轮次标识（字符串形态，与 {@code turn_id} 列同形）；空集合直接返回空
     */
    Optional<FileRecord> findLatestRecord(@NonNull String filePath, @NonNull Collection<String> turnIds);

    void clear();
}

