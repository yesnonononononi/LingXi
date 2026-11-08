package com.summit.dp.workflow.application.decision;

import com.summit.dp.shared.vo.ToolCallVO;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.vo.DecisionConflictException;
import com.summit.dp.toolcall.application.vo.DecisionErrorCode;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/**
 * v2 / 多选批量入口契约：冲突一律是「错误码 + 文案 + 实际最新视图」，由全局处理器映射成 409。
 *
 * <p>与 v1 的差别只有「怎么表达」，判定顺序与非冲突文案完全一致。</p>
 */
@Component
@RequiredArgsConstructor
public class VersionedDecisionContract implements DecisionEntryContract {

    private final ToolCallConverter converter;

    @Override
    public String label() {
        return "v2-versioned";
    }

    @Override
    public RuntimeException conflict(DecisionErrorCode code, String message, ToolCallVO view) {
        return new DecisionConflictException(code, message, view);
    }

    @Override
    public RuntimeException executionUnavailable(ToolCall card, boolean terminal) {
        // 「已结束」与「尚未暂停」必须是两个码：前者重试无用，后者应当继续等。
        return terminal
                ? new DecisionConflictException(DecisionErrorCode.EXECUTION_ENDED)
                : new DecisionConflictException(DecisionErrorCode.INTERACTION_NOT_READY, "执行尚未暂停，请等待后再提交");
    }

    @Override
    public DecisionReceipt unavailable(ToolCall card, String message) {
        throw new DecisionConflictException(DecisionErrorCode.DECISION_ALREADY_APPLIED,
                DecisionErrorCode.DECISION_ALREADY_APPLIED.message(), converter.toVO(card));
    }

    @Override
    public void admitCard(ToolCall card) {
        // v2 没有「准备中」的独立闸门：它由状态校验统一拒绝，且此时不该报版本冲突。
        if (card.getStatus() == ToolCallStatus.PREPARING) {
            throw new DecisionConflictException(DecisionErrorCode.INTERACTION_NOT_READY);
        }
    }

    @Override
    public void admitExecution(ToolCall card) {
        // v2 不额外检查控制槽位：执行状态校验已覆盖「未暂停」。
    }
}
