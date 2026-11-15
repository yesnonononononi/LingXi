package com.summit.dp.workflow.application.decision;

import com.summit.core.agent.Execution;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.event.ToolCallStartEvent;
import com.summit.core.tool.ToolCallStatus;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.toolcall.domain.model.ToolCallOutcome;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

/**
 * 审批批准后的<b>副作用执行</b>与结论派生，与形态无关：真正跑什么由重建出的调用决定。
 *
 * <p><b>为什么与事务编排分开</b>：审批的两段事务里，只有 T1 与 T2 需要和数据库打交道；
 * 中间那次「真的把这次调用跑一遍」是纯外部副作用。夹在事务脚本里会让 T1/T2 的顺序约束
 * （T1 必须早于副作用，否则崩溃后静默重放）被埋在分支噪声里。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ApprovedCallResolver {

    private final RuntimeEventPublisher runtimeEvents;

    /**
     * 执行（或刻意不执行）这次审批对应的调用并派生业务结论。
     *
     * @param call    待执行的调用；{@code null} 表示用户拒绝，调用对象根本没构造出来
     * @param handler 本次卡片形态，提供三处文案与结论载荷
     * @param cancelRequired 调用方求得的「此刻是否已被取消」
     */
    public ToolCallExecution run(ToolExecution call, Execution execution, boolean cancelRequired,
                                 ApprovalKindHandler handler) {
        if (cancelRequired) {
            return new ToolCallExecution(ToolExecuteResult.err(handler.cancelledOutput()),
                    ToolCallOutcome.CANCELLED,
                    handler.rawOutput(ToolCallOutcome.CANCELLED, null, "执行已取消"));
        }
        if (call == null) {
            return new ToolCallExecution(ToolExecuteResult.err(handler.rejectedOutput()),
                    ToolCallOutcome.REJECTED,
                    handler.rawOutput(ToolCallOutcome.REJECTED, null, handler.rejectedOutput()));
        }
        // 工具开始事件必须先于真实执行下发：前端据此把卡片从「等待批准」切到「运行中」，
        // 顺序颠倒会出现「调用已经在跑，卡片还显示等待」的窗口。
        // 身份沿用发起本次工具调用的模型调用身份：审批恢复不是新的一轮模型调用，
        // 这里若新造一个 UUID，前端会把同一轮拆成两条来源。
        runtimeEvents.onToolCall(new ToolCallStartEvent(call.getId(), execution.getId(),
                call.getToolDefinition().name(), call.getArgs(), call.getResponseId(), execution.eventMetaData(),
                ExecutionToolSlot.resolveRequestIndex(execution, call.getId())));
        ToolExecuteResult result = call.getToolDefinition().executor().execute(call);
        return new ToolCallExecution(result, ToolCallOutcome.APPROVED,
                handler.rawOutput(ToolCallOutcome.APPROVED, result.getToolOutput(), null));
    }

    /**
     * 业务结论 → 框架结果状态（用于向外界广播工具结束事件）。
     *
     * <p>{@code cancelled} 独立于 {@code outcome} 传入而非从结论推导：调用执行期间
     * 可能被异步取消，此时结论已是 APPROVED 但对外要播报 CANCELLED。</p>
     */
    public static ToolCallStatus resolveResultStatus(ToolCallOutcome outcome, boolean cancelled) {
        if (cancelled) {
            return ToolCallStatus.CANCELLED;
        }
        return switch (outcome) {
            case REJECTED -> ToolCallStatus.REJECTED;
            case FAILED -> ToolCallStatus.FAILED;
            case TIMED_OUT -> ToolCallStatus.TIMED_OUT;
            default -> ToolCallStatus.COMPLETED;
        };
    }

    /**
     * 一次审批执行的结论。
     *
     * @param result 写回执行末条 tool 消息的结果
     * @param outcome 落进 {@code raw_output.outcome} 的业务结论
     * @param rawOutput 落进 {@code tool_call.raw_output} 的 JSON
     */
    public record ToolCallExecution(ToolExecuteResult result, ToolCallOutcome outcome, String rawOutput) {
    }
}
