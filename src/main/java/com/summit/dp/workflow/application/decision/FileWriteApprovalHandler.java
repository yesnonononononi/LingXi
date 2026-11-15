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
 * 文件改动审批形态：批准后按快照重放那次越界写入（一次授权只作用于这一次调用）。
 */
@Component
@RequiredArgsConstructor
public class FileWriteApprovalHandler implements ApprovalKindHandler {

    /** 批准后、改动尚未落盘时写进槽位的占位输出；崩溃后据此看出「已受理、结果未知」。 */
    private static final String APPROVED_PENDING_OUTPUT = "文件改动已批准，正在执行";

    private static final String REJECTED_OUTPUT = "用户拒绝，文件未被改动";
    private static final String CANCELLED_OUTPUT = "文件未改动：执行已取消";

    private final ApprovedFileWriteRestorer restorer;
    private final ToolCallConverter converter;

    @Override
    public ToolCallKind kind() {
        return ToolCallKind.FILE_WRITE;
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
        return "文件改动审批执行中断；请检查目标文件实际状态，禁止自动重放：" + cause;
    }

    @Override
    public String rawOutput(ToolCallOutcome outcome, String output, String reason) {
        return converter.mutationOutcome(outcome, output, reason);
    }
}
