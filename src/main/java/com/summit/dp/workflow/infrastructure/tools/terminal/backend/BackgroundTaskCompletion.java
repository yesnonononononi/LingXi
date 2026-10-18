package com.summit.dp.workflow.infrastructure.tools.terminal.backend;

import com.summit.dp.task.domain.model.Task;
import com.summit.dp.task.domain.repository.TaskRepository;
import com.summit.dp.workflow.application.resume.ExecutionResumeCoordinator;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** 终态和恢复请求同事务保存，避免完成后因派发中断而永久挂起。 */
@Service
@RequiredArgsConstructor
public class BackgroundTaskCompletion {
    private final TaskRepository repository;
    private final ExecutionResumeCoordinator resumeCoordinator;

    @Transactional
    public void save(Task task) {
        repository.updateById(task);
        if (task.getStatus().isTerminal() && task.getExecutionId() != null) {
            resumeCoordinator.accept(task.getExecutionId());
        }
    }
}
