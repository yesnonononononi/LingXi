package com.summit.dp.execution.domain.repository;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.execution.domain.model.ExecutionResumeTask;
import com.summit.dp.execution.domain.model.ResumeTaskState;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * {@code execution_resume_task} 表仓储：恢复意图的唯一写入口。
 *
 * <p><b>写操作全部按 (id, version) 条件更新</b>：领取、作废、状态落库都可能被并发
 * 决策/取消/stop 抢先后，条件更新命中 0 行就说明别人已经改过，本 worker 必须让位。
 * 用整行 {@code updateById} 无条件覆盖会让「stop 已落库 CANCELLED」被迟到的恢复状态改回去。</p>
 */
public interface ExecutionResumeTaskRepository extends RepositoryTemplate<ExecutionResumeTask, Long> {

    @Override
    Optional<ExecutionResumeTask> findById(Long id);

    /** 同一执行同一代际的唯一任务；{@code save} 的幂等判定与重发读取都用它。 */
    Optional<ExecutionResumeTask> findByExecutionAndGeneration(long executionId, long generation);

    List<ExecutionResumeTask> findByExecutionId(long executionId);

    /** 某执行当前仍可派发的任务（READY 或到点的 FAILED），按创建时间升序。 */
    List<ExecutionResumeTask> listDispatchable(Instant now, int limit);

    /**
     * 遗留 CLAIMED 任务（进程崩溃时被领走、未确认结束），按主键升序取一批。
     *
     * <p><b>为什么要单独一个方法</b>：{@code listDispatchable} 的状态条件是
     * {@code state IN (READY, FAILED)}，CLAIMED 永远查不出来；启动分流必须能看见它们。</p>
     *
     * @param limit 批次上限，防止启动时一次拉全表
     */
    List<ExecutionResumeTask> listClaimed(int limit);

    /** 某执行指定代际下仍处于「未结束」的任务；用于恢复协调器作废同代际的旧任务。 */
    List<ExecutionResumeTask> listLiveByExecution(long executionId);

    /**
     * 条件领取：仅当任务仍处于给定状态、版本未变、且退避时刻已到时置为 CLAIMED。
     *
     * @return 是否真的领取到（{@code false} 表示已被他人领取或已作废，调用方必须让位）
     */
    boolean claim(ExecutionResumeTask task, Instant now);

    /** 按当前 version 条件写入状态；命中 0 行返回 {@code false}（调用方需按「别人已接管」处理）。 */
    boolean updateState(ExecutionResumeTask task);

    /** 受理一条恢复意图；同执行同代际已有任务时返回既有任务，不新建。 */
    ExecutionResumeTask enqueue(long executionId, long generation, Instant now);

    /** 终态任务回收：把 {@code cutoff} 之前结束的 SUCCEEDED / SUPERSEDED 行删掉，防止表无限增长。 */
    int purgeFinishedBefore(Instant cutoff);
}
