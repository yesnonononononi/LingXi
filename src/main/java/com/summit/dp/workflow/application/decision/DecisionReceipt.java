package com.summit.dp.workflow.application.decision;

import com.summit.dp.execution.application.service.ResumeDisposition;
import com.summit.dp.shared.vo.ToolCallVO;

import java.util.List;

/**
 * 统一决策回执：三个入口共用同一份结论形状，各自再做输出转换。
 *
 * <p>{@code decisionApplied=false} 只出现在「卡片本来就不待决」的幂等 no-op 上，
 * 表示本次没有写库、也没有登记恢复。</p>
 *
 * @param commandId         决策命令身份；v1 没有这个概念，为 {@code null}
 * @param decisionApplied   决策是否已落库（首次落库与同命令重试查回都为 true）
 * @param decision          实际落定的动作名（命令多选批量没有单一动作，为 {@code null}）
 * @param toolCalls         本批卡片的权威最新视图
 * @param resumeDisposition 恢复意图被怎么处理了；入口自行恢复时为 {@code null}
 */
public record DecisionReceipt(
        String commandId,
        boolean decisionApplied,
        String decision,
        List<ToolCallVO> toolCalls,
        ResumeDisposition resumeDisposition
) {

    /**
     * 幂等 no-op：卡片本来就不待决，本次不写库、不登记恢复。
     *
     * @param commandId 决策命令身份，可为空
     */
    public static DecisionReceipt noOp(String commandId) {
        return new DecisionReceipt(commandId, false, null, List.of(), null);
    }

    /** 单卡回执的视图；批量回执请直接用 {@link #toolCalls()}。 */
    public ToolCallVO singleView() {
        return this.toolCalls.isEmpty() ? null : this.toolCalls.getFirst();
    }
}
