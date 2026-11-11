package com.summit.dp.workflow.infrastructure.tools.file.record;

import lombok.NonNull;

import java.io.Serializable;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

/**
 * 文件修改记录的登记与读取。
 *
 * <p><b>只登记、不回滚</b>：撤销功能整体暂缓（实现留在 {@code backup/edit-undo-20261110} 分支），
 * 这里只保留「记录 + 读出来重建差异」所需的能力。少一条写文件的路径，就少一处能写坏用户文件的地方。</p>
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
     * 作用域内该文件最新的一条记录（跨轮次差异视图的定位入口）。
     *
     * <p>{@code turnIds} 是调用方按会话范围解析出来的轮次集合；这里只负责「最新」，
     * 不解释作用域，避免把会话树的语义漏进记录层。</p>
     */
    Optional<FileRecord> findLatestRecord(@NonNull String filePath, @NonNull Collection<String> turnIds);
}
