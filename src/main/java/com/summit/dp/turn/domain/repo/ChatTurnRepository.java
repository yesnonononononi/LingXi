package com.summit.dp.turn.domain.repo;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.turn.domain.model.ChatTurn;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

/** chat_turn 表仓储。 */
public interface ChatTurnRepository extends RepositoryTemplate<ChatTurn, Long> {

    /**
     * 按框架执行 ID 反查轮次。
     *
     * <p>{@code execution_id} 上有唯一键，因此这是一次唯一键查询 —— 也是「框架给的 executionId
     * 反查业务轮次」的唯一入口。框架的观察钩子只给 executionId，业务靠它把信号落到自己的轮次上。</p>
     */
    Optional<ChatTurn> findByExecutionId(Long executionId);

    /**
     * 按一批执行 ID 批量反查轮次（一次 IN 查询，不做 N+1）。
     *
     * <p>历史接口用它把本页消息的 {@code executionId} 映射到 {@code turnId}：
     * 消息行在本次改造里仍只存 {@code execution_id}，轮次身份靠这一次批量映射补上。</p>
     */
    List<ChatTurn> findByExecutionIds(Collection<Long> executionIds);

    /**
     * 按一批轮次 ID 批量取（历史接口一次 IN 装配 {@code turns} 字典）。
     *
     * <p>与 {@link #findByExecutionIds} 的区别只在查询列：读路径已经直接用消息行上的
     * {@code turn_id}，不再需要「执行 ID → 轮次」这一步映射。</p>
     */
    List<ChatTurn> findByIds(Collection<Long> turnIds);

    /**
     * 崩溃收尸：把「没有存活执行」的非终态轮次条件更新为失败终态。
     *
     * <p>与框架的 {@code markOrphanRunsFailed} 同口径：只命中 ACCEPTED / RUNNING
     * （对应框架的 CREATED / RUNNING）。**WAITING 不在条件内** —— 挂起是可恢复状态，
     * 误标失败会让用户再也恢复不了那次执行。</p>
     *
     * @return 被收口的行数
     */
    int markOrphansFailed(Instant completedAt);
}
