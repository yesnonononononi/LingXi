package com.summit.dp.workflow.infrastructure.tools.terminal.backend;

import com.summit.dp.task.domain.model.Task;
import com.summit.dp.task.domain.repository.TaskRepository;
import com.summit.dp.workflow.application.input.InputWakeupService;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** 终态和恢复请求同事务保存，避免完成后因派发中断而永久挂起。 */
@Service
@RequiredArgsConstructor
public class BackgroundTaskCompletion {
    private final TaskRepository repository;
    private final InputWakeupService wakeups;

    @Transactional
    public void save(Task task) {
        repository.updateById(task);
        if (task.getStatus().isTerminal() && task.getExecutionId() != null) {
            Runnable check = () -> wakeups.resumeIfInputPending(task.getExecutionId());
            if (TransactionSynchronizationManager.isSynchronizationActive()) {
                TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                    @Override public void afterCommit() { check.run(); }
                });
            } else check.run();
        }
    }
}
