package com.summit.dp.workflow.application.decision;

import com.summit.core.agent.Execution;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.toolcall.domain.model.ToolCallOutcome;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/**
 * 命令审批形态：批准后真的把那条命令跑一遍，因此文案里必须点明「命令」。
 *
 * <p>文案与重建都归本类，命令语义不再漏进编排层。</p>
 */
@Component
@RequiredArgsConstructor
public class CommandApprovalHandler implements ApprovalKindHandler {

    /** 批准后、命令尚未跑完时写进槽位的占位输出；崩溃后据此看出「已受理、结果未知」。 */
    private static final String APPROVED_PENDING_OUTPUT = "命令已批准，正在执行";

    private static final String REJECTED_OUTPUT = "用户拒绝，命令未执行";
    private static final String CANCELLED_OUTPUT = "命令未执行：执行已取消";

    private final ApprovedCommandRestorer restorer;
    private final ToolCallConverter converter;

    @Override
    public ToolCallKind kind() {
        return ToolCallKind.COMMAND;
    }

    @Override
    public ToolExecution restore(Execution execution, ToolCall card) {
        return restorer.restore(execution, card);
    }

    @Override
    public String pendingOutput() {
        return APPROVED_PENDING_OUTPUT;
    }

    @Override
    public String rejectedOutput() {
        return REJECTED_OUTPUT;
    }

    @Override
    public String cancelledOutput() {
        return CANCELLED_OUTPUT;
    }

    @Override
    public String interruptedReason(String cause) {
        return "命令审批执行中断；请检查命令实际结果，禁止自动重放：" + cause;
    }

    @Override
    public String rawOutput(ToolCallOutcome outcome, String output, String reason) {
        return converter.commandOutcome(outcome, output, reason);
    }
}
