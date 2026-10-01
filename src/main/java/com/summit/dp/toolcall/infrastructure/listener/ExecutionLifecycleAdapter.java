package com.summit.dp.toolcall.infrastructure.listener;

import com.summit.core.agent.Execution;
import com.summit.dp.execution.domain.lifecycle.ExecutionLifecycleListener;
import com.summit.dp.toolcall.application.service.ToolCallService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

/**
 * 执行生命周期适配器：订阅 execution 模块的生命周期端口，
 * 驱动本模块的「推送 pending 卡片 / 收尾残留卡片」。
 *
 * <p><b>评审 P1-⑥：</b>把原先 {@code execution.infrastructure → toolcall.application} 的直接反向依赖，
 * 反转为「execution 发出端口信号 ← toolcall 订阅」。execution 模块基础设施因此不再 import 任何
 * toolcall 类型，两侧可独立理解与演进。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ExecutionLifecycleAdapter implements ExecutionLifecycleListener {

    private final ToolCallService toolCallService;

    @Override
    public void onExecutionSuspended(String executionId) {
        toolCallService.publishPendingToolCalls(executionId);
    }

    /** 终态信号附带的 Execution 对象本适配器用不到（只收尾残留卡片，按 executionId 即可）。 */
    @Override
    public void onExecutionFinished(String executionId, Execution execution) {
        toolCallService.cancelPendingToolCalls(executionId);
    }
}
