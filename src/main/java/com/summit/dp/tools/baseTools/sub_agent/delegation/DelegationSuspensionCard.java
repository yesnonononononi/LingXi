package com.summit.dp.tools.baseTools.sub_agent.delegation;

import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.shared.event.ToolCallEventPublisher;
import com.summit.dp.shared.event.ToolCallPendingEvent;
import com.summit.dp.toolcall.application.command.ToolCallRegisterCommand;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.ToolCallRegistrar;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/**
 * 委派挂起卡：子执行挂起时，把「等待审批」登记为父执行的 PROMISE 槽位并返回 promise 结果。
 *
 * <p>从 {@code CallSubAgentTool} 拆出的挂起分支：与 {@code require_choice} / 命令审批同一条
 * 机制——登记器 UPSERT 升级 EXECUTE 占位行（call_sub_agent 启动时已落 EXECUTE 行），工具结果
 * 以 PROMISE 结束 → 框架提交占位工具消息、挂起本执行。父执行因此**同步挂起**等待子代理终态，
 * 而不是提前收尾；子执行终态后由 {@code DelegationBackfillListener} 按卡片载荷里的
 * {@code subSessionId} 匹配槽位回填结果并恢复父执行。</p>
 *
 * <p>这不是人工审批卡：审批对象仍是子会话里的那张卡；本卡等的是子执行的终态信号。</p>
 */
@Component
@RequiredArgsConstructor
public class DelegationSuspensionCard {

    private final ToolCallRegistrar toolCallRegistrar;
    private final ToolCallConverter toolCallConverter;
    private final ToolCallEventPublisher toolCallEventPublisher;
    private final ExecutionIdentity executionIdentity;

    /** 登记 DELEGATION 槽位、按根会话推送卡片事件，返回让父执行挂起的 promise 工具结果。 */
    public ToolExecuteResult suspendAsPromise(ToolExecution toolExecution, String subSessionId,
                                              String agentName, String task) {
        long sessionId = ExecutionIdentity.sessionId(toolExecution);
        long executionId = Long.parseLong(toolExecution.getExecutionId());
        String toolCallId = toolExecution.getId();

        toolCallRegistrar.registerPromise(ToolCallRegisterCommand.promise(
                toolCallId, sessionId, executionId, toolExecution.getToolDefinition().name(),
                ToolCallKind.DELEGATION, agentName,
                toolCallConverter.delegationContent(subSessionId, task),
                toolCallConverter.rawInput(toolExecution.getArgs())));

        long rootSessionId = executionIdentity.rootSessionIdOfSession(sessionId);
        toolCallEventPublisher.publish(rootSessionId, ToolCallPendingEvent.of(rootSessionId, toolCallId,
                ToolCallKind.DELEGATION.name(), String.valueOf(sessionId), String.valueOf(executionId)));
        return ToolExecuteResult.promise("子代理已暂停，等待人工审批");
    }
}
