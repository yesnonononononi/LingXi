package com.summit.dp.workflow.application.chat;

import com.summit.dp.agent.application.service.AgentService;
import com.summit.dp.execution.RuntimeConfigurationTestSupport;
import com.summit.dp.mcp.application.service.McpService;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.model.application.vo.RuntimeModel;
import com.summit.dp.personalization.domain.repository.PersonalizationRepository;
import com.summit.dp.session.application.service.ConversationTranscriptService;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.application.service.SessionService;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.team.application.service.TeamService;
import com.summit.dp.tools.ToolListProcessorTestSupport;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.user_configs.application.service.SettingsProvider;
import com.summit.dp.user_configs.application.vo.SettingsView;
import com.summit.dp.workflow.infrastructure.policy.SkillRootResolver;
import com.summit.ddd.application.vo.Result;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 「设置行 → 本轮请求」的传递契约。
 *
 * <p>模型连接参数由 {@link RequestPreparer} 从单例设置解析，一旦有人把 settings 传空、
 * 改读 yaml 缺省，或换了别的快照来源，思考强度与 token 上限都会静默失效 —— 前端滑杆照样
 * 能拖能存，用户看不出任何异常，回归测试也不会响（这是本类存在的唯一理由）。</p>
 */
class RequestPreparerSettingsPropagationTest {

    private static final long SESSION_ID = 500L;
    private static final long SETTINGS_MODEL_ID = 7L;

    private final SessionService sessionService = mock(SessionService.class);
    private final SessionRepository sessionRepository = mock(SessionRepository.class);
    private final ModelService modelService = mock(ModelService.class);
    private final SettingsProvider settingsProvider = mock(SettingsProvider.class);
    private final ModelContextService modelContextService = mock(ModelContextService.class);
    private final McpService mcpService = mock(McpService.class);

    private final RequestPreparer preparer = new RequestPreparer(sessionService, sessionRepository,
            mock(com.summit.dp.workspace.application.service.WorkspaceService.class), modelService,
            mock(com.summit.dp.workspace.application.convert.WorkspaceConverter.class),
            settingsProvider, ToolListProcessorTestSupport.create(),
            mock(ConversationTranscriptService.class), modelContextService,
            mock(ChatTurnService.class), mock(AgentService.class), mock(TeamService.class), mcpService,
            new SkillRootResolver(""), new ChatImageResolver(), new BusinessSystemPromptBuilder(""),
            mock(PersonalizationRepository.class), RuntimeConfigurationTestSupport.create());

    @BeforeEach
    void stubSingleSession() {
        when(sessionService.findById(SESSION_ID))
                .thenReturn(Result.success(SessionVO.builder().id(SESSION_ID).build()));
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(
                com.summit.dp.session.domain.model.Session.builder()
                        .id(SESSION_ID).rootSessionId(0L).historyRevision(1L).build()));
        // 查不到模型上下文即视为新会话，消息基线为空。
        when(modelContextService.find(SESSION_ID)).thenReturn(Optional.empty());
        when(mcpService.currentConfig()).thenReturn(null);
    }

    @Test
    @DisplayName("设置行的思考强度与 token 上限原样进入本轮模型配置")
    void settingsEffortAndMaxTokensReachTurnModelConfig() {
        when(settingsProvider.current()).thenReturn(Optional.of(
                new SettingsView(null, null, null, null, SETTINGS_MODEL_ID, null, 4096, "high", null, 10)));
        AtomicReference<SettingsView> handed = new AtomicReference<>();
        // 与 ModelServiceImpl 同形：连接参数与能力声明来自同一次设置读取
        when(modelService.resolveRuntimeConfig(anyLong(), any())).thenAnswer(invocation -> {
            SettingsView settings = invocation.getArgument(1);
            handed.set(settings);
            return RuntimeModel.create("https://example.invalid/v1", "test-key",
                    "model-" + invocation.getArgument(0), null, false, settings, Duration.ofSeconds(60));
        });

        RuntimeContext context = preparer.prepare(new ChatCommand("你好", SESSION_ID, null, null, null, null, false, null, null));

        assertEquals("high", handed.get() == null ? null : handed.get().reasoningEffort());
        assertEquals("high", context.modelConfig().getReasoningEffort());
        assertEquals(4096, context.modelConfig().getMaxTokens());
    }
}
