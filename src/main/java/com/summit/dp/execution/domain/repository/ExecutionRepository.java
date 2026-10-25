package com.summit.dp.execution.domain.repository;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.execution.domain.model.Execution;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

public interface ExecutionRepository extends RepositoryTemplate<Execution, Long> {
    /** 有效历史与其他模块仍引用的执行必须保留，清理不能改变重发或恢复能力。 */
    long countReclaimable();

    /** 只读取身份与版本，避免清理过程把大快照装进内存。 */
    List<Execution> findReclaimable(long afterId, int limit);

    /** 删除时重新验证引用和版本，不能信任预览或此前取到的候选。 */
    boolean deleteReclaimable(long executionId, long version);

    /** 保存前只读并发判据，避免再次加载完整快照。 */
    Optional<Execution> findCheckpointSummary(long executionId);
    Collection<Execution> findList(Collection<Long> ids);
    List<Execution> findRecentBySession(Long sessionId, int limit);

    /**
     * 批量取会话下未终结（CREATED / RUNNING / SUSPENDED）的执行投影。
     *
     * <p>一次 {@code IN} 查询，不逐会话查；不加载 snapshot —— 调用方只判「还有没有在跑的」，
     * 把 LONGTEXT 检查点读进内存是不可接受的。</p>
     *
     * @param sessionIds 会话 id 集合；空入参由实现短路返回空列表
     */
    List<Execution> findUnfinishedBySessions(Collection<Long> sessionIds);

    /**
     * 读执行归属的会话 id。
     *
     * <p>只取 {@code session_id} 一列：归属判定不该为了一个外键把 LONGTEXT 检查点读进内存。
     * 行不存在、或行上没写会话，都返回空。</p>
     */
    Optional<Long> findSessionId(long executionId);

    /** 会话下最近一次被暂停（SUSPENDED）的执行 id；没有挂起执行返回空。 */
    Optional<Long> findLatestSuspendedId(long sessionId);

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
