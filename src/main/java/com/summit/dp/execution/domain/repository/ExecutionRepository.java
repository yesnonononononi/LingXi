package com.summit.dp.execution.domain.repository;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.execution.domain.model.Execution;
import java.util.Collection;
import java.util.List;

public interface ExecutionRepository extends RepositoryTemplate<Execution, Long> {
    Collection<Execution> findList(Collection<Long> ids);
    List<Execution> findRecentBySession(Long sessionId, int limit);
    default List<Execution> findUnfinishedBySessions(Collection<Long> sessionIds) {
        return sessionIds.stream().flatMap(id -> findRecentBySession(id, 100).stream())
                .filter(execution -> execution.getStatus() != null && execution.getStatus() < 3).toList();
    }

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

    /**
     * 读执行的恢复代际。
     *
     * <p>恢复协调器判断任务是否过期、reaper 判断能否重新派发都只关心这一个数，
     * 不该为了取它把整行（含 LONGTEXT 检查点）读进内存。行不存在返回 {@code 0}
     * —— 「没有这条执行」对恢复而言等价于「没有任何未完成的恢复边界」。</p>
     */
    long findResumeGeneration(long executionId);
}
