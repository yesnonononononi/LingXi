package com.summit.dp.toolcall.application.service.impl;

import com.summit.core.agent.Execution;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.event.ToolCallStartEvent;
import com.summit.core.tool.ToolCallStatus;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCallOutcome;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

/**
 * 命令审批的<b>副作用执行</b>与结论派生。
 *
 * <p><b>为什么与事务编排分开</b>：审批的两段事务里，只有 T1 与 T2 需要和数据库打交道；
 * 中间那次「真的把命令跑一遍」是纯外部副作用。夹在事务脚本里会让 T1/T2 的顺序约束
 * （T1 必须早于副作用，否则崩溃后静默重放）被埋在分支噪声里。拆开后
 * T1 → 副作用 → T2 三个阶段在调用方一眼可见。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class CommandOutcomeResolver {

    private final ToolCallConverter converter;
    private final RuntimeEventPublisher runtimeEvents;

    /** 取消时写回工具结果的文案。 */
    private static final String CANCELLED_OUTPUT = "命令未执行：执行已取消";
    /** 拒绝时写回工具结果的文案。 */
    private static final String REJECTED_OUTPUT = "用户拒绝，命令未执行";

    /**
     * 执行（或刻意不执行）命令并派生业务结论。
     *
     * @param call 待执行的命令；{@code null} 表示用户拒绝，命令对象根本没构造出来
     * @param cancelRequired 调用方求得的「此刻是否已被取消」
     */
    public CommandExecution run(ToolExecution call, Execution execution, boolean cancelRequired) {
        if (cancelRequired) {
            return new CommandExecution(ToolExecuteResult.err(CANCELLED_OUTPUT), ToolCallOutcome.CANCELLED,
                    converter.cancelled("执行已取消"));
        }
        if (call == null) {
            return new CommandExecution(ToolExecuteResult.err(REJECTED_OUTPUT), ToolCallOutcome.REJECTED,
                    converter.commandOutcome(ToolCallOutcome.REJECTED, null, REJECTED_OUTPUT));
        }
        // 工具开始事件必须先于真实执行下发：前端据此把卡片从「等待批准」切到「运行中」，
        // 顺序颠倒会出现「命令已经在跑，卡片还显示等待」的窗口。
        runtimeEvents.onToolCall(new ToolCallStartEvent(call.getId(), execution.getId(),
                call.getToolDefinition().name(), call.getArgs()));
        ToolExecuteResult result = call.getToolDefinition().executor().execute(call);
        return new CommandExecution(result, ToolCallOutcome.APPROVED,
                converter.commandOutcome(ToolCallOutcome.APPROVED, result.getToolOutput(), null));
    }

    /**
     * 业务结论 → 框架结果状态（用于向外界广播工具结束事件）。
     *
     * <p>{@code cancelled} 独立于 {@code outcome} 传入而非从结论推导：命令执行期间
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
     * 一次命令执行的结论。
     *
     * @param result 写回执行末条 tool 消息的结果
     * @param outcome 落进 {@code raw_output.outcome} 的业务结论
     * @param rawOutput 落进 {@code tool_call.raw_output} 的 JSON
     */
    public record CommandExecution(ToolExecuteResult result, ToolCallOutcome outcome, String rawOutput) {
    }
}
