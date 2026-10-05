package com.summit.dp.toolcall.api.dto;

import com.summit.dp.execution.application.service.ResumeDisposition;
import com.summit.dp.shared.vo.ToolCallVO;

/**
 * v2 决策回执：只承诺「决策已落库」，不承诺「已经开始实施」。
 *
 * <p><b>为什么回执不内嵌决策事件</b>：决策落库与恢复事件到达是两件事。
 * 要求回执携带第一条恢复事件，会让「决策已保存但恢复还没派发」这种合法中间态
 * 变成一次超时失败 —— 而此时决策其实已经生效，重试会造成重复提交。</p>
 *
 * <p><b>为什么必须带 resumeDisposition</b>：批准一张卡片后执行不一定马上跑 ——
 * 可能还有其他未决槽位在等，可能只是入了队列，可能恢复失败了，也可能执行已经结束。
 * 一律显示「正在实施」会让用户在恢复根本没发生时一直等下去。</p>
 *
 * @param commandId          决策命令身份
 * @param decisionApplied    决策是否已落库（首次落库与同命令重试查回都为 true）
 * @param decision           实际落定的动作
 * @param toolCall           卡片最新视图
 * @param resumeDisposition  恢复意图被怎么处理了
 */
public record ToolCallDecisionReceipt(
        String commandId,
        boolean decisionApplied,
        String decision,
        ToolCallVO toolCall,
        ResumeDisposition resumeDisposition
) {
}
