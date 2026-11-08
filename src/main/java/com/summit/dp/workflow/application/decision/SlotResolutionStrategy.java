package com.summit.dp.workflow.application.decision;

import com.summit.core.agent.Execution;
import com.summit.dp.toolcall.domain.model.ToolCall;

import java.util.List;

/**
 * 槽位决议策略：决定「这批卡片该写什么」，不决定「怎么落库」。
 *
 * <p>两种形态在事务边界上就不同：立即形态由引擎在一次事务里写完；命令形态必须
 * T1 提交先于副作用、T2 再落结果，事务由命令链自己持有。因此形态用 sealed 表达，
 * 引擎按穷尽 switch 分派 —— 不用按 {@code Class} 查注册表。</p>
 */
public sealed interface SlotResolutionStrategy
        permits ImmediateSlotResolutionStrategy, TwoPhaseCommandResolutionStrategy {

    /**
     * 计算本批槽位决议。<b>只读不写库</b>：全部校验通过之前不得产生任何副作用。
     *
     * @param execution 卡片所属执行（已通过状态校验）
     * @param cards     锁内重读到的卡片，顺序与 {@link SlotDecisionCommand#cardIds()} 一致
     * @param command   本次决议输入
     * @param contract  入口契约，用于按本入口语义抛冲突
     * @return 与卡片一一对应的决议项
     */
    List<SlotResolutionItem> prepareSlotResolutions(Execution execution, List<ToolCall> cards,
                                                    SlotDecisionCommand command, DecisionEntryContract contract);
}
