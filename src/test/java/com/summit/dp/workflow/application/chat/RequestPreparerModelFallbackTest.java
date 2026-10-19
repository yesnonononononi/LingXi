package com.summit.dp.workflow.application.chat;

import com.summit.dp.execution.ExecutionAttributes;
import com.summit.core.agent.Execution;
import com.summit.core.agent.AgentRequest;
import java.util.List;

import com.summit.dp.tools.ToolListProcessorTestSupport;
import com.summit.dp.model.application.vo.RuntimeModel;
import com.summit.dp.agent.application.service.AgentService;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.mcp.application.service.McpService;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.model.domain.ModelNoFoundException;
import com.summit.dp.personalization.domain.repository.PersonalizationRepository;
import com.summit.dp.session.application.service.ConversationTranscriptService;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.application.service.SessionService;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.team.application.service.TeamService;
import com.summit.dp.team.application.vo.TeamVO;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.user_configs.application.service.SettingsProvider;
import com.summit.dp.user_configs.application.vo.SettingsView;
import com.summit.dp.workflow.infrastructure.policy.SkillRootResolver;
import com.summit.core.conf.ModelConfig;
import com.summit.ddd.application.vo.Result;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 模型选择规则的回落口径（2026-10-15 四轮对齐后的最终契约）：
 * <ul>
 *   <li>协作模式（团队会话）：<b>强制指挥者预设</b>（agent 驱动），显式 modelId 不参与 ——
 *       否则指挥者的预设模型在协作链路上没有任何消费点（成员子执行各用各的预设、
 *       指挥者不能委派给自己），字段悬空误导用户；</li>
 *   <li>单 Agent 直聊：显式 modelId 可覆盖 Agent 预设；未带时用 Agent 预设；</li>
 *   <li>Agent 驱动的预设是硬约束：Agent 不存在、未绑定模型、预设已被删除都直接报错（ClientException）；
 *       agent.model_id 没有外键，删除模型不会级联清空引用，「预设指向已删除模型」必须显式拦截；</li>
 *   <li>没指定 Agent 的非协作会话：模型用 user_configs 绑定值（单例默认 Agent 只决定人设，不决定模型）。</li>
 * </ul>
 */
class RequestPreparerModelFallbackTest {

    private static final long SESSION_ID = 500L;
    private static final long SETTINGS_MODEL_ID = 7L;
    private static final long AGENT_ID = 5L;
    private static final long AGENT_MODEL_ID = 9L;
    private static final long TEAM_ID = 3L;

    private final SessionService sessionService = mock(SessionService.class);
    private final SessionRepository sessionRepository = mock(SessionRepository.class);
    private final ModelService modelService = mock(ModelService.class);
    private final SettingsProvider settingsProvider = mock(SettingsProvider.class);
    private final ConversationTranscriptService transcriptService = mock(ConversationTranscriptService.class);
    private final ModelContextService modelContextService = mock(ModelContextService.class);
    private final ChatTurnService chatTurnService = mock(ChatTurnService.class);
    private final AgentService agentService = mock(AgentService.class);
    private final TeamService teamService = mock(TeamService.class);
    private final McpService mcpService = mock(McpService.class);

    private final RequestPreparer preparer = new RequestPreparer(sessionService, sessionRepository,
            mock(com.summit.dp.workspace.application.service.WorkspaceService.class), modelService,
            mock(com.summit.dp.workspace.application.convert.WorkspaceConverter.class),
            settingsProvider, ToolListProcessorTestSupport.create(),
            transcriptService, modelContextService,
            chatTurnService, agentService, teamService, mcpService, new SkillRootResolver(""),
            new ChatImageResolver(), new BusinessSystemPromptBuilder(""), mock(PersonalizationRepository.class));

    @BeforeEach
    void stubCommonPath() {
        // 单例设置绑定模型 7：没选 Agent 时它必须生效，即便别处还绑着别的模型
        when(settingsProvider.current()).thenReturn(Optional.of(
                new SettingsView(null, null, null, null, SETTINGS_MODEL_ID, null, null, null, null, 10)));
        when(sessionService.findById(SESSION_ID))
                .thenReturn(Result.success(SessionVO.builder().id(SESSION_ID).build()));
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(
                com.summit.dp.session.domain.model.Session.builder()
                        .id(SESSION_ID).rootSessionId(0L).historyRevision(1L).build()));
        when(modelContextService.find(SESSION_ID)).thenReturn(Optional.empty());
        when(mcpService.currentConfig()).thenReturn(null);
        // 每个模型 ID 一个可区分的实例，断言「实际用的是哪个模型」才不依赖桩的调用次数
        when(modelService.resolveRuntimeConfig(anyLong(), any()))
                .thenAnswer(inv -> new RuntimeModel(modelConfig(inv.getArgument(0)), false));
    }

    private static ModelConfig modelConfig(Long modelId) {
        return ModelConfig.builder().modelName("model-" + modelId).build();
    }

    private static ChatCommand command(Long modelId, Long agentId) {
        return new ChatCommand("你好", SESSION_ID, modelId, null, null, agentId, false, null, null);
    }

    @Test
    void rootVisionSurvivesAdmissionCopiesAndReachesTheToolGate() {
        ModelConfig connection = ModelConfig.builder().modelName("arbitrary-model").build();
        when(modelService.resolveRuntimeConfig(eq(SETTINGS_MODEL_ID), any())).thenReturn(new RuntimeModel(connection, true));
        RuntimeContext prepared = preparer.prepare(command(null, null));
        assertTrue(prepared.vision());
        RuntimeContext admitted = prepared.withTurnId(77L).withExecution(Execution.builder().id("execution")
                .agentId("test").agentRequest(AgentRequest.builder().build()).build());
        assertTrue(admitted.vision());
        AgentRequest request = preparer.buildRequest("", admitted, List.of(ToolCatalog.READ_FILE));
        assertTrue(request.getToolList().contains(ToolCatalog.READ_IMAGE));
        assertEquals(true, request.runtimeParametersOrDefault().getAttributes().get(ExecutionAttributes.MODEL_VISION));
    }

    private void stubAgent(Long agentId, Long presetModelId) {
        AgentVO agent = new AgentVO();
        agent.setId(agentId);
        agent.setModelId(presetModelId);
        when(agentService.findById(agentId)).thenReturn(Result.success(agent));
        // 预设模型存在性校验走 modelService.findById，有绑定时必须桩成「存在」，
        // 否则该桩缺省会返回 null，测试就变成在测 NPE 而不是在测规则
        if (presetModelId != null) {
            when(modelService.findById(presetModelId))
                    .thenReturn(Result.success(com.summit.dp.model.application.vo.ModelConfigVO.builder().build()));
        }
    }

    @Test
    @DisplayName("协作模式（团队会话）：强制指挥者预设驱动，显式 modelId 也不参与")
    void teamSessionUniformlyUsesCommanderPresetModel() {
        when(sessionService.findById(SESSION_ID)).thenReturn(Result.success(
                SessionVO.builder().id(SESSION_ID).teamId(TEAM_ID).build()));
        when(teamService.findById(TEAM_ID)).thenReturn(Result.success(
                TeamVO.builder().id(TEAM_ID).commanderAgentId(AGENT_ID).build()));
        stubAgent(AGENT_ID, AGENT_MODEL_ID);

        // 未带 modelId 与显式带 modelId 两种请求，根轮次都必须是指挥者预设
        RuntimeContext withoutExplicit = preparer.prepare(command(null, null));
        assertEquals("model-" + AGENT_MODEL_ID, withoutExplicit.modelConfig().getModelName());
        assertEquals(AGENT_MODEL_ID, withoutExplicit.executionContext().modelConfigId());
        RuntimeContext withExplicit = preparer.prepare(command(SETTINGS_MODEL_ID, null));
        assertEquals("model-" + AGENT_MODEL_ID, withExplicit.modelConfig().getModelName());
        verify(modelService, never()).resolveRuntimeConfig(eq(SETTINGS_MODEL_ID), any());
    }

    @Test
    @DisplayName("协作模式指挥者的预设模型已被删除：直接报错提醒，不静默回落")
    void commanderPresetModelDeletedFails() {
        when(sessionService.findById(SESSION_ID)).thenReturn(Result.success(
                SessionVO.builder().id(SESSION_ID).teamId(TEAM_ID).build()));
        when(teamService.findById(TEAM_ID)).thenReturn(Result.success(
                TeamVO.builder().id(TEAM_ID).commanderAgentId(AGENT_ID).build()));
        stubAgent(AGENT_ID, AGENT_MODEL_ID);
        // 模型表里已经没有 9 号：findById 返回空数据
        when(modelService.findById(AGENT_MODEL_ID)).thenReturn(Result.success(null));

        ClientException error = assertThrows(ClientException.class,
                () -> preparer.prepare(command(null, null)));
        assertTrue(error.getMessage().contains("已被删除"));
    }

    @Test
    @DisplayName("协作模式指挥者未绑定模型：硬约束直接报错，不回落 user_configs")
    void commanderWithoutPresetModelFails() {
        when(sessionService.findById(SESSION_ID)).thenReturn(Result.success(
                SessionVO.builder().id(SESSION_ID).teamId(TEAM_ID).build()));
        when(teamService.findById(TEAM_ID)).thenReturn(Result.success(
                TeamVO.builder().id(TEAM_ID).commanderAgentId(AGENT_ID).build()));
        stubAgent(AGENT_ID, null);

        ClientException error = assertThrows(ClientException.class,
                () -> preparer.prepare(command(null, null)));
        assertTrue(error.getMessage().contains("未绑定基座模型"));
    }

    @Test
    @DisplayName("没选 Agent + 单例绑了默认 Agent：模型仍用 user_configs 绑定值，不吃默认 Agent 预设")
    void defaultAgentPresetDoesNotHijackSettingsModel() {
        when(settingsProvider.current()).thenReturn(Optional.of(new SettingsView(
                null, null, null, null, SETTINGS_MODEL_ID, AGENT_ID, null, null, null, 10)));
        stubAgent(AGENT_ID, AGENT_MODEL_ID);

        RuntimeContext context = preparer.prepare(command(null, null));

        assertEquals("model-" + SETTINGS_MODEL_ID, context.modelConfig().getModelName());
        verify(modelService, never()).resolveRuntimeConfig(eq(AGENT_MODEL_ID), any());
    }

    @Test
    @DisplayName("单 Agent 直聊：模型用 Agent 表预设值，优先于 user_configs 绑定值")
    void explicitAgentUsesItsPresetModel() {
        stubAgent(AGENT_ID, AGENT_MODEL_ID);

        RuntimeContext context = preparer.prepare(command(null, AGENT_ID));

        assertEquals("model-" + AGENT_MODEL_ID, context.modelConfig().getModelName());
        assertEquals(AGENT_MODEL_ID, context.executionContext().modelConfigId());
        verify(modelService, never()).resolveRuntimeConfig(eq(SETTINGS_MODEL_ID), any());
    }

    @Test
    @DisplayName("显式选了 Agent 但未绑定模型：硬约束直接报错，不回落 user_configs")
    void explicitAgentWithoutPresetModelFails() {
        stubAgent(AGENT_ID, null);

        ClientException error = assertThrows(ClientException.class,
                () -> preparer.prepare(command(null, AGENT_ID)));
        assertTrue(error.getMessage().contains("未绑定基座模型"));
    }

    @Test
    @DisplayName("单 Agent 直聊的预设模型已被删除（模型服务抛未找到）：直接报错，不静默回落")
    void explicitAgentPresetModelDeletedFails() {
        stubAgent(AGENT_ID, AGENT_MODEL_ID);
        when(modelService.findById(AGENT_MODEL_ID)).thenThrow(new ModelNoFoundException());

        ClientException error = assertThrows(ClientException.class,
                () -> preparer.prepare(command(null, AGENT_ID)));
        assertTrue(error.getMessage().contains("已被删除"));
    }

    @Test
    @DisplayName("单 Agent 直聊：显式 modelId 最高优先，Agent 预设也不得覆盖")
    void explicitModelWinsOverAgentPreset() {
        stubAgent(AGENT_ID, AGENT_MODEL_ID);

        RuntimeContext context = preparer.prepare(command(SETTINGS_MODEL_ID, AGENT_ID));

        assertEquals("model-" + SETTINGS_MODEL_ID, context.modelConfig().getModelName());
        verify(modelService).resolveRuntimeConfig(eq(SETTINGS_MODEL_ID), any());
    }
}
