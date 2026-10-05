package com.summit.dp.toolcall.infrastructure.listener;

import com.summit.core.conversation.event.ToolCallEndEvent;
import com.summit.core.conversation.event.ToolCallStartEvent;
import com.summit.core.tool.ToolCallStatus;
import com.summit.core.runtime.RuntimeListener;
import com.summit.dp.toolcall.application.service.ToolCallRegistrar;
import com.summit.dp.toolcall.domain.model.ToolCallOutcome;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

/**
 * 框架 {@code RuntimeListener} 的可观测挂载点：把**所有普通工具**（{@code EXECUTE}）的
 * 开始 / 结束 / 结果 / 状态落到 {@code tool_call} 表。
 *
 * <p><b>为什么挂在这里：</b>{@code DefaultToolExecutionManager} 在 {@code invokeTool} 之前回调
 * {@link #onToolCall}、在 {@code publishEndEvent} 回调 {@link #onToolCallOutput}，后者携带
 * {@code requestId}（call id）/ {@code executionId} / {@code toolName} / {@code args} / {@code output} /
 * {@code resultStatus}。业务侧的 {@code ToolExecutionPolicy} 只有前置钩子、拿不到结果，
 * 因此这是唯一能在业务侧观测工具**结果**的框架挂载路径。</p>
 *
 * <p><b>PROMISE 工具不在此收尾：</b>{@code create_plan} / {@code require_choice} / 命令审批
 * 的 {@code resultStatus} 为 {@code PROMISED}（或根本无 {@code STARTED}），其状态一律由
 * {@code ToolCallService.decide} 收尾；本监听器对 {@code PROMISED} 显式忽略。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ToolCallExecutionListener implements RuntimeListener {

    private final ToolCallRegistrar registrar;

    @Override
    public void onToolCall(ToolCallStartEvent event) {
        try {
            registrar.markExecuteStarted(event.getRequestId(), numericId(event.getExecutionId()),
                    event.getToolName(), event.getArgs());
        } catch (RuntimeException e) {
            // 观测链路不得拖垮主执行流：登记失败只告警，工具照常执行。
            log.warn("登记工具调用开始失败: requestId={}, error={}", event.getRequestId(), e.toString());
        }
    }

    @Override
    public void onToolCallOutput(ToolCallEndEvent event) {
        if (event.resultStatus() == ToolCallStatus.PROMISED) {
            return;   // PROMISE 的结论交给 decide 端点收尾
        }
        try {
            ToolCallOutcome outcome = ToolCallOutcome.fromFrameworkStatus(event.resultStatus());
            registrar.completeExecute(event.getRequestId(), numericId(event.getExecutionId()),
                    event.getToolName(), event.getArgs(), event.getOutput(), outcome);
        } catch (RuntimeException e) {
            log.warn("登记工具调用结束失败: requestId={}, error={}", event.getRequestId(), e.toString());
        }
    }

    /** 执行 id 解析失败返回 {@code -1}（登记器据此降级跳过，不抛异常拖垮主流程）。 */
    private static long numericId(String executionId) {
        try {
            return Long.parseLong(executionId);
        } catch (NumberFormatException e) {
            return -1L;
        }
    }
}
