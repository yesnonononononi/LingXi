package com.summit.dp.toolcall.infrastructure.listener;

import com.summit.core.agent.Execution;
import com.summit.dp.execution.domain.lifecycle.ExecutionLifecycleListener;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.toolcall.application.service.ToolCallReadinessService;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/** 旧执行退出后确认就绪，终态收口全部未决槽位。 */
@Component
@RequiredArgsConstructor
public class ExecutionLifecycleAdapter implements ExecutionLifecycleListener {

    private final ToolCallService toolCallService;
    private final ToolCallReadinessService readinessService;

    @Override
    public void onExecutionSuspended(String executionId, Execution execution) {
        readinessService.markReady(executionId);
    }

    /** 终态信号附带的 Execution 对象本适配器用不到（只收尾残留卡片，按 executionId 即可）。 */
    @Override
    public void onExecutionFinished(String executionId, Execution execution) {
        toolCallService.cancelPendingToolCalls(executionId);
    }
}
