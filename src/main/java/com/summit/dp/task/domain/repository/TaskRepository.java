package com.summit.dp.task.domain.repository;

import com.summit.dp.task.domain.model.TaskPage;
import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.task.domain.model.Task;

import java.util.Collection;
import java.util.List;

/** 仓储只承载可恢复的任务事实，进程句柄归运行时持有。 */
public interface TaskRepository extends RepositoryTemplate<Task, Long> {

    Collection<Task> findList(Collection<Long> ids);

    TaskPage queryPageBySessionId(int current, int size, long sessionId);
    List<Task> findUnfinished();
    List<Task> findActiveBySessionId(long sessionId);
    List<Task> findByExecutionId(long sessionId, long executionId);
}
