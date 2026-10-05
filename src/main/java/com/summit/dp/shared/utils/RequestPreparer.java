package com.summit.dp.shared.utils;

import cn.hutool.core.codec.Base64;
import cn.hutool.core.util.IdUtil;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.dp.execution.application.service.ExecutionRegistrationService;
import com.summit.dp.turn.application.service.ChatTurnService;
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
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
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
import org.springframework.transaction.annotation.Transactional;
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
    private final SessionRepository sessionRepository;
    private final WorkspaceService workspaceService;
    private final ModelService modelService;
    private final WorkspaceConverter workspaceConverter;
    private final SettingsProvider settingsProvider;
    private final ToolCatalog toolCatalog;
    private final ConversationTranscriptService transcriptService;
    private final ModelContextService modelContextService;
    private final ExecutionIdentity executionIdentity;
    private final ExecutionRegistrationService executionRegistrationService;
    private final ChatTurnService chatTurnService;
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
        WorkspaceSpec spec = workspaceConverter.toSpec(workspace, workspaceType);

        AgentAccessMode mode = AgentAccessMode.effective(
                settings == null ? null : settings.accessMode(), workspaceType);

        CommandApprovalPolicy policy = CommandApprovalPolicy.parse(
                settings == null ? null : settings.commandApprovalPolicy());

        // 模型上下文是可变的、也可能已被压缩；查不到上下文即视为新会话。
        // 只有展示用的 transcript 是只追加的，它任何时候都不会回喂给模型。
        UserMessageEntity userMessageEntity = buildUserMessage(effective);
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

        return new RuntimeContext(
                executionContext,
                effective.agentId(),
                // （子代理委派赖以解析的 lingxi.team_id 因此在新执行快照中不缺）；
                // 新会话此刻尚未绑定，本轮先按单 Agent / 裸模型跑。
                effectiveTeamId,
                session,
                messageList,
                spec,
                // 根任务保留显式模型、设置模型和 YAML 缺省的优先级。
                rootModel(effective.modelId(), settings),
                mode,
                policy,
                effective.requirePlan(),
                // 用户消息此刻**还没有落库**：调用方先取运行资格，再调 commitUserMessage。
                userMessageEntity
        );
    }

    /**
     * 把本轮用户消息写入 append-only transcript，并返回新建的业务轮次 ID；
     * 同时登记「初始执行」记录，使提问与执行从第一刻起共享同一个身份。
     *
     * <p><b>为什么必须与 {@link #prepare} 分开：</b>「同一会话单飞」的运行资格校验必须先解析出
     * 会话（而解析就是 prepare 的职责），但校验本身可能失败。若在 prepare 里顺手写用户消息，
     * 就会出现「消息已经入库、执行却被拒绝」——用户看到自己发出去的话永远没有回复，
     * 也没有任何错误提示。因此约定：<b>prepare 只解析，调用方拿到运行资格后再调本方法</b>。</p>
     *
     * <p><b>一个短事务</b>：执行行、业务轮次与用户消息要么一起可见，要么都不可见。
     * 事务内不做任何模型调用 —— 模型调用发生在后续的 loop 里，与本次提交无关。</p>
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

        executionRegistrationService.registerInitial(new ExecutionRegistrationService.InitialExecution(
                executionId,
                executionContext.sessionId(),
                // 主执行没有根执行归属（不写自身 id，避免与「未知」混淆）。
                ExecutionIdentity.numericOrNull(executionContext.rootExecutionId())));

        // 业务轮次：与用户消息、初始执行行同属一个短事务。
        // 「受理即落库」是本次改造的关键 —— 验收要求「只有 USER、没有 AI 回复的失败请求也要能
        // 看到执行状态」，而框架执行行在启动前根本不存在，只有业务自己的轮次能承载这个状态。
        // parentTurnId 为 null：普通用户提问不是任何轮次的子委派。
        //
        // 先建轮次再写消息，直接用 acceptTurn 返回的 turnId 作为消息归属 ——
        // 框架执行 ID 不进消息归属，它只留在 chat_turn.execution_id 上用于接收框架信号。
        // 根身份就是本会话自身：普通用户提问必然落在根会话上（子委派不走这里）。
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
     *   <li>team 模式（会话绑定了团队且未显式指定 agent）：会话与执行都挂在指挥者名下，与首轮行为一致。
     *       入参是会话的团队绑定——聊天请求已不携带 teamId，因此「二次进入团队会话」
     *       必然走同一条指挥者回落链路；</li>
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
                // messageId 必须原样带过去：重发要靠它定位被改写的那条提问，
                // 漏掉它这一路回落到「重发但不知道该重发哪条」，报错却是「消息标识不能为空」。
                command.messageId(),
                agentId, command.requirePlan(), command.imageFile(), command.imageUrl());
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
        // 执行身份在 prepare 阶段已生成（HC-2 执行链身份闭环）：用户消息、执行记录、
        // 框架执行实例共用同一个 executionId，不再在这里另生成一个。
        String executionId = context.executionContext().executionId();
        if (executionId == null || executionId.isBlank()) {
            throw new IllegalStateException("RuntimeContext 缺少 executionId：执行身份必须在 prepare 阶段固化");
        }

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
     * <p>框架语义：名单即授权，{@code null} 与空清单等价，都表示不暴露任何静态工具。</p>
     *
     * <p>业务语义：带了 {@code mcpConfig} 就兜底 {@link ToolCatalog#LIST_MCP_TOOLS} 与
     * {@link ToolCatalog#SEARCH_TOOL}。MCP 工具名要等握手后才存在，无法预先进清单；模型先用清单入口
     * 按服务名看清有哪些工具（不含 schema），再用检索入口取回 schema，取回后框架才把该工具放进
     * 下一轮可见清单（披露账本在框架侧 {@code McpToolScope}）。</p>
     *
     * <p>顺序固定为「收敛原清单 → 补两级入口与 requirePlan → 只读过滤 → 身份剔除」；只读滤网必须
     * 最后执行，否则 requirePlan 追加的工具会绕过滤网。</p>
     */
    private List<String> toolListOf(List<String> tools, RuntimeContext context, McpConfig mcpConfig) {
        final boolean readOnly = !context.accessMode().allowsWriteTools();

        List<String> result = new ArrayList<>(tools == null ? List.of() : tools);

        // MCP 在场时兜底两级入口：先按服务名清单（不带 schema），再按关键字检索（带 schema 并揭露）。
        if (mcpConfigured(mcpConfig)) {
            if (!result.contains(ToolCatalog.LIST_MCP_TOOLS)) {
                result.add(ToolCatalog.LIST_MCP_TOOLS);
            }
            if (!result.contains(ToolCatalog.SEARCH_TOOL)) {
                result.add(ToolCatalog.SEARCH_TOOL);
            }
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

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}
