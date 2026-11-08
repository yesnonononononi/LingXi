package com.summit.dp.workflow.application.decision;

import com.summit.core.agent.Execution;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallAction;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.workflow.application.approval.CommandApprovalExecutor;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 命令形态：T1 提交先于副作用、锁外执行命令、T2 落结果、释放并恢复。
 *
 * <p><b>本轮不改命令行为</b>：这里只做形态适配与回执装配，三段顺序仍由
 * {@link CommandApprovalExecutor} 持有。它不参与引擎的单事务写入 ——
 * 命令有外部副作用，把它的写入塞进引擎事务会把「提交先于副作用」这条不变量藏起来。</p>
 */
@Component
@RequiredArgsConstructor
public final class TwoPhaseCommandResolutionStrategy implements SlotResolutionStrategy {

    private final CommandApprovalExecutor executor;
    private final ToolCallRepository toolCalls;
    private final ToolCallConverter converter;

    /** 命令形态不产出引擎决议项：写入由命令链的 T1/T2 自己持有。 */
    @Override
    public List<SlotResolutionItem> prepareSlotResolutions(Execution execution, List<ToolCall> cards,
                                                           SlotDecisionCommand command,
                                                           DecisionEntryContract contract) {
        return List.of();
    }

    /**
     * 受理一次命令决议并装配回执。
     *
     * @param card       锁内重读到的命令卡片
     * @param command    命令决议输入（v1 的 commandId / digest 为 {@code null}）
     * @param contract   入口契约，仅用于动作不合法时的文案
     * @param completion 异步收尾后的回调（v1 用它关流），可为空
     */
    public DecisionReceipt resolve(ToolCall card, CommandDecision command, DecisionEntryContract contract,
                                   Runnable completion) {
        // ANSWER 对命令卡无意义：放行会把「作答」静默当成「拒绝」，因此在入口显式拒绝。
        if (command.action() == ToolCallAction.ANSWER) {
            throw new ClientException("命令审批只接受批准或拒绝");
        }
        CommandApprovalExecutor.CommandApprovalResult result = executor.decide(card,
                command.action() == ToolCallAction.APPROVE, command.commandId(), command.digest(), completion);
        ToolCall latest = toolCalls.findById(card.getId()).orElse(card);
        return new DecisionReceipt(command.commandId(), true, result.outcome().name(),
                List.of(converter.toVO(latest)), result.disposition());
    }
}
