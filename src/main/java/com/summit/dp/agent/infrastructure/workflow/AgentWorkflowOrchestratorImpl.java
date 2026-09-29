package com.summit.dp.agent.infrastructure.workflow;


import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.dp.agent.application.service.AgentService;
import com.summit.dp.agent.application.service.impl.RuntimeContext;
import com.summit.dp.agent.infrastructure.agent.IChatAgent;
import com.summit.dp.shared.utils.RequestPreparer;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.shared.model.ToolCatalog;
import com.summit.dp.agent.infrastructure.agent.SubAgent;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.team.application.service.TeamService;
import com.summit.dp.team.application.vo.TeamVO;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.stream.Collectors;

/**
 * 执行编排器：三个入口都只接收已 prepare 的 {@link RuntimeContext}。
 * Agent 绑定与模型回落已在 RequestPreparer.prepare 内完成（HC-1/HC-2 的身份前置），
 * 这里只负责「选人设与工具清单 → 构造 AgentRequest → 交给对应执行器」。
 */
@Component
@RequiredArgsConstructor
public class AgentWorkflowOrchestratorImpl implements AgentWorkflowOrchestrator {

    private final SubAgent subAgent;
    private final TeamService teamService;
    private final RequestPreparer requestPreparer;
    private final AgentService agentService;
    private final IChatAgent agent;

    @Override
    public Execution executeWorkflow(Long teamId, RuntimeContext context) {

        TeamVO team = teamService.findById(teamId).getData();
        if (team == null) throw new ClientException("Team not found");

        Long commanderAgentId = team.getCommanderAgentId();
        if (commanderAgentId == null) throw new ClientException("Commander agent  not assigned in team");


        AgentVO commanderAgent = agentService.findById(commanderAgentId).getData();
        if (commanderAgent == null) throw new ClientException("Commander agent not found from team");

        AgentRequest agentRequest = requestPreparer.buildRequest(
                TeamPromptComposer.commanderPrompt(commanderAgent.getPrompt(), team.getAgents(), commanderAgentId),
                context,
                commanderTools(commanderAgent.getToolList())
        );

        // 团队 ID 已随 AgentRequest attributes 下行（RequestPreparer.attributes），委派工具从执行上下文读取
        return subAgent.execute(agentRequest);
    }

    /**
     * 单 Agent 直聊：没有团队与委派，Agent 的人设与工具清单就是本次执行的全部约束。
     * 清单未配置（null）时按「未授权任何工具」处理（框架侧名单即授权）。
     */
    @Override
    public Execution executeSingleAgent(Long agentId, RuntimeContext context) {
        if (agentId == null) throw new ClientException("Agent not assigned");

        AgentVO agent = agentService.findById(agentId).getData();
        if (agent == null) throw new ClientException("Agent not found: " + agentId);

        AgentRequest agentRequest = requestPreparer.buildRequest(
                agent.getPrompt(), context, agent.getToolList());
        return subAgent.execute(agentRequest);
    }

    /**
     * 裸模型档位：不绑定 Agent，没有 Agent 级工具配置，因此传 {@code null} —— 即未授权任何静态工具。
     * 例外是 MCP：配了 {@code mcpConfig} 时 {@code RequestPreparer} 会兜底
     * {@link com.summit.dp.shared.model.ToolCatalog#SEARCH_TOOL}，让模型能发现并调用远端工具。
     */
    @Override
    public Execution executeDefaultAgent(RuntimeContext context) {
        AgentRequest agentRequest = requestPreparer.buildRequest(userTextOf(context), context, null);
        return agent.execute(agentRequest);
    }

    /**
     * 裸模型档位的角色提示词：沿用既有行为，把本轮用户输入交给 mergeSystemPrompt。
     * 输入正文取自 prepare 追加的最后一条用户消息。
     */
    private static String userTextOf(RuntimeContext context) {
        List<com.summit.core.conversation.message.Message> messages = context.messageList();
        if (messages == null || messages.isEmpty()) return "";
        com.summit.core.conversation.message.Message last = messages.getLast();
        return last == null ? "" : Objects.toString(last.text(), "");
    }

    /**
     * 协作工具不在 Agent 配置中下发，而是在协作开始时显式授予指挥者：这样除指挥者外的成员
     * 永远拿不到 {@code call_sub_agent}，不会出现多层委派。
     *
     * <p>{@code send_mail_to_agent} 同理一并授予——它同样只在协作场景成立（收件人是团队成员），
     * 而没有任何 Agent 配置里会写上它；不在这里补，团队里就没人发得出信，
     * 工具形同虚设（此前正是这个状态：只有「未配工具清单」的执行能看到它，而那些执行
     * 又没有 Agent 身份，一调用就报「当前执行未绑定 Agent」）。</p>
     */
    private List<String> commanderTools(List<String> configuredTools) {
        List<String> tools = configuredTools == null
                ? new ArrayList<>()
                : configuredTools.stream()
                .filter(Objects::nonNull)
                .map(String::trim)
                .filter(tool -> !tool.isEmpty())
                .distinct()
                .collect(Collectors.toCollection(ArrayList::new));
        if (!tools.contains(ToolCatalog.CALL_SUB_AGENT)) tools.add(ToolCatalog.CALL_SUB_AGENT);
        if (!tools.contains(ToolCatalog.SEND_MAIL_TO_AGENT)) tools.add(ToolCatalog.SEND_MAIL_TO_AGENT);
        return tools;
    }


}
