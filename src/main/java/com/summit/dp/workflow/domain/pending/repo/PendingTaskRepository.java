package com.summit.dp.workflow.domain.pending.repo;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.workflow.domain.pending.model.PendingTask;

import java.util.List;
import java.util.Optional;

/**
 * 待发送任务仓储。
 *
 * <p>所有查询都是「按会话 + 顺序」，没有全表扫描入口：队列天然是会话私有的。</p>
 */
public interface PendingTaskRepository extends RepositoryTemplate<PendingTask, Long> {

    /** 该会话按入队顺序排列的全部任务（快照展示用）。 */
    List<PendingTask> findBySession(long sessionId);

    /** 可以自动派发的最早一条（status = PENDING）。 */
    Optional<PendingTask> findEarliestDispatchable(long sessionId);

    /** 该会话是否有待发送任务（{@code PendingInputProbe} 的判据）。 */
    boolean existsBySession(long sessionId);

    /** 该会话的任务条数（入队限额用）。 */
    int countBySession(long sessionId);

    /** 全表任务条数：进程级上限用它，避免某个会话之外的地方无限堆积。 */
    int countAll();

    /** 有可派发任务的会话（兜底扫描用）。 */
    List<Long> findDispatchableSessions();

    /** 启动时把上次进程遗留的 PENDING 全部标成待确认，返回受影响行数。 */
    int markLegacyAwaitingConfirm();

    /** 会话删除时清空该会话的任务。 */
    int deleteBySession(long sessionId);

    /**
     * 整笔覆盖「可编辑列」：正文、附件、模型、执行体、计划模式、状态、失败原因、更新时间。
     *
     * <p>不能用通用的 `updateById`：它的空值策略是「非 null 才写」，于是「把模型清回默认」
     * （`model_id = null`）永远不会落库，用户看到的是「改了但没变」。这里用显式 set 覆盖。</p>
     */
    void updateEditable(PendingTask task);
}
