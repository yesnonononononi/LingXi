package com.summit.dp.workflow.infrastructure.tools.file.record;

import lombok.NonNull;

import java.io.Serializable;
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
     * <p>{@code draft.baseline()} 只有在「本轮首次修改该文件」时才会被保留，其余情况由本方法丢弃，
     * 调用方不必自己判断是不是首条。</p>
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
}
