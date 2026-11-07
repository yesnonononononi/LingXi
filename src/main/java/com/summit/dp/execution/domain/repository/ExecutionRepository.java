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
     * 把检查点正文读进内存是不可接受的（正文在文件里，库里只有文件标识）。</p>
     *
     * @param sessionIds 会话 id 集合；空入参由实现短路返回空列表
     */
    List<Execution> findUnfinishedBySessions(Collection<Long> sessionIds);

    /**
     * 读执行归属的会话 id。
     *
     * <p>只取 {@code session_id} 一列：归属判定不该为了一个外键把检查点正文读进内存。
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
     * 「仍活跃」执行所属的会话 id 集合（去重）：状态为 CREATED / RUNNING / SUSPENDED。
     *
     * <p>启动自检的候选来源之一。只用一次单表查询就拿到候选，避免「先遍历根会话、再逐个查会话树」
     * 那种随历史会话数增长的做法。</p>
     *
     * @return 去重后的会话 id；无候选返回空列表
     */
    List<Long> findUnfinishedSessionIds();

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
     * <p><b>不加载检查点正文</b>：正文在文件里（库里只有 {@code snapshot_file} 标识），历史列表一次可能要装
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
     * 不该为了取它把整行（含检查点正文）读进内存。行不存在返回 {@code 0}
     * —— 「没有这条执行」对恢复而言等价于「没有任何未完成的恢复边界」。</p>
     */
    long findResumeGeneration(long executionId);

    /**
     * 批量读「执行 id → 检查点文件标识」，供检查点文件回收判断哪些文件仍被引用。
     *
     * <p>只取 {@code id} 与 {@code snapshot_file} 两列：回收绝不能为了判引用把正文读进内存。
     * 行存在但文件标识为 {@code null} 的，不出现在返回值里（等价于「没有任何正文文件被引用」）。
     * 空入参返回空 Map。</p>
     *
     * @param executionIds 执行 id 集合
     */
    java.util.Map<Long, String> findSnapshotFileIds(java.util.Collection<Long> executionIds);

    /**
     * 读「还有待收口事实」的执行 id（{@code closure_pending = 1}）。
     *
     * <p>只取一列、走 {@code idx_execution_closure_pending}，<b>不 join、不读检查点正文</b> ——
     * 启动补偿要能廉价地找出「终态已提交、业务收口没做完」的行，正文由调用方按 id 再取。</p>
     *
     * @param limit 单批上限；实现内部会夹到有界范围
     * @return 命中的执行 id，按 id 升序
     */
    List<Long> findClosurePendingIds(int limit);

    /**
     * 按游标读一页「还有待收口事实」的执行 id（{@code closure_pending = 1} 且 {@code id > afterId}）。
     *
     * <p><b>为什么需要游标版本</b>：单批 {@code limit} 只能处理最前面的一页，而待办数可能远超一批。
     * 消费方按 {@code id > cursor} 逐页向后翻，才能在同一进程内把整张待办表走完；否则第 N+1 页之后
     * 的项永远等不到处理 —— 进程不重启就不会有「下一次启动」。</p>
     *
     * <p><b>失败项不会挪动游标</b>：游标只按已扫到的最大 id 前进，某条处理失败不影响游标，
     * 它仍留在库里（{@code closure_pending = 1}），下一轮从 0 重新扫时再试一次。</p>
     *
     * @param afterId 游标（不含）；传 0 表示从头开始
     * @param limit   单批上限；实现内部会夹到有界范围
     * @return 命中的执行 id，按 id 升序，最多 {@code limit} 条
     */
    List<Long> findClosurePendingIdsAfter(long afterId, int limit);

    /**
     * 按 id 条件把待收口位从 1 改为 0（只命中仍为 1 的行）。
     *
     * <p>不是业务状态变更，所以不带版本条件；返回值让「漏清」可观测。</p>
     *
     * @param executionId 执行 id
     * @return 是否真的把 1 改成 0
     */
    boolean clearClosurePending(long executionId);

    /**
     * 读该执行是否还有「状态已提交、业务收口没做完」的待办事实。
     *
     * <p><b>为什么通知层需要一个读口</b>：框架在 save/unregister 之后必然发终态事件，业务侧没有
     * 排序权。要判断「这次成功终态能不能发」，唯一权威事实就是这一列 —— 为 1 说明收口脚本没走完，
     * 此刻发「完成」会让界面显示完成而轮次还在进行中。</p>
     *
     * @param executionId 执行 id
     * @return 仍有待收口事实返回 {@code true}；执行行不存在或该列为 0 返回 {@code false}
     */
    boolean isClosurePending(long executionId);
}
