package com.summit.dp.execution.domain.repository;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.execution.domain.model.Execution;
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
     * 批量取每个会话、每种状态下 id 最大的执行，按 sessionId 升序、id 降序返回。
     *
     * <p>仅加载 id/sessionId/status/createdAt，供只读状态查询使用；snapshot 与 updatedAt
     * 未加载，返回对象不得直接用于回写。空入参返回空列表。</p>
     *
     * @param sessionIds 会话 id 集合
     */
    List<Execution> findLatestBySessionAndStatus(Collection<Long> sessionIds);
}
