package com.summit.dp.workflow.application.chat;

import com.summit.core.agent.Agent;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.dp.agent.application.service.AgentService;
import com.summit.dp.workflow.application.delegation.TeamPromptComposer;
import com.summit.dp.workflow.infrastructure.harness.agent.IChatAgent;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.workflow.infrastructure.harness.agent.SubAgent;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.team.application.service.TeamService;
import com.summit.dp.team.application.vo.TeamVO;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.Objects;

/**
 * 执行编排器：Agent 绑定与模型回落已在 RequestPreparer.prepare 内完成（HC-1/HC-2 的身份前置），
 * 这里只负责「选人设与工具清单 → 构造 AgentRequest → 登记或运行」。
 */
@Component
@RequiredArgsConstructor
public class AgentWorkflowOrchestratorImpl implements AgentWorkflowOrchestrator {

    private final SubAgent subAgent;
    private final TeamService teamService;
    private final RequestPreparer requestPreparer;
    private final AgentService agentService;
    private final IChatAgent agent;

    /** 受理阶段：只登记不运行。 */
    @Override
    public Execution createExecution(RuntimeContext context) {
        return resolveAgent(context).createExecution(buildRequest(context));
    }

    /** 执行阶段：只分发。 */
    @Override
    public Execution execute(RuntimeContext context, Execution execution) {
        return resolveAgent(context).execute(execution);
    }

    /**
     * 档位 → Agent 实例。团队与单 Agent 走 {@link SubAgent}，裸模型走 {@link IChatAgent}。
     *
     * <p><b>创建与执行必须共用本方法</b>：{@code Execution.agentId} 由创建方的 {@code id()} 写入，
     * 而两个实现的 {@code id()} 不同（子代理为空串、聊天代理为 {@code chatAgent}），
     * 错配会把这个执行登记到另一个归属下。</p>
     */
    private Agent resolveAgent(RuntimeContext context) {
        if (context.teamId() != null || context.agentId() != null) {
            return subAgent;
        }
        return agent;
    }

    /**
     * 按档位解析人设与工具清单，构造本次执行请求。
     *
     * <p>三档差异全部集中在这里：团队取指挥者人设并补协作工具；单 Agent 用它自己的配置；
     * 裸模型没有 Agent 配置，改授基础工具集。</p>
     *
     * <p><b>本方法必须在受理事务内跑</b>：整份请求会进执行快照，事后补人设与工具清单会让
     * 落库的请求与真正执行的请求不一致。</p>
     */
    private AgentRequest buildRequest(RuntimeContext context) {
        if (context.teamId() != null) {
            TeamVO team = teamService.findById(context.teamId()).getData();
            if (team == null) throw new ClientException("未找到指定的团队: " + context.teamId());

            Long commanderAgentId = team.getCommanderAgentId();
            if (commanderAgentId == null) throw new ClientException("团队未指定指挥者 Agent: " + context.teamId());

            AgentVO commander = agentService.findById(commanderAgentId).getData();
            if (commander == null) throw new ClientException("未找到团队指挥者 Agent: " + commanderAgentId);

            return requestPreparer.buildRequest(
                    TeamPromptComposer.commanderPrompt(
                            Objects.toString(commander.getPrompt(), ""),
                            team.getAgents(),
                            commanderAgentId,
                            team.getDescription()
                    ),
                    context,
                    commander.getToolList()
            );
        }
        if (context.agentId() != null) {
            AgentVO single = agentService.findById(context.agentId()).getData();
            if (single == null) throw new ClientException("未找到指定的 Agent: " + context.agentId());
            return requestPreparer.buildRequest(single.getPrompt(), context, single.getToolList());
        }
        // 用户输入只留在用户消息中，不能提升为系统人设。
        return requestPreparer.buildRequest("", context, null, true);
    }

}
