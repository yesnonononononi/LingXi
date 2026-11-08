package com.summit.dp.workflow.application.decision;

import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.ToolCallVO;
import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy;
import com.summit.dp.toolcall.application.vo.DecisionErrorCode;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

/**
 * v1 入口契约：错误一律是 {@link ClientException}，已处理按幂等 no-op 结束。
 *
 * <p>这里逐条保留旧行为：判定顺序「准备中 → 已处理 → 形态不可决策 → 执行仍活跃」，
 * 以及每条各自的文案。删掉任何一条都会让旧前端从「按钮点了没反应」变成报错，
 * 或反之。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ReactiveDecisionContract implements DecisionEntryContract {

    private final CardAvailabilityPolicy cardAvailability;

    @Override
    public String label() {
        return "v1-react";
    }

    @Override
    public RuntimeException conflict(DecisionErrorCode code, String message, ToolCallVO view) {
        return new ClientException(message);
    }

    @Override
    public RuntimeException executionUnavailable(ToolCall card, boolean terminal) {
        // v1 只有一句文案：调用方只被告知「等一下再试」，不区分已结束与未暂停。
        return new ClientException("执行尚未暂停或已结束，请稍后重试");
    }

    @Override
    public DecisionReceipt unavailable(ToolCall card, String message) {
        return DecisionReceipt.noOp(null);
    }

    @Override
    public void admitCard(ToolCall card) {
        if (card.getStatus() == ToolCallStatus.PREPARING) {
            throw new ClientException("互动尚在准备，请等待执行暂停后再提交");
        }
    }

    @Override
    public void admitExecution(ToolCall card) {
        // 形态判定在入口（它本来就要解析形态才能选链路），这里只补 v1 独有的「执行仍活跃」。
        if (cardAvailability.isExecutionActive(String.valueOf(card.getExecutionId()))) {
            throw new ClientException("执行仍在运行或退出，请等待后再提交");
        }
    }
}
