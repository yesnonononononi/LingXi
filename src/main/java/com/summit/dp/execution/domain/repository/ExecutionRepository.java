package com.summit.dp.execution.domain.repository;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.execution.domain.model.Execution;
import java.time.LocalDateTime;
import java.util.Collection;
import java.util.List;

public interface ExecutionRepository extends RepositoryTemplate<Execution, Long> {
    Collection<Execution> findList(Collection<Long> ids);
    List<Execution> findRecentBySession(Long sessionId, int limit);

    /**
     * 收口孤儿执行：把进程崩溃后遗留的 CREATED / RUNNING 执行条件更新为 FAILED 终态。
     *
     * <p>条件更新（仅命中 CREATED / RUNNING），SUSPENDED 与已终态行不受影响，重复调用幂等。
     * 供启动收尸钩子调用。</p>
     *
     * @return 被收口的行数
     */
    int markOrphanRunsFailed();

    /**
     * 收口「尚未终结就被中断」的单个执行：把 CREATED / RUNNING 条件更新为失败终态并写结束时间。
     *
     * <p>用于启动失败路径（编排器在框架 loop 起来之前抛异常）。条件更新是安全边界：
     * 已 COMPLETED 的执行不会被改写，SUSPENDED 也不在条件内（挂起可恢复，误标失败会让
     * 「待恢复」入口消失）。行不存在或已终态时返回 0，幂等。</p>
     *
     * @param executionId 执行 id
     * @param completedAt 结束时间（失败终态时间）
     * @return 被收口的行数
     */
    int markFailedIfUnfinished(long executionId, LocalDateTime completedAt);

    /**
     * 批量取每个会话、每种状态下 id 最大的执行，按 sessionId 升序、id 降序返回。
     *
     * <p>仅加载 id/sessionId/status/createdAt，供只读状态查询使用；snapshot 与 updatedAt
     * 未加载，返回对象不得直接用于回写。空入参返回空列表。</p>
     *
     * @param sessionIds 会话 id 集合
     */
    List<Execution> findLatestBySessionAndStatus(Collection<Long> sessionIds);

    /**
     * 按执行 id 批量取「查询摘要」投影：模型快照、token 累计、开始/结束时间、根执行归属。
     *
     * <p><b>不加载 snapshot</b>：snapshot 是 LONGTEXT 的执行恢复检查点，历史列表一次可能要装
     * 几十个执行，把检查点全读进内存只为展示几个数字是不可接受的。恢复路径仍然走
     * {@code findById}。</p>
     *
     * <p>返回对象是投影，未加载 snapshot / createdAt / updatedAt，**不得直接用于回写**。
     * 空入参返回空列表。token 三列为 null 表示未采集到，与 0（确实为 0）区分。</p>
     *
     * @param executionIds 执行 id 集合
     */
    List<Execution> findSummariesByIds(Collection<Long> executionIds);
}
