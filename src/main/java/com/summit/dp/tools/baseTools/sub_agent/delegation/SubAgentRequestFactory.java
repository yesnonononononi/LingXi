package com.summit.dp.tools.baseTools.sub_agent.delegation;

import cn.hutool.core.util.IdUtil;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.tool.ToolExecution;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.agent.infrastructure.workflow.TeamPromptComposer;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.shared.context.SettingsView;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.model.ToolCatalog;
import com.summit.dp.shared.settings.SettingsProvider;
import com.summit.dp.shared.vo.WorkspaceVO;
import com.summit.dp.team.application.vo.TeamVO;
import com.summit.dp.tools.baseTools.arguments.CallSubAgentToolArgument;
import com.summit.dp.workspace.application.convert.WorkspaceConverter;
import com.summit.dp.workspace.application.service.WorkspaceService;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Collectors;

/**
 * 把一次委派组装成子执行可用的 {@link AgentRequest}。
 *
 * <p>这里是「成员版上下文」的唯一落点：模型、工作空间、受控属性、系统提示词、工具清单。
 * 四个部分拼错任一个，子 Agent 要么起不来（缺模型 / 缺工作空间），要么越权（拿到
 * {@code call_sub_agent}），要么「失忆」（历史没交出去）。</p>
 */
@Component
@RequiredArgsConstructor
public class SubAgentRequestFactory {

    private final WorkspaceService workspaceService;
    private final ModelService modelService;
    private final SettingsProvider settingsProvider;
    private final WorkspaceConverter workspaceConverter;

    /**
     * 组装子执行请求。
     *
     * @param argument          模型给出的委派参数
     * @param subAgent          目标 Agent
     * @param team              协作团队（决定成员名单与可委派队友）
     * @param toolExecution     本次工具执行上下文（给出父工作空间与执行 ID）
     * @param workDir           模型显式指定的工作目录，可为 null
     * @param subSessionId      已确定的子会话 id（复用或派生），写入执行属性
     * @param parentWorkspaceId 父会话绑定的工作空间 id，用于 workDir 落空时的回落
     * @param priorMessages     复用子会话时的既有历史；首次委派为空列表
     */
    public AgentRequest build(CallSubAgentToolArgument argument,
                              AgentVO subAgent,
                              TeamVO team,
                              ToolExecution toolExecution,
                              String workDir,
                              String subSessionId,
                              Long parentWorkspaceId,
                              List<Message> priorMessages) {
        ModelConfig childModel = resolveChildModel(subAgent.getModelId());
        Workspace parentWorkspace = toolExecution == null ? null : toolExecution.getWorkspace();
        WorkspaceSpec workspaceSpec = resolveWorkspaceSpec(workDir, parentWorkspace, parentWorkspaceId);
        if (parentWorkspace != null && workspaceSpec == null) {
            throw new IllegalStateException("Cannot recover child workspace without a WorkspaceSpec: " + workDir);
        }

        String task = argument.getTask();
        AgentRequest.AgentRequestBuilder builder = AgentRequest.builder();
        if (workspaceSpec != null) {
            builder.workspaceSpec(workspaceSpec);
        }

        Objects.requireNonNull(toolExecution);
        return builder
                .messages(contextOf(priorMessages, task))
                .modelConfig(childModel)
                .executionId(String.valueOf(IdUtil.getSnowflakeNextId()))
                .runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(childAttributes(subAgent, toolExecution, subSessionId))
                        .build())
                .systemPrompt(buildSubAgentPrompt(subAgent, team, argument.getPrompt()))
                .toolList(memberTools(subAgent.getToolList()))
                // 桥接框架侧 API 演进：task 由 String 改为 List<String>（逐段提示）
                .task(List.of(task))
                .build();
    }

    /**
     * 本次执行的完整上下文快照：复用子会话时为「既有历史 + 本次任务」，首次委派时只有本次任务。
     *
     * <p>框架约定 {@code AgentRequest.messages} 是执行期对话历史的唯一来源（运行时不按 id 回读），
     * 因此复用必须在这里把历史显式交出去；否则子 Agent 会「接着聊」却看不到之前聊过什么。</p>
     */
    private static List<Message> contextOf(List<Message> priorMessages, String task) {
        UserMessageEntity current = UserMessageEntity.from(task);
        if (priorMessages == null || priorMessages.isEmpty()) {
            return List.of(current);
        }
        List<Message> context = new ArrayList<>(priorMessages);
        context.add(current);
        return context;
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
     * 才返回 {@code null}（子执行无工作空间）；若有父工作空间却解析不出 spec，仍由 {@link #build}
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

    /** 子 Agent 必须显式绑定模型，不继承父任务或单例设置中的模型。 */
    private ModelConfig resolveChildModel(Long childModelId) {
        if (childModelId == null) {
            throw new ClientException("子 Agent 未配置模型，请先为该 Agent 绑定模型");
        }
        SettingsView settings = settingsProvider.current().orElse(null);
        return modelService.runtimeConfig(childModelId, settings);
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
        if (!tools.contains(ToolCatalog.SEND_MAIL_TO_AGENT)) {
            tools.add(ToolCatalog.SEND_MAIL_TO_AGENT);
        }
        return tools;
    }

    /**
     * 子 Agent 的系统提示词：Agent 自身人设 + 团队协作话术（与指挥者共用同一份成员名单）
     * + 本次委派的上下文。
     */
    private String buildSubAgentPrompt(AgentVO agent, TeamVO team, String callerPrompt) {
        String role = TeamPromptComposer.memberPrompt(
                agent.getPrompt(),
                team == null ? null : team.getAgents(),
                agent.getId(),
                team == null ? null : team.getDescription()
        );
        return String.format("""
                %s
                
                # Commander 提供的任务上下文
                %s
                """, role, Objects.toString(callerPrompt, "").trim());
    }
}
