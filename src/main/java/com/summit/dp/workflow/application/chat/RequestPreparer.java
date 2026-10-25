package com.summit.dp.workflow.application.chat;

import cn.hutool.core.util.IdUtil;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.application.service.RuntimeConfigurationService;
import com.summit.dp.personalization.application.convert.PersonalizationConvert;
import com.summit.dp.personalization.application.vo.PersonalizationVO;
import com.summit.dp.personalization.domain.repository.PersonalizationRepository;
import com.summit.dp.shared.local.LocalInstance;
import com.summit.dp.tools.application.service.ToolListProcessor;
import com.summit.dp.tools.application.service.ToolProcessingContext;
import com.summit.dp.model.application.vo.RuntimeModel;
import com.summit.dp.workflow.infrastructure.harness.ExecutionIdentity;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.core.agent.AgentRequest;
import com.summit.core.conf.ModelRetryConfig;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Image;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.service.AgentService;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.mcp.application.service.McpService;
import com.summit.dp.model.domain.ModelNoFoundException;
import com.summit.dp.model.application.service.ModelService;
import com.summit.core.conf.McpConfig;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conf.SkillConfig;
import com.summit.dp.user_configs.application.service.SettingsProvider;
import com.summit.dp.workflow.infrastructure.policy.SkillRootResolver;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.session.application.service.ConversationTranscriptService;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.application.service.SessionService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import com.summit.dp.user_configs.application.policy.CommandApprovalPolicy;
import com.summit.dp.user_configs.application.vo.SettingsView;
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
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.nio.file.Path;
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
 * 单 Agent → 显式请求或单例设置；model：协作模式强制指挥者预设，单 Agent 直聊由其预设驱动
 * 且硬校验、显式请求可覆盖，未指定 Agent 的非协作会话走单例设置），编排器拿到的是已生效的上下文。</p>
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class RequestPreparer {

    private final SessionService sessionService;
    private final SessionRepository sessionRepository;
    private final WorkspaceService workspaceService;
    private final ModelService modelService;
    private final WorkspaceConverter workspaceConverter;
    private final SettingsProvider settingsProvider;
    private final ToolListProcessor toolListProcessor;
    private final ConversationTranscriptService transcriptService;
    private final ModelContextService modelContextService;
    private final ChatTurnService chatTurnService;
    private final AgentService agentService;
    private final TeamService teamService;
    private final McpService mcpService;
    /** Skill 根目录（框架按它渲染 Skill 提示词、read_skill 也按它做越界校验）。 */
    private final SkillRootResolver skillRootResolver;
    private final ChatImageResolver chatImageResolver;

    private final BusinessSystemPromptBuilder systemPromptBuilder;
    private final PersonalizationRepository personalizationRepository;
    private final RuntimeConfigurationService runtimeConfigurations;

    /**
     * 解析本轮生效的模型：显式 modelId → 单例设置 {@code user_configs.model_id} → 无则报错。
     *
     * <p>{@code lingxi.agent.model.conf.*} 已归框架侧（生产 {@code chatModelConfig} 等 bean），
     * 业务侧不再读取，因此取消 YAML 兜底分支。</p>
     */
    private RuntimeModel rootModel(Long modelId, SettingsView settings) {
        Long selected = modelId != null ? modelId : settings == null ? null : settings.modelId();
        if (selected != null) return modelService.resolveRuntimeConfig(selected, settings);
        throw new ClientException("未配置可用的模型连接");
    }

    /**
     * 解析一次聊天请求：会话（必要时新建）、工作空间、档位、模型、执行身份与模型上下文。
     *
     * <p><b>本方法不写任何「请求已被接受」的消息副作用</b>（2026-09-30 改造）：用户消息只在
     * {@link #commitUserMessage(RuntimeContext)} 里落库，由调用方在取得会话运行资格之后调用。
     * 否则并发请求会在被单飞校验拒绝之前先把用户消息写进历史，留下「有提问、无执行、无错误」的孤行。</p>
     *
     * <p>执行身份（{@code executionId}）在本方法内生成并固化进 {@link RuntimeContext}，
     * 后续 {@link #buildRequest} 直接复用，不再另生成。</p>
     */
    public RuntimeContext prepare(ChatCommand command) {
        return resolve(command, null);
    }

    /**
     * 重发准备：与 {@link #prepare} 同一条解析链路，只是模型上下文由调用方给定。
     *
     * <p>重发要复现「目标轮次当时看到的上下文」，而会话当前上下文里还带着即将被回滚掉的尾部。
     * 会话必须已存在 —— 重发是对一条历史提问的重做，不建会话。</p>
     *
     * @param baseline 目标轮次之前的历史上下文（由执行快照截断得到），新提问接在它之后
     */
    public RuntimeContext prepareForResend(ChatCommand command, List<Message> baseline) {
        throwIf(command == null || command.sessionId() == null, "重发必须指定会话");
        return resolve(command, baseline);
    }

    private RuntimeContext resolve(ChatCommand command, List<Message> baseline) {
        throwIf(command == null || command.input() == null || command.input().isBlank(), "聊天内容不能为空");
        UserMessageEntity userMessageEntity = buildUserMessage(command);

        // 单例设置：档位与模型缺省的唯一来源；查询失败按无设置处理（各项走各自缺省）。
        SettingsView settings = settingsProvider.current().orElse(null);

        // 会话自带 workspaceId / teamId：workspaceId 创建后不可变（改写会把会话引到另一个宿主机目录），
        // teamId 可变但只经 /session/{id}/team 变更 —— 两条路径都只读取，聊天请求不回写。
        SessionVO session = requireSession(command.sessionId());

        // 新会话（session == null）此刻还没有绑定，由前端在建会话时或随后经 /session/{id}/team 写入。
        Long effectiveTeamId = session == null ? null : session.getTeamId();

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
        AgentAccessMode mode = AgentAccessMode.parse(settings == null ? null : settings.accessMode());
        WorkspaceSpec spec = workspaceConverter.toSpec(workspace, workspaceType, mode);

        CommandApprovalPolicy policy = CommandApprovalPolicy.parse(
                settings == null ? null : settings.commandApprovalPolicy());

        // 模型上下文是可变的、也可能已被压缩；查不到上下文即视为新会话。
        // 只有展示用的 transcript 是只追加的，它任何时候都不会回喂给模型。
        Long preparedSessionId = session.getId();
        // 重发：基线来自目标轮次的历史快照；常规请求：基线来自当前模型上下文。
        List<Message> messageList = baseline != null
                ? new ArrayList<>(baseline)
                : modelContextService.find(preparedSessionId).map(ArrayList::new).orElseGet(ArrayList::new);
        messageList.add(userMessageEntity);

        // 执行身份在 prepare 内就固化（而不是等 buildRequest）：
        // 这样「用户消息落库」与「执行记录」从第一刻起共享同一个 executionId，
        // 历史接口才能按它把这一轮的消息与统计装配到一起。
        String executionId = String.valueOf(IdUtil.getSnowflakeNextId());
        ExecutionContext executionContext = ExecutionContext.root(
                preparedSessionId, executionId, workspaceId, effective.modelId(), mode, policy);

        RuntimeModel runtimeModel = rootModel(effective.modelId(), settings);
        return new RuntimeContext(
                executionContext,
                effective.agentId(),
                // （子代理委派赖以解析的 lingxi.team_id 因此在新执行快照中不缺）；
                // 新会话此刻尚未绑定，本轮先按单 Agent / 裸模型跑。
                effectiveTeamId,
                session,
                messageList,
                spec,
                // 模型连接与识图声明来自同一份配置快照。
                runtimeModel.config(),
                mode,
                policy,
                effective.requirePlan(),
                // 用户消息此刻**还没有落库**：调用方先取运行资格，再调 commitUserMessage。
                userMessageEntity,
                runtimeModel.vision()
        );
    }

    /**
     * 把本轮用户消息写入 append-only transcript，并返回新建的业务轮次 ID。
     *
     * <p><b>为什么必须与 {@link #prepare} 分开：</b>「同一会话单飞」的运行资格校验必须先解析出
     * 会话（而解析就是 prepare 的职责），但校验本身可能失败。若在 prepare 里顺手写用户消息，
     * 就会出现「消息已经入库、执行却被拒绝」——用户看到自己发出去的话永远没有回复，
     * 也没有任何错误提示。因此约定：<b>prepare 只解析，调用方拿到运行资格后再调本方法</b>。</p>
     *
     * <p><b>执行行不在这里登记</b>：执行行由框架在受理事务内创建（见
     * {@code PreparedChatExecutor#admit}）—— 那一步需要编排器解析人设与工具清单，
     * 放在本类会构成 {@code RequestPreparer ↔ 编排器} 的循环依赖。</p>
     */
    @Transactional
    public Long commitUserMessage(RuntimeContext context) {
        return commitUserMessage(context, null, null);
    }

    /**
     * 带命令身份的提交：命令 ID 与请求摘要随轮次同事务落库。
     *
     * <p><b>为什么必须同事务</b>：命令身份是幂等判定的唯一依据。若轮次先落库、命令身份后补，
     * 两者之间进程崩溃会留下一条「没有 commandId 的已受理轮次」—— 重试查不回它，
     * 同一命令会被受理第二次，用户看到两条一样的提问。</p>
     *
     * <p>本方法须被受理事务包裹（{@code admit} 上的 {@code @Transactional}）：轮次与用户消息
     * 要么一起可见、要么都不可见，且与执行行同为一个事务。事务内不做任何模型调用。</p>
     *
     * @param commandId     命令受理身份；为 {@code null} 时与 {@link #commitUserMessage(RuntimeContext)} 完全等价
     * @param commandDigest 请求摘要
     */
    @Transactional
    public Long commitUserMessage(RuntimeContext context, String commandId, String commandDigest) {
        if (context == null || context.pendingUserMessage() == null) {
            return context == null ? null : context.turnId();
        }
        ExecutionContext executionContext = context.executionContext();
        Long executionId = ExecutionIdentity.numericOrNull(executionContext.executionId());
        if (executionId == null) {
            throw new IllegalStateException(
                    "缺少可落库的 executionId：执行身份必须在 prepare 阶段固化为雪花 ID");
        }

        ModelConfig modelConfig = context.modelConfig();
        String modelName = modelConfig == null ? null : modelConfig.getModelName();
        String modelProvider = modelConfig == null ? null : modelConfig.getProvider();

        long rootSessionId = executionContext.sessionId();
        long turnId = chatTurnService.acceptTurn(executionContext.sessionId(), rootSessionId, null, executionId,
                modelName, modelProvider, commandId, commandDigest);

        transcriptService.appendUser(executionContext.sessionId(), rootSessionId, turnId,
                context.pendingUserMessage());
        return turnId;
    }

    /**
     * 绑定有效 Agent 并回落模型：
     * <ul>
     *   <li>协作模式（会话绑定了团队且未显式指定 agent）：会话与执行都挂在指挥者名下，与首轮行为一致。
     *       入参是会话的团队绑定——聊天请求已不携带 teamId，因此「二次进入团队会话」
     *       必然走同一条指挥者回落链路。<b>模型强制指挥者预设</b>（agent 驱动，显式 modelId
     *       不参与）：否则指挥者的预设模型在协作链路上没有任何消费点（成员子执行各用各的预设、
     *       指挥者不能委派给自己），字段悬空误导用户；成员子执行仍各用各的预设
     *       （{@code SubAgentRequestFactory#resolveChildModel}）；</li>
     *   <li>单 Agent 直聊：显式 modelId 仍可覆盖 Agent 预设；未带 modelId 时用 Agent 预设。
     *       Agent 驱动的预设是硬约束：Agent 不存在、未绑定模型、绑定的模型已被删除都直接报错，
     *       不回落单例设置 —— 静默回落只会掩盖已经跑不起来的 Agent 配置；</li>
     *   <li>没指定 Agent 的非协作会话：模型用单例设置（user_configs.model_id），
     *       缺失由模型查询自行报错。</li>
     * </ul>
     */
    private ChatCommand effectiveCommand(ChatCommand command, SettingsView settings, Long effectiveTeamId) {
        Long agentId = command.agentId();
        boolean teamDriven = false;
        if (agentId == null && effectiveTeamId != null) {
            TeamVO team = teamService.findById(effectiveTeamId).getData();
            if (team == null) throw new ClientException("未找到指定的团队: " + effectiveTeamId);
            agentId = team.getCommanderAgentId();
            teamDriven = true;
        } else if (agentId == null && settings != null) {
            // 单例默认 Agent 只是协作身份：决定人设，不决定模型
            agentId = settings.agentId();
        }

        Long modelId = command.modelId();
        if (teamDriven) {
            modelId = requireAgentPresetModel(agentId);
        } else if (modelId == null && command.agentId() != null) {
            modelId = requireAgentPresetModel(command.agentId());
        } else if (modelId == null && settings != null) {
            modelId = settings.modelId();
        }
        if (Objects.equals(agentId, command.agentId()) && Objects.equals(modelId, command.modelId())) {
            return command;
        }
        return new ChatCommand(command.input(), command.sessionId(), modelId, command.workspaceId(),
                // messageId 必须原样带过去：重发要靠它定位被改写的那条提问，
                // 漏掉它这一路回落到「重发但不知道该重发哪条」，报错却是「消息标识不能为空」。
                command.messageId(),
                agentId, command.requirePlan(), command.imageFile(), command.imageUrl());
    }

    /**
     * Agent 驱动的预设模型解析（协作模式指挥者 / 显式选择的 Agent）。
     *
     * <p>agent.model_id 没有外键：删除模型不会级联清空引用，预设指向已删除模型是常态可能。
     * 三种坏形状（Agent 不存在 / 未绑定模型 / 预设已被删除）都直接报错 —— Agent 驱动模式下
     * 静默回落单例设置，等于用另一个模型冒充用户的 Agent 配置。</p>
     */
    private Long requireAgentPresetModel(Long agentId) {
        AgentVO agent = agentService.findById(agentId).getData();
        if (agent == null) throw new ClientException("未找到指定的 Agent: " + agentId);
        if (agent.getModelId() == null) {
            throw new ClientException("Agent「" + agent.getName() + "」未绑定基座模型，请先在「智能体」设置中为其选择模型");
        }
        try {
            if (modelService.findById(agent.getModelId()).getData() == null) {
                throw presetModelDeleted(agent);
            }
        } catch (ModelNoFoundException e) {
            throw presetModelDeleted(agent);
        }
        return agent.getModelId();
    }

    private static ClientException presetModelDeleted(AgentVO agent) {
        return new ClientException("Agent「" + agent.getName() + "」绑定的模型已被删除，请重新为其选择基座模型");
    }

    /**
     * 取会话；{@code sessionId} 为空表示「本次对话还没有会话」，由 {@link #prepare} 走创建分支，
     * 属于正常路径。非空但取不到（不存在）必须拒绝。
     */
    public SessionVO requireSession(Long sessionId) {
        if (sessionId == null || sessionId <= 0) return null;
        SessionVO session = sessionService.findById(sessionId).getData();
        if (session == null) throw new AccessDeniedException("会话不存在: " + sessionId);
        return session;
    }

    /** 取工作空间；不存在时拒绝。 */
    public @Nullable WorkspaceVO requireWorkspace(Long workspaceId) {
        if (workspaceId == null || workspaceId <= 0) return null;
        WorkspaceVO workspace = workspaceService.findById(workspaceId).getData();
        if (workspace == null) throw new AccessDeniedException("工作空间不存在: " + workspaceId);
        return workspace;
    }

    public AgentRequest buildRequest(String agentPrompt, RuntimeContext context, List<String> toolList) {
        return buildRequest(agentPrompt, context, toolList, false);
    }

    public AgentRequest buildRequest(String agentPrompt, RuntimeContext context, List<String> toolList, boolean defaultAgent) {
        // 执行身份在 prepare 阶段已生成（HC-2 执行链身份闭环）：用户消息、执行记录、
        // 框架执行实例共用同一个 executionId，不再在这里另生成一个。
        String executionId = context.executionContext().executionId();
        if (executionId == null || executionId.isBlank()) {
            throw new IllegalStateException("RuntimeContext 缺少 executionId：执行身份必须在 prepare 阶段固化");
        }

        // 请求级 MCP：每次执行重新读库组装，管理端改动下一轮即生效。
        // 无启用服务时为 null，框架侧按「无 MCP」处理，仍走 McpToolScope.EMPTY。
        McpConfig mcpConfig = mcpService.currentConfig();

        // Skill 根目录在启动时就绪（见 SkillRootResolver）；目录不可用时为 null，
        // 框架据此跳过 Skill 提示词段，read_skill 也不再下发。
        Path skillRoot = skillRootResolver.root();

        // 每轮读最新偏好；未设置时不创建配置，也不向提示词插入空段。
        PersonalizationVO personalization = personalizationRepository.findById(LocalInstance.SETTINGS_ROW_ID)
                .map(PersonalizationConvert::toVO).orElse(null);

        return AgentRequest
                .builder()
                .executionId(executionId)
                .messages(context.messageList())
                .systemPrompt(systemPromptBuilder.buildRootPrompt(agentPrompt, personalization))
                .workspaceSpec(context.workspace())
                .toolList(toolListProcessor.process(toolList, ToolProcessingContext.builder()
                        .defaultAgent(defaultAgent)
                        .agentId(context.agentId()).teamId(context.teamId()).vision(context.vision())
                        .accessMode(context.accessMode()).requirePlan(context.requirePlan())
                        .mcpConfig(mcpConfig).skillRoot(skillRoot).build()))
                .modelConfigSpec(runtimeConfigurations.freezeModel(context.executionContext().modelConfigId(), context.modelConfig()))
                .retryConfig(ModelRetryConfig.builder().enabled(true).build())
                .mcpConfigSpec(runtimeConfigurations.freezeMcp(mcpConfig))
                .skillConfig(skillRoot == null ? null : new SkillConfig(skillRoot))
                .runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(attributes(context.executionContext(), context))
                        .eventMetaData(executionEventMetadata(context))
                        .build())
                .build();
    }

    /**
     * 构造本次执行的完整事件归属：根会话、自身会话、轮次与历史代际。
     *
     * <p><b>为什么在此处读一次库</b>：historyRevision 是根会话的历史代际，只能从会话行取。
     * 这是设计允许的<b>低频冷路径</b>读 —— 只在请求准备（每个执行一次）发生，随执行检查点保存，
     * 事件端不再回查。根会话取不到时按代际 1 处理（会话默认值），因为拿不到代际不能阻塞受理。</p>
     *
     * <p>{@code parentTurnId} 恒为 {@code null}：普通用户提问不是任何轮次的子委派；子执行的
     * 归属由 {@code DelegationRecorder} 单独构造。</p>
     */
    private Map<String, Object> executionEventMetadata(RuntimeContext context) {
        ExecutionContext executionContext = context.executionContext();
        long sessionId = executionContext.sessionId();
        long rootSessionId = executionContext.rootSessionId();
        return ExecutionEventMetadata.of(rootSessionId, sessionId, context.turnId(), null,
                rootHistoryRevision(rootSessionId));
    }

    /**
     * 根会话的历史代际。
     *
     * <p>会话行缺失（刚建的会话尚未可见等异常）时回落到 1 —— 与 {@code Session} 的默认代际一致，
     * 不因一次旁路读失败而拒绝整个请求。</p>
     */
    private long rootHistoryRevision(long rootSessionId) {
        Session root = sessionRepository.findById(rootSessionId).orElse(null);
        Long revision = root == null ? null : root.getHistoryRevision();
        return revision == null || revision <= 0L ? 1L : revision;
    }

    public UserMessageEntity buildUserMessage(ChatCommand chatCommand) {
        List<Image> images = chatImageResolver.resolve(chatCommand.imageFile(), chatCommand.imageUrl());
        String input = chatCommand.input();
        if (!images.isEmpty()) {
            return UserMessageEntity.from(input, images);
        }
        return UserMessageEntity.from(input);
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
        attributes.put(ExecutionAttributes.MODEL_VISION, context.vision());
        return Map.copyOf(attributes);
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}
