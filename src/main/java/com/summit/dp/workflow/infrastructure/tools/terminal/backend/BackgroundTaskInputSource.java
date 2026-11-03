package com.summit.dp.workflow.infrastructure.tools.terminal.backend;

import com.summit.core.agent.Execution;
import com.summit.dp.task.domain.model.Task;
import com.summit.dp.task.domain.repository.TaskRepository;
import com.summit.dp.workflow.application.input.InputSource;
import com.summit.dp.workflow.infrastructure.harness.ExecutionIdentity;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Set;

/** 已提交回执决定任务结果是否仍需注入，完成通知不另记次数。 */
@Component
@RequiredArgsConstructor
public class BackgroundTaskInputSource implements InputSource<Task> {
    private final TaskRepository tasks;
    private final BackgroundTaskNotifications notifications;

    @Override
    public List<Task> pendingItems(Execution execution) {
        Set<String> receipts = notifications.readReceipts(execution);
        return tasks.findByExecutionId(ExecutionIdentity.sessionId(execution), Long.valueOf(execution.getId()))
                .stream().filter(task -> task.getStatus().isTerminal()
                        && !receipts.contains(task.getId().toString())).toList();
    }

    @Override
    public boolean hasOpenDependency(Execution execution) {
        return tasks.findByExecutionId(ExecutionIdentity.sessionId(execution), Long.valueOf(execution.getId()))
                .stream().anyMatch(task -> !task.getStatus().isTerminal());
    }
}
