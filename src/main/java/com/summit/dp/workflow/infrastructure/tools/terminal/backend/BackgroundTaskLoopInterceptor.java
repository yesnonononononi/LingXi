package com.summit.dp.workflow.infrastructure.tools.terminal.backend;

import com.summit.core.agent.Execution;
import com.summit.core.runtime.loop.InterceptorResult;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.runtime.loop.LoopInterceptor;
import com.summit.dp.workflow.infrastructure.harness.ExecutionIdentity;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;


/** 只注入本执行尚未交付的任务结果，等待判断由共享收尾入口负责。 */
@Component
@RequiredArgsConstructor
public class BackgroundTaskLoopInterceptor implements LoopInterceptor {
    private final BackgroundTaskInputSource inputSource;
    private final BackgroundTaskNotifications notifications;

    // 邮件先注入，任务结果随后进入同一轮上下文。
    @Override public int order() { return -650; }
    @Override public boolean catchErr() { return false; }

    @Override
    public InterceptorResult onBeforeModelInvoke(LoopContext context) {
        Execution execution = context.getLoopMessages().getExecution();
        Long executionId = ExecutionIdentity.numericOrNull(execution.getId());
        if (executionId == null) return InterceptorResult.NONE;
        notifications.append(context, inputSource.pendingItems(execution));
        return InterceptorResult.NONE;
    }

}
