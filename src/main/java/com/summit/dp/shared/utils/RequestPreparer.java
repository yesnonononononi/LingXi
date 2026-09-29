package com.summit.dp.shared.utils;

import cn.hutool.core.codec.Base64;
import cn.hutool.core.util.IdUtil;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Image;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.command.ChatCommand;
import com.summit.dp.agent.application.service.AgentService;
import com.summit.dp.agent.application.service.impl.RuntimeContext;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.mcp.application.service.McpService;
import com.summit.dp.shared.model.ToolCatalog;
import com.summit.dp.model.application.service.ModelService;
import com.summit.core.conf.McpConfig;
import com.summit.core.conf.ModelConfig;
import com.summit.dp.shared.settings.SettingsProvider;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.session.application.service.ConversationTranscriptService;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.application.service.SessionService;
import com.summit.dp.shared.config.workflow.AgentAccessMode;
import com.summit.dp.shared.config.workflow.CommandApprovalPolicy;
import com.summit.dp.shared.context.ExecutionContext;
import com.summit.dp.shared.context.SettingsView;
import com.summit.dp.shared.model.WorkspaceType;
import com.summit.dp.shared.exception.AccessDeniedException;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.shared.vo.WorkspaceVO;
import com.summit.dp.team.application.service.TeamService;
import com.summit.dp.team.application.vo.TeamVO;
import com.summit.dp.workspace.application.convert.WorkspaceConverter;
import com.summit.dp.workspace.application.service.WorkspaceService;
import jakarta.annotation.Nullable;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.util.*;

/**
 * 聊天请求准备器：把一次 {@link ChatCommand} 解析成可直接执行的 {@link RuntimeContext}。
 *
 * <p><b>身份显式流动（HC-1）</b>：本类不读任何 ThreadLocal 身份；执行身份在 prepare 末尾
 * 固化为 {@link ExecutionContext}，随 RuntimeContext / attributes 显式下行，
 * 在异步线程与子 Agent 线程上同样有效。</p>
 *
 * <p><b>档位与模型缺省</b>：本地单实例下统一取自 {@link SettingsProvider}（user_configs 单例行），
 * 不再有「当前用户的配置」这一维度。Agent 绑定与模型回落在本类内完成（team → 指挥者；
 * 单 Agent → 显式请求或单例设置；
 * model → agent 配置 → 单例设置），编排器拿到的是已生效的上下文。</p>
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class RequestPreparer {

    private final SessionService sessionService;
    private final WorkspaceService workspaceService;
    private final ModelService modelService;
    private final WorkspaceConverter workspaceConverter;
    private final SettingsProvider settingsProvider;
    private final ToolCatalog toolCatalog;
    private final ConversationTranscriptService transcriptService;
    private final ModelContextService modelContextService;
    private final ExecutionIdentity executionIdentity;
    private final AgentService agentService;
    private final TeamService teamService;
    private final McpService mcpService;

    @Value("${lingxi.system-prompt:}")
    private String SYSTEM_PROMPT;

    /**
     * 解析本轮生效的模型：显式 modelId → 单例设置 {@code user_configs.model_id} → 无则报错。
     *
     * <p>{@code lingxi.agent.model.conf.*} 已归框架侧（生产 {@code chatModelConfig} 等 bean），
     * 业务侧不再读取，因此取消 YAML 兜底分支。</p>
     */
    private ModelConfig rootModel(Long modelId, SettingsView settings) {
        Long selected = modelId != null ? modelId : settings == null ? null : settings.modelId();
        if (selected != null) return modelService.runtimeConfig(selected, settings);
        throw new ClientException("未配置可用的模型连接");
    }

    public RuntimeContext prepare(ChatCommand command) {
        if (command == null || command.input() == null || command.input().isBlank()) {
            throw new ClientException("聊天内容不能为空");
        }

        // 单例设置：档位与模型缺省的唯一来源；查询失败按无设置处理（各项走各自缺省）。
        SettingsView settings = settingsProvider.current().orElse(null);

        // 会话自带 workspaceId / teamId：创建后不可变，这里只读取，不回写（见 bindWorkspace 的封闭说明）。
        SessionVO session = requireSession(command.sessionId());

        // 团队绑定的有效值：新会话取请求值（也是唯一写入时机）；已有会话一律以库中记录为准，
        // 忽略请求带来的 teamId——否则调用方可以在后续轮次把会话改绑到另一个团队。
        Long effectiveTeamId = session == null ? command.teamId() : session.getTeamId();

        // 绑定执行身份并回落模型：team → 指挥者；model → agent 配置 → 单例设置。
        ChatCommand effective = effectiveCommand(command, settings, effectiveTeamId);

        Long workspaceId;
        if (session == null) {
            // 唯一允许建立绑定的时机：会话还不存在，此刻由请求指定工作空间与团队。
            workspaceId = effective.workspaceId();
            Result<Long> initializeRes = sessionService.initialize(effective.input(), workspaceId,
                    effectiveTeamId);
            Long sessionId = initializeRes.getData();
            if (sessionId == null)
                throw new ClientException(Objects.toString(initializeRes.getErrMsg(), "会话初始化失败"));
            session = sessionService.findById(sessionId).getData();
        } else {
            // 已有会话一律以库中记录为准，忽略请求带来的 workspaceId：
            // 否则调用方可以在后续轮次把会话引到另一个宿主机目录去执行。
            workspaceId = session.getWorkspaceId();
        }

        WorkspaceVO workspace = workspaceId == null ? null : requireWorkspace(workspaceId);

        // 运行类型来自单例设置（不落 workspace 行）；会话无工作空间时无可执行目录。
        WorkspaceType workspaceType = workspace == null
                ? WorkspaceType.NONE
                : workspaceConverter.resolveType();
        WorkspaceSpec spec = workspaceConverter.toSpec(workspace, workspaceType);

        AgentAccessMode mode = AgentAccessMode.effective(
                settings == null ? null : settings.accessMode(), workspaceType);

        CommandApprovalPolicy policy = CommandApprovalPolicy.parse(
                settings == null ? null : settings.commandApprovalPolicy());

        // Model context is mutable and may already be compressed. A missing snapshot means a new
        // context; the append-only transcript is display data and is never fed back to the model.
        UserMessageEntity userMessageEntity = buildUserMessage(effective);
        Long preparedSessionId = session.getId();
        List<Message> messageList = modelContextService.find(preparedSessionId)
                .map(ArrayList::new)
                .orElseGet(ArrayList::new);
        transcriptService.appendUser(preparedSessionId, userMessageEntity);
        messageList.add(userMessageEntity);

        // 执行身份在此固化：prepare 阶段 executionId 尚未生成（null），buildRequest 里补齐（HC-2）。
        ExecutionContext executionContext = ExecutionContext.root(
                preparedSessionId, null, workspaceId, effective.modelId(), mode, policy);

        return new RuntimeContext(
                executionContext,
                effective.agentId(),
                // 团队模式标识用会话级有效值：已有团队会话即使请求不带 teamId 也照常按团队编排
                // （子代理委派赖以解析的 lingxi.team_id 因此在新执行快照中不缺）。
                effectiveTeamId,
                session,
                messageList,
                spec,
                // 根任务保留显式模型、设置模型和 YAML 缺省的优先级。
                rootModel(effective.modelId(), settings),
                mode,
                policy,
                effective.requirePlan()
        );
    }

    /**
     * 绑定有效 Agent 并回落模型：
     * <ul>
     *   <li>team 模式（有效团队非空且未显式指定 agent）：会话与执行都挂在指挥者名下，与首轮行为一致。
     *       入参是会话级有效 teamId——新会话等于请求值，已有会话来自库中绑定，
     *       因此「二次进入团队会话不带 teamId」也走同一条指挥者回落链路；</li>
     *   <li>modelId 未指定：按「Agent 自带模型 → 单例设置」逐级回落，仍为 null 时
     *       由模型查询自行报错（与旧行为一致）。</li>
     * </ul>
     */
    private ChatCommand effectiveCommand(ChatCommand command, SettingsView settings, Long effectiveTeamId) {
        Long agentId = command.agentId();
        if (agentId == null && effectiveTeamId != null) {
            TeamVO team = teamService.findById(effectiveTeamId).getData();
            if (team == null) throw new ClientException("未找到指定的团队: " + effectiveTeamId);
            agentId = team.getCommanderAgentId();
        } else if (agentId == null && settings != null) {
            agentId = settings.agentId();
        }
        Long modelId = command.modelId();
        if (modelId == null && agentId != null) {
            AgentVO agent = agentService.findById(agentId).getData();
            if (agent != null) modelId = agent.getModelId();
        }
        if (modelId == null && settings != null) {
            modelId = settings.modelId();
        }
        if (Objects.equals(agentId, command.agentId()) && Objects.equals(modelId, command.modelId())) {
            return command;
        }
        return new ChatCommand(command.input(), command.sessionId(), modelId, command.workspaceId(),
                command.teamId(), agentId, command.requirePlan(), command.imageFile(), command.imageUrl());
    }

    /**
     * 取会话；{@code sessionId} 为空表示「本次对话还没有会话」，由 {@link #prepare} 走创建分支，
     * 属于正常路径。非空但取不到（不存在）必须拒绝。
     */
    public SessionVO requireSession(Long sessionId) {
        if (sessionId == null) return null;
        SessionVO session = sessionService.findById(sessionId).getData();
        if (session == null) throw new AccessDeniedException("会话不存在: " + sessionId);
        return session;
    }

    /** 取工作空间；不存在时拒绝。 */
    public @Nullable WorkspaceVO requireWorkspace(Long workspaceId) {
        if (workspaceId == null) return null;
        WorkspaceVO workspace = workspaceService.findById(workspaceId).getData();
        if (workspace == null) throw new AccessDeniedException("工作空间不存在: " + workspaceId);
        return workspace;
    }

    public AgentRequest buildRequest(String agentPrompt, RuntimeContext context, List<String> toolList) {
        String executionId = String.valueOf(IdUtil.getSnowflakeNextId());
        // 执行身份此刻才完整：把 executionId 补进上下文再随 attributes 下行（HC-2 执行链身份闭环）。
        ExecutionContext executionContext = context.executionContext().withExecutionId(executionId);

        // 请求级 MCP：每次执行重新读库组装，管理端改动下一轮即生效。
        // 无启用服务时为 null，框架侧按「无 MCP」处理，仍走 McpToolScope.EMPTY。
        McpConfig mcpConfig = mcpService.currentConfig();

        return AgentRequest
                .builder()
                .executionId(executionId)
                .messages(context.messageList())
                .systemPrompt(mergeSystemPrompt(agentPrompt))
                .workspaceSpec(context.workspace())
                .toolList(toolListOf(toolList, context, mcpConfig))
                .modelConfig(context.modelConfig())
                .mcpConfig(mcpConfig)
                .runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(attributes(executionContext, context))
                        .build())
                .build();
    }

    public UserMessageEntity buildUserMessage(ChatCommand chatCommand) {
        String image = resolveImage(chatCommand.imageFile(), chatCommand.imageUrl());
        String input = chatCommand.input();
        boolean hasImage = image != null && !image.isEmpty();
        if (hasImage) {
            return UserMessageEntity.from(input, Image.from(image));
        }
        return UserMessageEntity.from(input);
    }


    private String resolveImage(MultipartFile image, String imageUrl) {
        if (image == null || image.isEmpty()) {
            return imageUrl == null || imageUrl.isBlank() ? null : imageUrl;
        }

        try {
            String contentType = image.getContentType();
            if (contentType == null || !contentType.startsWith("image/")) {
                throw new ClientException("只支持上传图片文件");
            }
            return Base64.encode(image.getBytes());
        } catch (IOException e) {
            log.error("Failed to encode image", e);
            throw new ClientException("读取上传图片失败");
        }
    }

    /**
     * 请求级工具白名单。
     *
     * <p>框架语义：名单即授权，{@code null} 与空清单等价，都表示不暴露任何静态工具 —— 模型能看到
     * 什么必须在这里显式写出，杜绝清单组装失败时静默放大为进程内全部能力。</p>
     *
     * <p>业务语义：带了 {@code mcpConfig} 就兜底 {@link ToolCatalog#SEARCH_TOOL}。MCP 工具名要等握手后
     * 才存在，无法预先进清单，但框架对本次 {@code McpToolScope} 内的工具一律放行（可见即可执行），
     * 检索工具正是模型发现它们的唯一途径。</p>
     *
     * <p>顺序固定为「收敛原清单 → 补检索入口与 requirePlan → 只读过滤 → 身份剔除」。只读滤网必须
     * 最后执行，否则 requirePlan 追加的工具会绕过滤网；它是剔除写工具而非替换成固定小集，依据
     * 取自注册表的只读标记。</p>
     */
    private List<String> toolListOf(List<String> tools, RuntimeContext context, McpConfig mcpConfig) {
        final boolean readOnly = !context.accessMode().allowsWriteTools();

        List<String> result = new ArrayList<>(tools == null ? List.of() : tools);

        // MCP 在场时兜底检索入口：MCP 工具只能靠它被发现。
        if (mcpConfigured(mcpConfig) && !result.contains(ToolCatalog.SEARCH_TOOL)) {
            result.add(ToolCatalog.SEARCH_TOOL);
        }

        if (context.requirePlan() && !result.contains(ToolCatalog.CREATE_PLAN)) {
            result.add(ToolCatalog.CREATE_PLAN);
        }

        // 只读滤网放最后：无论清单来自配置还是被 requirePlan 追加过，一律在此收口
        if (readOnly) {
            Set<String> permitted = toolCatalog.readOnlyNames();
            result.removeIf(name -> name == null || !permitted.contains(name.trim()));
        }
        return withoutUnusableCollaborationTools(result, context);
    }

    /** 本次请求是否声明了可用的 MCP 服务；空配置与无配置一视同仁。 */
    private static boolean mcpConfigured(McpConfig mcpConfig) {
        return mcpConfig != null && mcpConfig.getMcp() != null && !mcpConfig.getMcp().isEmpty();
    }

    /**
     * 剔除当前执行身份用不了的协作工具：{@code call_sub_agent} 需 TEAM_ID、{@code send_mail_to_agent}
     * 需 AGENT_ID，不满足时调用必然失败。与其让模型看到后在运行时收到「未绑定」报错、白白消耗轮次，
     * 不如直接从可见清单里去掉。
     */
    private List<String> withoutUnusableCollaborationTools(List<String> tools, RuntimeContext context) {
        if (tools == null || tools.isEmpty()) {
            return tools;
        }
        boolean teamBound = context.teamId() != null;
        boolean agentBound = context.agentId() != null;
        if (teamBound && agentBound) {
            return tools;
        }
        return tools.stream()
                .filter(name -> {
                    if (name == null) {
                        return false;
                    }
                    String trimmed = name.trim();
                    if (ToolCatalog.CALL_SUB_AGENT.equals(trimmed)) {
                        return teamBound;
                    }
                    if (ToolCatalog.SEND_MAIL_TO_AGENT.equals(trimmed)) {
                        return agentBound;
                    }
                    return true;
                })
                .toList();
    }


    /**
     * 随请求下行的不透明属性：框架只搬运，由业务侧的准入策略与循环钩子解释。
     *
     * <p>执行身份（SESSION_ID / ROOT_EXECUTION_ID / WORKSPACE_ID / MODEL_CONFIG_ID / 两个档位）
     * 统一来自 {@link ExecutionContext#toAttributes()}；这里只补充业务参数（AGENT_ID / TEAM_ID，
     * teamId 为 null 的 single/default 模式不携带）。命令批准仅由互动决策接口在恢复执行时授予。</p>
     */
    private Map<String, Object> attributes(ExecutionContext executionContext, RuntimeContext context) {
        Map<String, Object> attributes = new HashMap<>(executionContext.toAttributes());
        if (context.agentId() != null) {
            attributes.put(ExecutionAttributes.AGENT_ID, context.agentId().toString());
        }
        if (context.teamId() != null) {
            attributes.put(ExecutionAttributes.TEAM_ID, context.teamId().toString());
        }
        return Map.copyOf(attributes);
    }

    private String mergeSystemPrompt(String agentPrompt) {
        String globalPrompt = SYSTEM_PROMPT == null ? "" : SYSTEM_PROMPT.trim();
        String rolePrompt = agentPrompt == null ? "" : agentPrompt.trim();
        if (globalPrompt.isEmpty()) return rolePrompt;
        if (rolePrompt.isEmpty()) return globalPrompt;
        return globalPrompt + "\n\n" + rolePrompt;
    }
}
