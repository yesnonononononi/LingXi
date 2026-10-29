package com.summit.dp.workflow.infrastructure.tools.terminal.backend;

import com.summit.core.runtime.CommandHandler;
import com.summit.dp.task.domain.model.Task;
import lombok.Getter;
import lombok.RequiredArgsConstructor;

import java.util.concurrent.locks.ReentrantLock;

/** 句柄只控制当前进程，业务身份和终态由 Task 保存。 */
@Getter
@RequiredArgsConstructor
public class BackendProcess {
    private final Task task;
    private final CommandHandler handle;
    /** 收尾等待不能占用状态锁，也不能在 Java 21 上因持有监视器而钉住虚拟线程。 */
    private final ReentrantLock completionLock = new ReentrantLock();
}
