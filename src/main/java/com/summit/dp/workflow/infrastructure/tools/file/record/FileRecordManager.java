package com.summit.dp.workflow.infrastructure.tools.file.record;

import lombok.NonNull;

import java.io.Serializable;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

/**
 * 文件修改记录的登记与读取。
 *
 * <p><b>记录正文只追加</b>：一条记录描述一次修改，差异与基线一经登记不再改写。唯一的例外是
 * 回滚标记 {@code rolled_back_at}（{@link #markRolledBack}）—— 它不改变任何差异语义，
 * 只记录「这个文件的末条记录被回填过」，否则重复回滚只能靠内容巧合去猜。</p>
 */
public interface FileRecordManager {

    /**
     * 登记一次修改。写入顺序即修改顺序，差异重放依赖它。
     *
     * <p>{@code turnId} 可以为 {@code null}：轮次来自执行事件元数据，工具在正常链路之外被调用时
     * 拿不到它。<b>这种情况仍要登记</b> —— 丢一条记录就等于丢一段可观测的改动。</p>
     *
     * <p>{@code draft.baseline()} 是「这次改之前该文件的全文」（{@code null} = 文件不存在）。
     * 它只在**分段起点**被保留：本轮首次修改该文件，或上一条记录的末态与它不一致（链被工具外的
     * 修改打断）。其余情况由本方法丢弃，调用方不必自己判断。</p>
     *
     * <p>{@code draft.contentDigest()} 是「改完之后该文件的全文摘要」，登记下一条时靠它判断链
     * 是否还连着。<b>不传就等于下一处编辑必然另起分段</b>，所以调用方有义务给。</p>
     */
    Serializable record(@NonNull Serializable executionId, Serializable turnId,
                        @NonNull FileRecord draft) throws FileModificationException;

    Optional<FileRecord> getRecord(@NonNull Serializable executionId, @NonNull Serializable recordId);

    /**
     * 某轮次的全部记录（各文件混排，保持写入顺序）。
     *
     * <p><b>为什么汇总不走 listRecords</b>：单轮汇总只需要这一轮的行。取整执行再过滤，会把其它
     * 轮次的 diff 与基线一起读进内存 —— 持久化实现下每条基线都是一次文件读，长会话里正是这个
     * 形态把内存吃满。</p>
     */
    List<FileRecord> listTurnRecords(@NonNull Serializable executionId, Serializable turnId);

    /**
     * 该执行下的全部记录（含各轮次各文件），保持写入顺序。
     *
     * <p>整执行视图，不是热路径：任何「只要某一轮」的读取都必须走
     * {@link #listTurnRecords}，否则会把无关轮次的基线一并 hydrate。</p>
     */
    List<FileRecord> listRecords(@NonNull Serializable executionId);

    /**
     * 该执行下每个文件的最早一条记录（回滚基线的唯一入口）。
     *
     * <p>不是热路径：回滚是用户动作，频率与单轮汇总不在一个量级。但实现会按文件逐个读回基线正文
     * —— 那是回填本身需要的，不是额外开销。</p>
     */
    List<FileRecord> earliestPerFile(@NonNull Serializable executionId);

    /**
     * 该执行下这个文件的末态摘要（跨轮次、跨分段）。
     *
     * <p>回滚门禁「执行结束后没人动过这个文件」靠它判定。写成跨轮次查询，是因为门禁关心的是
     * 执行结束后文件长什么样，而不是某一轮的链有没有断。</p>
     */
    Optional<RecordTail> findFileTail(@NonNull Serializable executionId, @NonNull String filePath);

    /**
     * 给这些文件在该执行下的末条记录打回滚标记。
     *
     * <p>成功写盘之后才调用：标记是「已经回填过」的事实，先标后写会让回滚失手变成永久不可回滚。</p>
     *
     * @return 实际标记的记录条数
     */
    int markRolledBack(@NonNull Serializable executionId, @NonNull Collection<String> filePaths,
                       @NonNull Instant at);

    /**
     * 作用域内该文件最新的一条记录（跨轮次差异视图的定位入口）。
     *
     * <p>{@code turnIds} 是调用方按会话范围解析出来的轮次集合；这里只负责「最新」，
     * 不解释作用域，避免把会话树的语义漏进记录层。</p>
     */
    Optional<FileRecord> findLatestRecord(@NonNull String filePath, @NonNull Collection<String> turnIds);
}
