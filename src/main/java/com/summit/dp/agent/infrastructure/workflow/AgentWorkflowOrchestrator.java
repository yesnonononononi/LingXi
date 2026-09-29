package com.summit.dp.agent.infrastructure.workflow;


import com.summit.core.agent.Execution;
import com.summit.dp.agent.application.service.impl.RuntimeContext;

public interface AgentWorkflowOrchestrator {
    /** 团队模式：以团队指挥者为主 Agent 执行。 */
    Execution executeWorkflow(Long teamId, RuntimeContext context);

    /** 单 Agent 直聊：直接用该 Agent 的人设与工具清单执行，没有团队与委派。 */
    Execution executeSingleAgent(Long agentId, RuntimeContext context);


    Execution executeDefaultAgent(RuntimeContext context);
}
