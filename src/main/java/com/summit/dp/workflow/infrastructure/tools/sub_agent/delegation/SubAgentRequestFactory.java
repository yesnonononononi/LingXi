package com.summit.dp.workflow.infrastructure.tools.sub_agent.delegation;

import cn.hutool.core.util.IdUtil;
import com.summit.core.agent.AgentRequest;
import com.summit.core.conf.ModelRetryConfig;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.conf.SkillConfig;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.RuntimeEnvironment;
import com.summit.core.tool.ToolExecution;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.shared.model.WorkspaceType;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.workflow.application.chat.BusinessSystemPromptBuilder;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.application.service.RuntimeConfigurationService;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.user_configs.application.vo.SettingsView;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.user_configs.application.service.SettingsProvider;
import com.summit.dp.workflow.infrastructure.policy.SkillRootResolver;
import com.summit.dp.shared.vo.WorkspaceVO;
import com.summit.dp.team.application.vo.TeamVO;
import com.summit.dp.workflow.infrastructure.tools.arguments.CallSubAgentToolArgument;
import com.summit.dp.tools.application.service.ToolListProcessor;
import com.summit.dp.tools.application.service.ToolProcessingContext;
import com.summit.dp.model.application.vo.RuntimeModel;
import com.summit.dp.workspace.application.convert.WorkspaceConverter;
import com.summit.dp.workspace.application.service.WorkspaceService;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

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
    /** Skill 根目录：子执行的 skillConfig 与 read_skill 都由它决定是否下发。 */
    private final SkillRootResolver skillRootResolver;
    private final BusinessSystemPromptBuilder systemPromptBuilder;
    private final ToolListProcessor toolListProcessor;
    private final RuntimeConfigurationService runtimeConfigurations;

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
        RuntimeModel childModel = resolveChildModel(subAgent);

        Workspace parentWorkspace = toolExecution == null ? null : toolExecution.getWorkspace();

        AgentAccessMode accessMode = AgentAccessMode.from(toolExecution == null ? null : toolExecution.getAttributes());

        WorkspaceSpec workspaceSpec = resolveWorkspaceSpec(workDir, parentWorkspace, parentWorkspaceId, accessMode);

        if (parentWorkspace != null && workspaceSpec == null) {
            throw new IllegalStateException("子执行缺少工作区配置，无法恢复工作目录: " + workDir);
        }

        String task = argument.getTask();

        AgentRequest.AgentRequestBuilder builder = AgentRequest.builder();

        if (workspaceSpec != null) {
            builder.workspaceSpec(workspaceSpec);
        }

        // Skill 能力随委派下行：框架按请求级 skillConfig 渲染 Skill 提示词，read_skill 也按它做
        Path skillRoot = skillRootResolver.root();

        Objects.requireNonNull(toolExecution);
        return builder
                .messages(buildContext(priorMessages, task))
                .modelConfigSpec(runtimeConfigurations.freezeModel(subAgent.getModelId(), childModel.config()))
                .retryConfig(ModelRetryConfig.builder().enabled(true).build())
                .executionId(String.valueOf(IdUtil.getSnowflakeNextId()))
                .runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(childAttributes(subAgent, toolExecution, subSessionId, childModel))
                        .build())
                .systemPrompt(systemPromptBuilder.buildMemberPrompt(subAgent, team, argument.getPrompt()))
                .toolList(toolListProcessor.process(subAgent.getToolList(), ToolProcessingContext.builder()
                        .member(true).agentId(subAgent.getId())
                        .teamId(ExecutionAttributes.readLong(toolExecution.getAttributes(), ExecutionAttributes.TEAM_ID))
                        .vision(childModel.vision()).accessMode(accessMode).skillRoot(skillRoot).build()))
                .skillConfig(skillRoot == null ? null : new SkillConfig(skillRoot))
                .task(List.of(task))
                .build();
    }

    /**
     * 本次执行的完整上下文快照：复用子会话时为「既有历史 + 本次任务」，首次委派时只有本次任务。
     *
     * <p>框架约定 {@code AgentRequest.messages} 是执行期对话历史的唯一来源（运行时不按 id 回读），
     * 因此复用必须在这里把历史显式交出去；否则子 Agent 会「接着聊」却看不到之前聊过什么。</p>
     */
    private static List<Message> buildContext(List<Message> priorMessages, String task) {
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
     * <p>{@code ROOT_SESSION_ID} 也随委派下行：邮箱业务键是协作根会话 id，子执行发信 / 收信都靠它
     * 算出与根同一把邮箱键。与会话表回查相比，属性下行免去拦截器里的 SessionRepository IO。</p>
     *
     * <p>注意：子执行拿到 {@code TEAM_ID} 之后，「靠属性缺失拦住二次委派」这层保险就不存在了 ——
     * 真正的守卫是工具加工层把 {@code call_sub_agent} 从子执行工具清单里剔除。</p>
     */
    private Map<String, Object> childAttributes(AgentVO subAgent, ToolExecution toolExecution, String subSessionId,
                                               RuntimeModel childModel) {
        Map<String, Object> attributes = new HashMap<>(AgentAccessMode.toAttributes(AgentAccessMode.from(toolExecution.getAttributes())));

        attributes.put(ExecutionAttributes.SESSION_ID, subSessionId);
        attributes.put(ExecutionAttributes.MODEL_VISION, childModel.vision());

        attributes.put(ExecutionAttributes.AGENT_ID, subAgent.getId().toString());

        attributes.put(ExecutionAttributes.ROOT_EXECUTION_ID, toolExecution.getExecutionId());

        Long rootSessionId = ExecutionAttributes.readLong(toolExecution.getAttributes(), ExecutionAttributes.SESSION_ID);

        if (rootSessionId != null) {
            attributes.put(ExecutionAttributes.ROOT_SESSION_ID, rootSessionId.toString());
        }

        Long teamId = ExecutionAttributes.readLong(toolExecution.getAttributes(), ExecutionAttributes.TEAM_ID);

        if (teamId != null) {
            attributes.put(ExecutionAttributes.TEAM_ID, teamId.toString());
        }

        return Map.copyOf(attributes);
    }

    /**
     * 为子执行解析可用的 {@link WorkspaceSpec}。
     *
     * 优先匹配登记目录，未匹配时沿用父工作空间；访问档位继承父请求快照，避免委派时放宽权限。
     */
    private WorkspaceSpec resolveWorkspaceSpec(String workDir,
                                               Workspace parentWorkspace,
                                               Long parentWorkspaceId,
                                               AgentAccessMode accessMode
    ) {
        RuntimeEnvironment parentEnvironment = parentWorkspace == null ? null : parentWorkspace.runtimeEnvironment();
        // 已开始的执行沿用父环境，设置页切换运行类型不能把子执行带出父沙箱。
        WorkspaceType type = parentEnvironment == null ? workspaceConverter.resolveType()
                : parentEnvironment.isolated() ? WorkspaceType.SAND_BOX : WorkspaceType.LOCAL;
        if (workDir != null && !workDir.isBlank()) {
            WorkspaceVO workspace = workspaceService.findByDir(workDir).getData();
            if (workspace != null) {
                return workspaceConverter.toSpec(workspace, type, accessMode);
            }
        }
        if (parentWorkspace == null || parentWorkspaceId == null) {
            return null;
        }
        WorkspaceVO parent = workspaceService.findById(parentWorkspaceId).getData();
        return parent == null ? null : workspaceConverter.toSpec(parent, type, accessMode);
    }

    /** 子模型不继承父配置；预设不可用时保留成员名与业务原因，方便定位。 */
    private RuntimeModel resolveChildModel(AgentVO subAgent) {
        Long childModelId = subAgent == null ? null : subAgent.getModelId();
        if (childModelId == null) {
            throw new ClientException("子 Agent 未配置模型，请先为该 Agent 绑定模型");
        }
        SettingsView settings = settingsProvider.current().orElse(null);
        try {
            return modelService.resolveRuntimeConfig(childModelId, settings);
        } catch (ClientException e) {
            throw new ClientException("子 Agent「" + subAgent.getName()
                    + "」绑定的模型不可用，请检查预设是否已被删除或连接配置是否完整: " + e.getMessage());
        }
    }

}
