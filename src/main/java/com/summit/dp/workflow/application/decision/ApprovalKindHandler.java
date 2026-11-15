package com.summit.dp.workflow.application.decision;

import com.summit.core.agent.Execution;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.toolcall.domain.model.ToolCallOutcome;

/**
 * 一种「批准后才执行」的卡片形态的 kind 相关语义。
 *
 * <p>两阶段链（T1 提交 → 锁外副作用 → T2 落结果 → 恢复）与形态无关，只有几件事随形态变化：
 * 快照怎么重建成可执行调用、三处给用户看的文案、以及结论载荷怎么拼。收敛到这里之后，
 * 新增一种审批形态只需实现本接口并注册成 bean，编排与事务边界一行都不用动。</p>
 */
public interface ApprovalKindHandler {

    /** 本实现负责的卡片形态。 */
    ToolCallKind kind();

    /**
     * 按卡片快照重建待执行的调用。
     *
     * <p>环境或参数与签发审批卡时不一致必须抛 {@link ClientException}：宁可让用户重新发起，
     * 也不能拿一份过期快照去落盘。</p>
     */
    ToolExecution restore(Execution execution, ToolCall card);

    /** 批准后、副作用尚未跑完时写进槽位的占位输出（崩溃后据此看出「已受理、结果未知」）。 */
    String pendingOutput();

    /** 拒绝时写回工具结果的文案。 */
    String rejectedOutput();

    /** 取消时写回工具结果的文案。 */
    String cancelledOutput();

    /** 执行中断时给用户看的原因，必须说清「可能已产生副作用、禁止自动重放」。 */
    String interruptedReason(String cause);

    /** 落进 {@code raw_output} 的结论载荷。 */
    String rawOutput(ToolCallOutcome outcome, String output, String reason);
}
