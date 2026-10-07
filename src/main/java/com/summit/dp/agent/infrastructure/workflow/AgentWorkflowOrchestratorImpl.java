package com.summit.dp.agent.infrastructure.workflow;


import com.summit.core.agent.Agent;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.Message;
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
                    commanderTools(commander.getToolList())
            );
        }
        if (context.agentId() != null) {
            AgentVO single = agentService.findById(context.agentId()).getData();
            if (single == null) throw new ClientException("未找到指定的 Agent: " + context.agentId());
            return requestPreparer.buildRequest(single.getPrompt(), context, single.getToolList());
        }
        return requestPreparer.buildRequest(userTextOf(context), context, ToolCatalog.DEFAULT_AGENT_TOOLS);
    }

    /**
     * 裸模型档位的角色提示词：沿用既有行为，把本轮用户输入交给 mergeSystemPrompt。
     * 输入正文取自 prepare 追加的最后一条用户消息。
     */
    private static String userTextOf(RuntimeContext context) {
        List<Message> messages = context.messageList();
        if (messages == null || messages.isEmpty()) return "";
        Message last = messages.getLast();
        return last == null ? "" : Objects.toString(last.text(), "");
    }

    /**
     * 协作工具不在 Agent 配置中下发，而是在协作开始时显式授予指挥者：这样除指挥者外的成员
     * 永远拿不到 {@code call_sub_agent}，不会出现多层委派。
     *
     * <p>{@code send_mail_to_agent} 同理一并授予 —— 它同样只在协作场景成立（收件人是团队成员），
     * 而没有任何 Agent 配置里会写上它；不在这里补，团队里就没人发得出信。</p>
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
