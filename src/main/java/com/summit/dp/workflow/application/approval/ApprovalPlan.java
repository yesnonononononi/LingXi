package com.summit.dp.workflow.application.approval;

import com.summit.core.agent.Execution;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.toolcall.domain.model.ToolCall;

/**
 * 命令审批 T1 的准备结果：锁外已完成校验、登记与环境重建，等待引擎事务落库。
 *
 * <p><b>为什么要有这一步</b>：命令执行需要「环境重建 + 登记控制信号」这类锁外动作，
 * 它们必须在事务之前完成；而落库必须整体在引擎的事务里。把两者拆成
 * {@code prepare} 与 {@code writeT1}，事务边界就留在引擎手上，
 * 「T1 提交早于副作用」这条不变量才看得见。</p>
 *
 * @param approved  是否批准；拒绝不需要信号，也不需要命令环境
 * @param execution 锁内读到的执行
 * @param card      锁内重读到的命令卡片
 * @param call      重建出的待执行命令；拒绝时为 {@code null}
 * @param signal    控制信号；拒绝时为 {@code null}
 * @param rejected  拒绝路径的结论（文案来源唯一，避免两处措辞）
 * @param completion 链路收尾回调（v1 用它关流）；可空
 */
public record ApprovalPlan(
        boolean approved,
        Execution execution,
        ToolCall card,
        ToolExecution call,
        ExecutionControlSignal signal,
        CommandOutcomeResolver.CommandExecution rejected,
        Runnable completion
) {
}
