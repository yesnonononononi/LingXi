package com.summit.dp.workflow.infrastructure.tools.terminal;

import com.summit.core.runtime.CommandHandler;
import com.summit.dp.task.domain.model.Task;
import lombok.Getter;
import lombok.RequiredArgsConstructor;

/** 句柄只控制当前进程，业务身份和终态由 Task 保存。 */
@Getter
@RequiredArgsConstructor
public class BackendProcess {
    private final Task task;
    private final CommandHandler handle;
}