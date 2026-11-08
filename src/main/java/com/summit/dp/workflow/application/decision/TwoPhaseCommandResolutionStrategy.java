package com.summit.dp.workflow.application.decision;

import com.summit.core.agent.Execution;
import com.summit.dp.execution.application.service.ResumeDisposition;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallAction;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 命令形态：T1 提交先于副作用、锁外执行命令、T2 落结果、释放并恢复。
 *
 * <p><b>三段的分工</b>：{@link #prepare} 做锁外准备（校验、登记、环境重建），
 * {@link #writeT1} 只提供写入集 —— 由引擎在它自己的事务里调用（事务边界归引擎，
 * 「T1 提交早于副作用」才是一条看得见的不变量），{@link #afterCommit} 在提交之后
 * 派发锁外副作用。副作用本身、T2、恢复仍分别由 {@code CommandOutcomeResolver}、
 * {@code ApprovalFinalizer}、{@code ExecutionResumeCoordinator} 承担。</p>
 *
 * <p><b>引擎不碰 shell</b>：这里也不。命令执行只在 {@code CommandOutcomeResolver} 里发生，
 * 本类只编排顺序，不新建队列、不持有线程。</p>
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
     * 锁外准备：校验动作、登记控制信号、重建命令环境。
     *
     * @param card       锁内重读到的命令卡片
     * @param command    命令决议输入（v1 的 commandId / digest 为 {@code null}）
     * @param contract   入口契约
     * @param completion 链路收尾回调（v1 用它关流）；可空
     */
    public ApprovalPlan prepare(ToolCall card, CommandDecision command, DecisionEntryContract contract,
                                Runnable completion) {
        // ANSWER 对命令卡无意义：放行会把「作答」静默当成「拒绝」，因此在入口显式拒绝。
        if (command.action() == ToolCallAction.ANSWER) {
            throw new ClientException("命令审批只接受批准或拒绝");
        }
        return executor.prepare(card, command.action() == ToolCallAction.APPROVE,
                command.commandId(), command.digest(), completion);
    }

    /**
     * T1 写入集；<b>事务边界由引擎提供</b>，这里绝不自己开事务。
     *
     * @param plan 准备结果
     * @return 本次 T1 的恢复处置（批准恒为 {@code RUNNING}）
     */
    public ResumeDisposition writeT1(ApprovalPlan plan) {
        return executor.writeT1(plan);
    }

    /** T1 回滚：释放控制信号；副作用尚未派发，因此一次都没跑。 */
    public void abandonT1(ApprovalPlan plan) {
        executor.abandonT1(plan);
    }

    /** 事务提交之后派发锁外副作用（批准）或收尾关流（拒绝）。 */
    public void afterCommit(ApprovalPlan plan) {
        executor.afterCommit(plan);
    }

    /**
     * 装配回执：决策已落库，权威视图重新读库。
     *
     * @param plan        本次受理的计划
     * @param command     原始决议输入
     * @param disposition T1 给出的恢复处置
     */
    public DecisionReceipt receiptOf(ApprovalPlan plan, CommandDecision command, ResumeDisposition disposition) {
        ToolCall latest = toolCalls.findById(plan.card().getId()).orElse(plan.card());
        return new DecisionReceipt(command.commandId(), true,
                plan.approved() ? "APPROVED" : "REJECTED",
                List.of(converter.toVO(latest)), disposition);
    }
}
