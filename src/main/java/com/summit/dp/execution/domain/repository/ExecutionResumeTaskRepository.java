package com.summit.dp.execution.domain.repository;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.execution.domain.model.ExecutionResumeTask;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * {@code execution_resume_task} 表仓储：恢复请求的唯一写入口。
 *
 * <p><b>写操作全部按 (id, version) 条件更新</b>：领取、作废、状态落库都可能被并发
 * 决策/取消/stop 抢先后，条件更新命中 0 行就说明别人已经改过，本 worker 必须让位。
 * 用整行 {@code updateById} 无条件覆盖会让「stop 已落库 CANCELLED」被迟到的恢复状态改回去。</p>
 */
public interface ExecutionResumeTaskRepository extends RepositoryTemplate<ExecutionResumeTask, Long> {

    @Override
    Optional<ExecutionResumeTask> findById(Long id);

    /** 同一执行同一代际的唯一请求；{@code save} 的幂等判定与重发读取都用它。 */
    Optional<ExecutionResumeTask> findByExecutionAndGeneration(long executionId, long generation);

    List<ExecutionResumeTask> findByExecutionId(long executionId);

    /**
     * 启动收口要处理的遗留请求：状态为 READY 或 CLAIMED（尚未确认结束），按主键升序取一批。
     *
     * <p>进程崩溃时留下的正是这两类：READY 已落库但没派发出去，CLAIMED 派发了没跑完。
     * SUCCEEDED / SUPERSEDED / FAILED 都已收口，不在其中。</p>
     *
     * @param limit 批次上限，防止启动时一次拉全表
     */
    List<ExecutionResumeTask> listUnfinished(int limit);

    /** 某执行下仍处于「未结束」的请求。 */
    List<ExecutionResumeTask> listLiveByExecution(long executionId);

    /**
     * 条件领取：仅当请求仍为 READY、版本未变时置为 CLAIMED。
     *
     * @return 是否真的领取到（{@code false} 表示已被他人领取或已作废，调用方必须让位）
     */
    boolean claim(ExecutionResumeTask task);

    /** 按当前 version 条件写入状态；命中 0 行返回 {@code false}（调用方需按「别人已接管」处理）。 */
    boolean updateState(ExecutionResumeTask task);

    /** 受理一条恢复请求；同执行同代际已有请求时返回既有请求，不新建。 */
    ExecutionResumeTask enqueue(long executionId, long generation, Instant now);

    /** 终态请求回收：把 {@code cutoff} 之前结束的 SUCCEEDED / SUPERSEDED 行删掉，防止表无限增长。 */
    int purgeFinishedBefore(Instant cutoff);
}
