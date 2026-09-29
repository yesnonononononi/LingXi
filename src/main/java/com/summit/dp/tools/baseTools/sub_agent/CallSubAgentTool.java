package com.summit.dp.tools.baseTools.sub_agent;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.core.JsonProcessingException;
import cn.hutool.core.util.IdUtil;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.Message;
import com.summit.core.conf.ModelConfig;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.agent.application.service.AgentService;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.shared.model.ToolCatalog;
import com.summit.dp.agent.infrastructure.agent.SubAgent;
import com.summit.dp.agent.infrastructure.event.SubAgentSessionEventPublisher;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.agent.infrastructure.workflow.TeamPromptComposer;
import com.summit.dp.session.application.service.ConversationTranscriptService;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.TokenUsage;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.context.SettingsView;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.settings.SettingsProvider;
import com.summit.dp.shared.vo.WorkspaceVO;
import com.summit.dp.team.application.service.TeamService;
import com.summit.dp.shared.context.SessionContextEntity;
import com.summit.dp.team.application.vo.TeamVO;
import com.summit.dp.tools.baseTools.arguments.CallSubAgentToolArgument;
import com.summit.dp.workspace.application.service.WorkspaceService;
import com.summit.dp.workspace.application.convert.WorkspaceConverter;
import lombok.AllArgsConstructor;
import lombok.NonNull;
import org.springframework.stereotype.Component;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Collectors;

@AllArgsConstructor
@Component
public class CallSubAgentTool implements ToolExecutor {
    private final ObjectMapper objectMapper;
    private final WorkspaceService workspaceService;
    private final ModelService modelService;
    private final SettingsProvider settingsProvider;
    private final AgentService agentService;
    private final SubAgent subAgent;
    private final WorkspaceConverter workspaceConverter;
    private final TeamService teamService;
    private final SubAgentSessionEventPublisher subAgentSessionEventPublisher;
    private final SessionExecutionRegistry sessionExecutionRegistry;
    private final ConversationTranscriptService transcriptService;
    private final ModelContextService modelContextService;
    private final SessionRepository sessionRepository;


    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        try {
            return executeDelegation(toolExecution);
        } catch (Exception e) {
            return ToolExecuteResult.err("工具执行遇到错误:" + e);
        }
    }

    private ToolExecuteResult executeDelegation(ToolExecution toolExecution) throws JsonProcessingException {
        String args = toolExecution.getArgs();
        if (args == null || args.isBlank()) return ToolExecuteResult.err("工具参数需要非空");

        CallSubAgentToolArgument argument = objectMapper.readValue(args, CallSubAgentToolArgument.class);
        ToolExecuteResult argumentError = validateArgument(argument);
        if (argumentError != null) return argumentError;

        String workDir = resolveWorkDir(argument, toolExecution);
        Long teamId = resolveTeamId(toolExecution);
        if (teamId == null) return ToolExecuteResult.err("未确定当前协作团队，无法委派任务");

        Long agentId = argument.getAgentId();
        AgentVO agent = agentService.findById(agentId).getData();
        if (agent == null) return ToolExecuteResult.err("未找到指定的Agent: " + agentId);
        if (agent.getModelId() == null) return ToolExecuteResult.err("子 Agent 未配置模型，请先为该 Agent 绑定模型");

        TeamVO team = teamService.findById(teamId).getData();
        if (team == null) return ToolExecuteResult.err("未找到指定的团队: " + teamId);
        ToolExecuteResult membershipError = validateMembership(agentId, team);
        if (membershipError != null) return membershipError;

        return executeChild(toolExecution, argument, agent, team, workDir);
    }

    private static ToolExecuteResult validateArgument(CallSubAgentToolArgument argument) {
        if (argument.getAgentId() == null) return ToolExecuteResult.err("未说明唤醒的Agent角色信息");
        if (argument.getTask() == null || argument.getTask().isBlank()) {
            return ToolExecuteResult.err("未说明需要委派的具体任务");
        }
        return null;
    }

    private static String resolveWorkDir(CallSubAgentToolArgument argument, ToolExecution toolExecution) {
        String workDir = argument.getWorkDir();
        return workDir == null || workDir.isBlank() ? toolExecution.getWorkspace().workDir() : workDir;
    }

    private static ToolExecuteResult validateMembership(Long agentId, TeamVO team) {
        if (Objects.equals(agentId, team.getCommanderAgentId())) {
            return ToolExecuteResult.err("不能委派任务给自己");
        }
        boolean memberExists = team.getAgents() != null && team.getAgents().stream()
                .anyMatch(agent -> agent != null && Objects.equals(agent.getId(), agentId));
        return memberExists ? null : ToolExecuteResult.err("指定的团队中不包含该Agent: " + agentId);
    }

    private ToolExecuteResult executeChild(ToolExecution toolExecution, CallSubAgentToolArgument argument,
                                           AgentVO agent, TeamVO team, String workDir) {
        Long rootSessionId = sessionIdOf(toolExecution);

        String subSessionId = String.valueOf(IdUtil.getSnowflakeNextId());

        Long numericSubSessionId = Long.valueOf(subSessionId);

        Long parentWorkspaceId = rootSessionId == null ? null
                : sessionRepository.findById(rootSessionId)
                .map(Session::getWorkspaceId)
                .orElse(null);

        AgentRequest request = buildRequest(argument, agent, team, toolExecution, workDir, subSessionId,
                parentWorkspaceId);

        argument.setSubSessionId(subSessionId);

        if (!sessionExecutionRegistry.registerChild(rootSessionId, numericSubSessionId, Thread.currentThread())) {
            return ToolExecuteResult.err("主会话已停止，取消启动子Agent");
        }
        try {
            registerSubSession(numericSubSessionId, rootSessionId, parentWorkspaceId, agent, argument.getTask());

            subAgentSessionEventPublisher.publish(toolExecution.getTurnId(), rootSessionId, subSessionId,
                    agent.getId(), argument.getTask(), toolExecution.getId());

            transcriptService.appendUser(numericSubSessionId, UserMessageEntity.from(argument.getTask()));

            Execution execution = SessionContextEntity.runWithSubSession(rootSessionId, agent.getId(),
                    () -> subAgent.execute(request));

            modelContextService.replace(numericSubSessionId, execution.getMessages());

            return ToolExecuteResult.success(resolveRes(execution));
        } finally {
            sessionExecutionRegistry.unregisterChild(rootSessionId, numericSubSessionId);
        }
    }

    private String resolveRes(Execution execute) {
        if (execute == null) return "agent的任务未能执行成功: 未返回执行结果";
        if (ExecutionState.COMPLETED.equals(execute.getExecutionState())) {
            List<Message> messages = execute.getMessages();
            if (messages == null || messages.isEmpty()) return "agent已完成任务，但未返回文本结果";

            for (int i = messages.size() - 1; i >= 0; i--) {
                if (messages.get(i) instanceof AiMessageEntity aiMessageEntity) {
                    return aiMessageEntity.text();
                }
            }
            return messages.getLast().text();
        }
        return Objects.toString(execute.getErrorMessage(), "agent的任务未能执行成功: " + execute.getAgentRequest().getTask());
    }

    /** 子 Agent 必须显式绑定模型，不继承父任务或单例设置中的模型。 */
    private ModelConfig resolveChildModel(Long childModelId) {
        if (childModelId == null) throw new ClientException("子 Agent 未配置模型，请先为该 Agent 绑定模型");
        SettingsView settings = settingsProvider.current().orElse(null);
        return modelService.runtimeConfig(childModelId, settings);
    }
    private AgentRequest buildRequest(CallSubAgentToolArgument callSubAgentToolArgument,
                                      AgentVO subAgent,
                                      TeamVO team,
                                      ToolExecution toolExecution,
                                      String workDir, String subSessionId, Long parentWorkspaceId) {
        ModelConfig childModel = resolveChildModel(subAgent.getModelId());
        Workspace parentWorkspace = toolExecution == null ? null : toolExecution.getWorkspace();
        WorkspaceSpec workspaceSpec = resolveWorkspaceSpec(workDir, parentWorkspace, parentWorkspaceId);
        if (parentWorkspace != null && workspaceSpec == null)
            throw new IllegalStateException("Cannot recover child workspace without a WorkspaceSpec: " + workDir);

        String task = callSubAgentToolArgument.getTask();
        AgentRequest.AgentRequestBuilder builder = AgentRequest.builder();
        if (workspaceSpec != null) builder.workspaceSpec(workspaceSpec);


        Objects.requireNonNull(toolExecution);
        return builder
                .messages(List.of(UserMessageEntity.from(task)))
                .modelConfig(childModel)
                .executionId(String.valueOf(IdUtil.getSnowflakeNextId()))
                .runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(childAttributes(subAgent, toolExecution, subSessionId))
                        .build())
                .systemPrompt(buildSubAgentPrompt(subAgent, team, callSubAgentToolArgument.getPrompt()))
                .toolList(memberTools(subAgent.getToolList()))
                .task(task)
                .build();

    }

    /**
     * 子执行的受控属性。
     *
     * <p>{@code TEAM_ID} <b>随委派一并下行</b>：团队成员现在也有 {@code send_mail_to_agent}，
     * 而发信要带上本次协作轮次的团队快照；不下行，成员发出的信就丢了团队归属。父执行没有该属性时
     * 不写入，不凭空制造团队身份。</p>
     *
     * <p>注意：子执行拿到 {@code TEAM_ID} 之后，「靠属性缺失拦住二次委派」这层保险就不存在了 ——
     * 真正的守卫是 {@link #memberTools} 把 {@code call_sub_agent} 从子执行工具清单里剔除。</p>
     */
    private Map<String, Object> childAttributes(AgentVO subAgent, ToolExecution toolExecution, String subSessionId) {
        Map<String, Object> attributes = new HashMap<>();
        attributes.put(ExecutionAttributes.SESSION_ID, subSessionId);
        attributes.put(ExecutionAttributes.AGENT_ID, subAgent.getId().toString());
        attributes.put(ExecutionAttributes.ROOT_EXECUTION_ID, toolExecution.getExecutionId());
        Long teamId = ExecutionAttributes.readLong(toolExecution.getAttributes(), ExecutionAttributes.TEAM_ID);
        if (teamId != null) {
            attributes.put(ExecutionAttributes.TEAM_ID, teamId.toString());
        }
        return Map.copyOf(attributes);
    }

    /**
     * 为子执行解析可用的 {@link WorkspaceSpec}。
     *
     * <p>优先按模型显式给出的 {@code workDir} 精确回查已登记工作空间（local 模式下 workDir 即宿主目录，
     * 可命中）。<b>缺陷B根因</b>：sandbox 模式下模型回传的 workDir 是「容器内路径」（如 {@code /t05_ws}），
     * 与 {@code workspace.host_dir}（宿主绝对路径）永远不相等，{@code findByDir} 必然落空 ——
     * 原实现随即抛 {@code IllegalStateException}，委派必失败。这里补一条回落：父执行已有运行时工作空间时，
     * 改用父会话绑定的工作空间解析同源 spec，让子执行复用父工作空间。</p>
     *
     * <p>不做「放宽断言」式掩盖：只有当父执行确实没有工作空间（{@code parentWorkspace == null}）时，
     * 才返回 {@code null}（子执行无工作空间）；若有父工作空间却解析不出 spec，仍由 {@link #buildRequest}
     * 抛错，保证不静默放行一个没有工作空间的子执行。</p>
     */
    private WorkspaceSpec resolveWorkspaceSpec(String workDir,
                                               Workspace parentWorkspace,
                                               Long parentWorkspaceId) {
        if (workDir != null && !workDir.isBlank()) {
            WorkspaceVO workspace = workspaceService.findByDir(workDir).getData();
            if (workspace != null) {
                return workspaceConverter.toSpec(workspace, workspaceConverter.resolveType());
            }
        }
        if (parentWorkspace == null || parentWorkspaceId == null) {
            return null;
        }
        WorkspaceVO parent = workspaceService.findById(parentWorkspaceId).getData();
        return parent == null ? null : workspaceConverter.toSpec(parent, workspaceConverter.resolveType());
    }

    /**
     * 缺陷A：为本次委派补一条子会话 {@code session} 行。
     *
     * <p>此前子会话只存在于内存登记与 SSE 映射里，{@code session} 表没有对应行，导致
     * {@code GET /session/{id}/tree} 查不到子会话、级联删除漏删其消息 / 上下文 / 工具调用、
     * {@code root_session_id} 链路断裂。落库时机必须早于子会话第一条消息 / 上下文快照 ——
     * 消息必须挂在已存在的会话上。</p>
     */
    private void registerSubSession(Long subSessionId, Long rootSessionId, Long workspaceId,
                                    AgentVO agent, String task) {
        Session subSession = Session.builder()
                .id(subSessionId)
                .rootSessionId(rootSessionId == null ? Session.ROOT_SESSION_ID : rootSessionId)
                .workspaceId(workspaceId)
                .name(subSessionName(agent, task))
                .tokenUsage(TokenUsage.empty())
                .build();
        sessionRepository.saveAndReturnId(subSession);
    }

    /** 子会话名：优先取子代理名，其次退化为任务摘要；与根会话一致地截断到上限长度。 */
    private static String subSessionName(AgentVO agent, String task) {
        String base = agent != null && agent.getName() != null && !agent.getName().isBlank()
                ? agent.getName()
                : task;
        if (base == null || base.isBlank()) {
            return "子代理会话";
        }
        String normalized = base.strip().replaceAll("\\s+", " ");
        int end = normalized.offsetByCodePoints(0,
                Math.min(normalized.codePointCount(0, normalized.length()), Session.MAX_SESSION_NAME_LENGTH));
        return normalized.substring(0, end);
    }

    /**
     * 团队 ID 随 AgentRequest attributes 流动（框架序列化进执行快照，恢复后原样回来），
     * 这里从工具执行上下文读取；{@code toString} 转换兼容快照 JSON 往返后的 String/数值形态。
     */
    private Long resolveTeamId(ToolExecution toolExecution) {
        Map<String, Object> attributes = toolExecution == null ? null : toolExecution.getAttributes();
        return ExecutionAttributes.readLong(attributes, ExecutionAttributes.TEAM_ID);
    }

    /**
     * 团队成员的工具清单：剔除委派工具（{@code call_sub_agent} 只发生在指挥者这一层），
     * 并补上 {@code send_mail_to_agent} —— 成员要能和队友同步信息、反馈阻塞。
     *
     * <p>两个协作工具都不写进 Agent 配置，而是由委派方按角色显式授予，与指挥者侧的
     * {@code AgentWorkflowOrchestratorImpl#commanderTools} 对称。未配置清单的 Agent 原本
     * 一个工具都拿不到，这里同样至少给出发信能力，避免成员完全失联。</p>
     */
    private List<String> memberTools(List<String> configured) {
        List<String> tools = configured == null
                ? new ArrayList<>()
                : configured.stream()
                .filter(tool -> tool != null && !tool.isBlank())
                .map(String::trim)
                .filter(tool -> !ToolCatalog.CALL_SUB_AGENT.equals(tool))
                .distinct()
                .collect(Collectors.toCollection(ArrayList::new));
        if (!tools.contains(ToolCatalog.SEND_MAIL_TO_AGENT)) tools.add(ToolCatalog.SEND_MAIL_TO_AGENT);
        return tools;
    }


    /**
     * 子 Agent 的系统提示词：Agent 自身人设 + 团队协作话术（与指挥者共用同一份成员名单）
     * + 本次委派的上下文。
     */
    private String buildSubAgentPrompt(AgentVO agent, TeamVO team, String callerPrompt) {
        String role = TeamPromptComposer.memberPrompt(agent.getPrompt(),
                team == null ? null : team.getAgents(), agent.getId());
        return String.format("""
                %s
                
                # Commander 提供的任务上下文
                %s
                """, role, Objects.toString(callerPrompt, "").trim());
    }




    /**
     * 工具执行上下文里的会话 ID：委派工具由此得知自己属于哪个根会话。
     */
    private static Long sessionIdOf(ToolExecution toolExecution) {
        Serializable sessionId = toolExecution == null ? null : ExecutionIdentity.sessionId(toolExecution);
        if (sessionId == null) return null;
        try {
            return Long.valueOf(sessionId.toString());
        } catch (NumberFormatException e) {
            return null;
        }
    }

}
