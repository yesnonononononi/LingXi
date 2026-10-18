package com.summit.dp.task.application.service;

import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.task.domain.model.Task;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.List;

/** 任务记录也是结果通知依据，所属执行结束前不能删除。 */
@Component
@RequiredArgsConstructor
public class TaskDeletionPolicy {
    private final ExecutionRepository executions;

    public void validate(Task task) {
        if (task.getExecutionId() == null) return;
        boolean ended = executions.findSummariesByIds(List.of(task.getExecutionId())).stream()
                .anyMatch(execution -> ExecutionStatusCodes.isTerminal(execution.getStatus()));
        throwIf(!ended, "任务所属执行尚未结束，请等待结果通知完成后再删除");
    }

    private void throwIf(boolean condition, String err) { if (condition) throw new ClientException(err); }
}
