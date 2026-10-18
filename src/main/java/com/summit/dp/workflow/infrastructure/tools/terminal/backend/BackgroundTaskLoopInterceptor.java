package com.summit.dp.workflow.infrastructure.tools.terminal.backend;

import com.summit.core.agent.Execution;
import com.summit.core.runtime.loop.InterceptorResult;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.runtime.loop.LoopInterceptor;
import com.summit.core.runtime.loop.LoopResult;
import com.summit.dp.task.domain.model.Task;
import com.summit.dp.task.domain.repository.TaskRepository;
import com.summit.dp.workflow.application.resume.ExecutionResumeCoordinator;
import com.summit.dp.workflow.infrastructure.harness.ExecutionIdentity;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Set;

/** 只等待本执行发起的任务，不能让其他轮次或子代理的命令阻挡收尾。 */
@Component
@RequiredArgsConstructor
public class BackgroundTaskLoopInterceptor implements LoopInterceptor {
    private final TaskRepository repository;
    private final BackgroundTaskNotifications notifications;
    private final ExecutionResumeCoordinator resumeCoordinator;

    // 协作驻留先检查邮件，终端等待不能遮住它登记自我唤醒的机会。
    @Override public int order() { return -650; }
    @Override public boolean catchErr() { return false; }

    @Override
    public InterceptorResult onBeforeModelInvoke(LoopContext context) {
        Execution execution = context.getLoopMessages().getExecution();
        Long executionId = ExecutionIdentity.numericOrNull(execution.getId());
        if (executionId == null) return InterceptorResult.NONE;
        notifications.append(context, repository.findByExecutionId(ExecutionIdentity.sessionId(execution), executionId));
        return InterceptorResult.NONE;
    }

    @Override
    public InterceptorResult onBeforeComplete(LoopContext context) {
        Execution execution = context.getLoopMessages().getExecution();
        Long executionId = ExecutionIdentity.numericOrNull(execution.getId());
        if (executionId == null) return InterceptorResult.NONE;
        List<Task> tasks = repository.findByExecutionId(ExecutionIdentity.sessionId(execution), executionId);
        Set<String> receipts = notifications.readReceipts(execution);
        boolean pending = tasks.stream().anyMatch(task -> task.getStatus().isTerminal()
                && !receipts.contains(task.getId().toString()));
        boolean running = tasks.stream().anyMatch(task -> !task.getStatus().isTerminal());
        if (!pending && !running) return InterceptorResult.NONE;
        // 完成可能早于挂起；提前登记唤醒，由控制槽位释放后重放。
        if (pending) resumeCoordinator.accept(executionId);
        return InterceptorResult.of(LoopResult.suspended("等待后台终端任务结果"));
    }
}
