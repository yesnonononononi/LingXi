package com.summit.dp.tools.baseTools.sub_agent.delegation;

import com.summit.core.agent.AgentRequest;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.tools.baseTools.arguments.CallSubAgentToolArgument;
import com.summit.dp.tools.baseTools.sub_agent.session.SubSessionTarget;

/**
 * 一次协作式（异步）委派的载荷：请求线程组装好、交给异步线程消费。
 *
 * <p>它把「已经确定的事实」一次性带过去 —— 目标子会话、请求对象、落账所需的工具执行上下文。
 * 异步线程不再回查、不再重新解析，只按固定顺序落库并开跑；请求线程与异步线程之间唯一的契约就是它。</p>
 *
 * @param rootSessionId      根会话 id
 * @param numericSubSessionId 目标子会话 id（数值形态，供注册表与落库使用）
 * @param parentWorkspaceId  父会话绑定的工作空间 id，供首派建子会话行时回落
 * @param target             子会话复用判定结果（是否首派 + 既有历史）
 * @param agent              目标 Agent
 * @param argument           模型给出的委派参数（异步线程据其取任务原文）
 * @param toolExecution      本次工具执行上下文（落账需要其轮次与事件元数据）
 * @param request            已组装好的子执行请求
 */
public record AsyncDelegationTask(
        Long rootSessionId,
        Long numericSubSessionId,
        Long parentWorkspaceId,
        SubSessionTarget target,
        AgentVO agent,
        CallSubAgentToolArgument argument,
        ToolExecution toolExecution,
        AgentRequest request) {
}
