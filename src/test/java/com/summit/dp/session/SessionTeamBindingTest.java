package com.summit.dp.session;

import com.summit.core.conf.ModelConfig;
import com.summit.core.agent.AgentRequest;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.agent.application.command.ChatCommand;
import com.summit.dp.agent.application.service.AgentService;
import com.summit.dp.agent.application.service.impl.RuntimeContext;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.session.application.service.ConversationTranscriptService;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.application.service.SessionService;
import com.summit.dp.shared.utils.RequestPreparer;
import com.summit.dp.shared.context.SettingsView;
import com.summit.dp.shared.settings.SettingsProvider;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.team.application.service.TeamService;
import com.summit.dp.team.application.vo.TeamVO;
import com.summit.dp.workspace.application.convert.WorkspaceConverter;
import com.summit.dp.workspace.application.service.WorkspaceService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 团队绑定的会话级回落回归：team_id 首轮随会话落库，此后已有会话一律以库中记录为准
 * （请求值忽略），且指挥者 / 模型回落链路与首轮完全一致。
 */
class SessionTeamBindingTest {

    private final SessionService sessionService = mock(SessionService.class);
    private final WorkspaceService workspaceService = mock(WorkspaceService.class);
    private final ModelService modelService = mock(ModelService.class);
    private final WorkspaceConverter workspaceConverter = mock(WorkspaceConverter.class);
    private final ConversationTranscriptService transcriptService = mock(ConversationTranscriptService.class);
    private final ModelContextService modelContextService = mock(ModelContextService.class);
    private final AgentService agentService = mock(AgentService.class);
    private final TeamService teamService = mock(TeamService.class);
    private final SettingsProvider settingsProvider = mock(SettingsProvider.class);

    private final RequestPreparer preparer = new RequestPreparer(sessionService, workspaceService,
            modelService, workspaceConverter, settingsProvider,
            mock(com.summit.dp.shared.model.ToolCatalog.class), transcriptService, modelContextService,
            mock(ExecutionIdentity.class), agentService, teamService,
            mock(com.summit.dp.mcp.application.service.McpService.class));

    private static final long SESSION_ID = 500L;
    private static final long TEAM_ID = 3L;
    private static final long COMMANDER_AGENT_ID = 7L;

    private SessionTeamBindingTest stubTeam(long teamId, long commanderAgentId) {
        TeamVO team = TeamVO.builder().id(teamId).name("主理人团队").commanderAgentId(commanderAgentId).build();
        when(teamService.findById(teamId)).thenReturn(com.summit.ddd.application.vo.Result.success(team));
        return this;
    }

    private static SessionVO boundSession(Long teamId) {
        return SessionVO.builder().id(SESSION_ID).name("团队会话")
                .rootSessionId(0L).workspaceId(null).teamId(teamId).build();
    }

    private void stubPrepareHappyPath() {
        when(modelContextService.find(SESSION_ID)).thenReturn(Optional.empty());
        when(modelService.runtimeConfig(anyLong(), any())).thenReturn(
                ModelConfig.builder().baseUrl("https://example.invalid").apiKey("test-key")
                        .modelName("test-model").build());
    }

    private RequestPreparer preparer() {
        // SYSTEM_PROMPT 字段为 @Value 注入，单测中显式置空，避免 NPE。
        ReflectionTestUtils.setField(preparer, "SYSTEM_PROMPT", "");
        return preparer;
    }

    @Test
    @DisplayName("已有团队会话请求不带 teamId：团队绑定回落自库，指挥者/模型照常回落")
    void existingSessionFallsBackToPersistedTeam() {
        stubTeam(TEAM_ID, COMMANDER_AGENT_ID).stubPrepareHappyPath();
        when(sessionService.findById(SESSION_ID))
                .thenReturn(com.summit.ddd.application.vo.Result.success(boundSession(TEAM_ID)));
        AgentVO commander = new AgentVO();
        commander.setId(COMMANDER_AGENT_ID);
        commander.setModelId(99L);
        when(agentService.findById(COMMANDER_AGENT_ID))
                .thenReturn(com.summit.ddd.application.vo.Result.success(commander));

        RuntimeContext context = preparer().prepare(
                new ChatCommand("继续委派", SESSION_ID, null, null, null, null, false, null, null));

        assertEquals(TEAM_ID, context.teamId(), "团队绑定来自库中记录");
        assertEquals(COMMANDER_AGENT_ID, context.agentId(), "指挥者回落链路与首轮一致");
        verify(teamService).findById(TEAM_ID);
        verify(sessionService, never()).initialize(anyString(), any(), any());
    }

    @Test
    @DisplayName("已有团队会话请求带不同 teamId：忽略请求值，以库为准")
    void existingSessionIgnoresRequestTeamId() {
        stubTeam(TEAM_ID, COMMANDER_AGENT_ID).stubPrepareHappyPath();
        when(sessionService.findById(SESSION_ID))
                .thenReturn(com.summit.ddd.application.vo.Result.success(boundSession(TEAM_ID)));
        AgentVO commander = new AgentVO();
        commander.setId(COMMANDER_AGENT_ID);
        commander.setModelId(99L);
        when(agentService.findById(COMMANDER_AGENT_ID))
                .thenReturn(com.summit.ddd.application.vo.Result.success(commander));

        RuntimeContext context = preparer().prepare(
                new ChatCommand("继续委派", SESSION_ID, null, null, 9L, null, false, null, null));

        assertEquals(TEAM_ID, context.teamId(), "请求值不覆盖库中绑定");
        verify(teamService, never()).findById(9L);
        verify(teamService).findById(TEAM_ID);
    }

    @Test
    @DisplayName("新会话带 teamId：首轮写入团队绑定")
    void newSessionBindsTeamOnCreation() {
        stubPrepareHappyPath();
        when(sessionService.findById(SESSION_ID))
                .thenReturn(com.summit.ddd.application.vo.Result.success(boundSession(TEAM_ID)));
        when(sessionService.initialize(anyString(), isNull(), eq(TEAM_ID)))
                .thenReturn(com.summit.ddd.application.vo.Result.success(SESSION_ID));
        stubTeam(TEAM_ID, COMMANDER_AGENT_ID);
        AgentVO commander = new AgentVO();
        commander.setId(COMMANDER_AGENT_ID);
        commander.setModelId(99L);
        when(agentService.findById(COMMANDER_AGENT_ID))
                .thenReturn(com.summit.ddd.application.vo.Result.success(commander));

        RuntimeContext context = preparer().prepare(
                new ChatCommand("开始委派", null, null, null, TEAM_ID, null, false, null, null));

        assertEquals(TEAM_ID, context.teamId());
        verify(sessionService).initialize(anyString(), isNull(), eq(TEAM_ID));
    }

    @Test
    @DisplayName("非团队会话（库中 teamId 为 null）：不触发指挥者回落，teamId 输出 null")
    void unboundSessionSkipsTeamFallback() {
        stubPrepareHappyPath();
        when(sessionService.findById(SESSION_ID))
                .thenReturn(com.summit.ddd.application.vo.Result.success(boundSession(null)));
        AgentVO solo = new AgentVO();
        solo.setId(5L);
        solo.setModelId(88L);
        when(agentService.findById(5L))
                .thenReturn(com.summit.ddd.application.vo.Result.success(solo));

        RuntimeContext context = preparer().prepare(
                new ChatCommand("普通直聊", SESSION_ID, null, null, null, 5L, false, null, null));

        assertNull(context.teamId());
        assertEquals(5L, context.agentId());
        verify(teamService, never()).findById(any());
    }

    @Test
    @DisplayName("请求未指定 Agent 时使用全局选择，并把身份传给执行循环")
    void selectedAgentFlowsToExecutionAttributes() {
        stubPrepareHappyPath();
        when(sessionService.findById(SESSION_ID))
                .thenReturn(com.summit.ddd.application.vo.Result.success(boundSession(null)));
        when(settingsProvider.current()).thenReturn(Optional.of(settingsWithAgent(5L)));
        AgentVO selected = new AgentVO();
        selected.setId(5L);
        selected.setModelId(88L);
        when(agentService.findById(5L))
                .thenReturn(com.summit.ddd.application.vo.Result.success(selected));

        RuntimeContext context = preparer().prepare(
                new ChatCommand("普通直聊", SESSION_ID, null, null, null, null, false, null, null));
        AgentRequest request = preparer().buildRequest("Agent prompt", context, null);

        assertEquals(5L, context.agentId());
        assertEquals("5", request.runtimeParametersOrDefault().getAttributes().get(ExecutionAttributes.AGENT_ID));
    }

    @Test
    @DisplayName("显式 Agent 优先于全局选择")
    void explicitAgentOverridesSelectedAgent() {
        stubPrepareHappyPath();
        when(sessionService.findById(SESSION_ID))
                .thenReturn(com.summit.ddd.application.vo.Result.success(boundSession(null)));
        when(settingsProvider.current()).thenReturn(Optional.of(settingsWithAgent(5L)));
        AgentVO explicit = new AgentVO();
        explicit.setId(9L);
        explicit.setModelId(88L);
        when(agentService.findById(9L))
                .thenReturn(com.summit.ddd.application.vo.Result.success(explicit));

        RuntimeContext context = preparer().prepare(
                new ChatCommand("指定角色", SESSION_ID, null, null, null, 9L, false, null, null));

        assertEquals(9L, context.agentId());
        verify(agentService, never()).findById(5L);
    }

    @Test
    @DisplayName("无请求和全局 Agent 时保留裸模型模式")
    void noSelectedAgentKeepsDefaultMode() {
        stubPrepareHappyPath();
        when(sessionService.findById(SESSION_ID))
                .thenReturn(com.summit.ddd.application.vo.Result.success(boundSession(null)));
        when(settingsProvider.current()).thenReturn(Optional.of(settingsWithAgent(null)));

        RuntimeContext context = preparer().prepare(
                new ChatCommand("裸模型", SESSION_ID, 99L, null, null, null, false, null, null));
        AgentRequest request = preparer().buildRequest("", context, null);

        assertNull(context.agentId());
        assertEquals(false, request.runtimeParametersOrDefault().getAttributes()
                .containsKey(ExecutionAttributes.AGENT_ID));
    }

    private static SettingsView settingsWithAgent(Long agentId) {
        return new SettingsView(null, null, null, null, null, agentId, null, null);
    }
}
