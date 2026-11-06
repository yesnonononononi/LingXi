package com.summit.dp.task.domain.repository;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.task.domain.model.Task;
import com.summit.dp.task.domain.model.TaskPage;
import com.summit.dp.task.domain.model.TaskSummary;

import java.util.Collection;
import java.util.List;

/** 仓储只承载可恢复的任务事实，进程句柄归运行时持有。 */
public interface TaskRepository extends RepositoryTemplate<Task, Long> {

    Collection<Task> findList(Collection<Long> ids);

    TaskPage queryPageBySessionId(int current, int size, long sessionId);
    List<Task> findUnfinished();
    List<Task> findActiveBySessionId(long sessionId);
    List<Task> findByExecutionId(long sessionId, long executionId);

    /**
     * 列表摘要分页：只选除 {@code output} 外的展示列，按 id 倒序。
     *
     * <p>与 {@link #queryPageBySessionId} 并存而非替换：那个方法可能还有需要 {@code output}
     * 的调用方，改它就是改契约。列表只展示摘要，没理由为它读最长的那个 CLOB。</p>
     */
    List<TaskSummary> queryPageSummaryBySessionId(int current, int size, long sessionId);

    /** 列表摘要：会话内未结束（待执行 / 执行中）的任务，同样不读 {@code output}。 */
    List<TaskSummary> findActiveSummaryBySessionId(long sessionId);
}
