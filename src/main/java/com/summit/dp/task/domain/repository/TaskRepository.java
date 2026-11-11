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

    /**
     * 「可能仍有终态结果待注入」的会话 id 集合（去重）。
     *
     * <p>启动自检的候选来源之三。任务的注入回执存在执行属性里，库上无法区分「已注入」，因此实现用
     * <b>有界推断</b>收窄：注入只发生在「该会话某一轮执行开始之后的模型调用」里，故只有
     * 「在任务完成<b>之后才开始</b>、且<b>正常完成</b>的执行」才视为已注入；在任务完成前就开始的
     * 重叠轮次一律不算（否则会漏唤醒）。调用方请按「可能」语义使用。</p>
     *
     * @return 去重后的会话 id；无候选返回空列表
     */
    List<Long> findSessionIdsWithUnconsumedTerminalTasks();

    /**
     * 按会话批量删除后台任务行（会话删除的级联步骤）。
     *
     * <p>任务行同样是执行行「是否还有业务引用」的判据之一，不一起删被删会话的执行就回收不了。</p>
     *
     * @param sessionIds 会话 id 集合；空入参返回 0
     * @return 删除的行数
     */
    int deleteBySessionIds(Collection<Long> sessionIds);
}
