package com.summit.dp.shared.utils;

import com.summit.core.agent.AgentRequest;
import com.summit.core.conf.ModelConfig;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.command.ChatCommand;
import com.summit.dp.agent.application.service.impl.RuntimeContext;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.application.service.ExecutionRegistrationService;
import com.summit.dp.session.application.service.ConversationTranscriptService;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.shared.config.workflow.AgentAccessMode;
import com.summit.dp.shared.config.workflow.CommandApprovalPolicy;
import com.summit.dp.shared.context.ExecutionContext;
import com.summit.dp.shared.model.ToolCatalog;
import com.summit.dp.shared.settings.SettingsProvider;
import com.summit.dp.shared.vo.SessionVO;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 执行身份在 prepare 阶段固化、并由 commitUserMessage 一次落库（2026-09-30 改造）。
 *
 * <p>钉住三条契约：</p>
 * <ol>
 *   <li>prepare 只解析，<b>不写任何消息副作用</b>（否则并发被拒时会留下无回复的孤行）；</li>
 *   <li>commitUserMessage 让「执行行」与「用户消息」共享同一个 executionId，模型快照取实际解析后的配置；</li>
 *   <li>buildRequest <b>复用</b>这个身份，缺身份时直接失败，而不是悄悄另造一个。</li>
 * </ol>
 */
class RequestPreparerExecutionIdentityTest {

    private static final long SESSION_ID = 500L;
    private static final long MODEL_ID = 7L;

    private final com.summit.dp.session.application.service.SessionService sessionService =
            mock(com.summit.dp.session.application.service.SessionService.class);
    private final com.summit.dp.workspace.application.service.WorkspaceService workspaceService =
            mock(com.summit.dp.workspace.application.service.WorkspaceService.class);
    private final com.summit.dp.model.application.service.ModelService modelService =
            mock(com.summit.dp.model.application.service.ModelService.class);
    private final com.summit.dp.workspace.application.convert.WorkspaceConverter workspaceConverter =
            mock(com.summit.dp.workspace.application.convert.WorkspaceConverter.class);
    private final SettingsProvider settingsProvider = mock(SettingsProvider.class);
    private final ToolCatalog toolCatalog = mock(ToolCatalog.class);
    private final ConversationTranscriptService transcriptService = mock(ConversationTranscriptService.class);
    private final ModelContextService modelContextService = mock(ModelContextService.class);
    private final ExecutionIdentity executionIdentity = mock(ExecutionIdentity.class);
    private final ExecutionRegistrationService registrationService = mock(ExecutionRegistrationService.class);
    private final com.summit.dp.turn.application.service.ChatTurnService chatTurnService =
            mock(com.summit.dp.turn.application.service.ChatTurnService.class);
    private final com.summit.dp.agent.application.service.AgentService agentService =
            mock(com.summit.dp.agent.application.service.AgentService.class);
    private final com.summit.dp.team.application.service.TeamService teamService =
            mock(com.summit.dp.team.application.service.TeamService.class);
    private final com.summit.dp.mcp.application.service.McpService mcpService =
            mock(com.summit.dp.mcp.application.service.McpService.class);

    private final com.summit.dp.session.domain.repo.SessionRepository sessionRepository =
            mock(com.summit.dp.session.domain.repo.SessionRepository.class);

    private final RequestPreparer preparer = new RequestPreparer(sessionService, sessionRepository,
            workspaceService, modelService, workspaceConverter, settingsProvider, toolCatalog,
            transcriptService, modelContextService, executionIdentity, registrationService,
            chatTurnService, agentService, teamService, mcpService);

    @BeforeEach
    void stubHappyPath() {
        // SYSTEM_PROMPT 字段为 @Value 注入，单测中显式置空，避免 NPE。
        ReflectionTestUtils.setField(preparer, "SYSTEM_PROMPT", "");
        when(settingsProvider.current()).thenReturn(Optional.empty());
        when(sessionService.findById(SESSION_ID))
                .thenReturn(Result.success(SessionVO.builder().id(SESSION_ID).build()));
        // 根会话行用于取历史代际；当前会话即根会话。
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(com.summit.dp.session.domain.model.Session
                .builder().id(SESSION_ID).rootSessionId(0L).historyRevision(3L).build()));
        when(modelService.runtimeConfig(eq(MODEL_ID), any())).thenReturn(ModelConfig.builder()
                .baseUrl("https://example.invalid").apiKey("secret-key")
                .modelName("deepseek-chat").provider("deepseek").build());
        when(modelContextService.find(SESSION_ID)).thenReturn(Optional.empty());
        when(mcpService.currentConfig()).thenReturn(null);
        when(workspaceConverter.toSpec(any(com.summit.dp.shared.vo.WorkspaceVO.class),
                any(com.summit.dp.shared.model.WorkspaceType.class))).thenReturn(null);
        when(toolCatalog.names()).thenReturn(java.util.Set.of());
        when(toolCatalog.readOnlyNames()).thenReturn(java.util.Set.of());
    }

    private static ChatCommand command() {
        return new ChatCommand("你好", SESSION_ID, MODEL_ID, null, null, null, false, null, null);
    }

    @Test
    @DisplayName("prepare 只解析：固化执行身份，但不写任何消息副作用")
    void prepareResolvesWithoutWritingMessages() {
        RuntimeContext context = preparer.prepare(command());

        assertNotNull(context.executionContext().executionId(), "执行身份必须在 prepare 阶段固化为雪花 ID");
        assertEquals(SESSION_ID, context.executionContext().sessionId());
        assertNotNull(context.pendingUserMessage(), "用户消息已解析，但此刻还没落库");
        assertEquals("你好", context.pendingUserMessage().text());

        // 关键：解析阶段不得产生「请求已被接受」的副作用 —— 用户消息、执行行、业务轮次都不许落库。
        verifyNoInteractions(transcriptService);
        verifyNoInteractions(registrationService);
        verifyNoInteractions(chatTurnService);
    }

    @Test
    @DisplayName("commitUserMessage：执行行与用户消息同一事务落库；消息归属用 acceptTurn 返回的轮次 ID")
    void commitWritesExecutionRowAndUserMessageUnderSameIdentity() {
        RuntimeContext context = preparer.prepare(command());
        long executionId = Long.parseLong(context.executionContext().executionId());
        long turnId = 9001L;
        // 受理入口内部统一走带命令身份的重载（无命令身份时传 null/null），
        // 桩与断言都要落在同一层，否则桩挂在一个没人调的方法上。
        when(chatTurnService.acceptTurn(anyLong(), any(), any(), any(), any(), any(), any(), any()))
                .thenReturn(turnId);

        Long acceptedTurnId = preparer.commitUserMessage(context);
        assertEquals(turnId, acceptedTurnId);
        AgentRequest request = preparer.buildRequest("prompt", context.withTurnId(acceptedTurnId), List.of());
        // 完整身份：根会话、会话、轮次与历史代际；来源是 prepare 阶段的一次冷路径读，不含 parentTurnId。
        assertEquals(Map.of(
                        "rootSessionId", Long.toString(SESSION_ID),
                        "sessionId", Long.toString(SESSION_ID),
                        "turnId", Long.toString(turnId),
                        "historyRevision", "3"),
                request.runtimeParametersOrDefault().getEventMetaData());
        verify(chatTurnService, never()).findByExecutionId(any());

        ArgumentCaptor<ExecutionRegistrationService.InitialExecution> registration =
                ArgumentCaptor.forClass(ExecutionRegistrationService.InitialExecution.class);
        verify(registrationService).registerInitial(registration.capture());
        assertEquals(executionId, registration.getValue().executionId());
        assertEquals(SESSION_ID, registration.getValue().sessionId());
        assertNull(registration.getValue().rootExecutionId(), "主执行没有根执行归属");

        // 模型快照不进执行行（execution 不再保存业务事实），而是落到轮次上：
        // 下面 acceptTurn 的断言才是模型名的落点，二者口径必须一致。
        verify(chatTurnService).acceptTurn(SESSION_ID, SESSION_ID, null, executionId, "deepseek-chat", "deepseek", null, null);
        // 消息归属是**轮次 ID**，不是执行 ID —— 框架执行 ID 不进入消息归属。
        verify(transcriptService).appendUser(SESSION_ID, SESSION_ID, turnId, context.pendingUserMessage());
    }

    @Test
    @DisplayName("同一身份贯穿到框架请求：buildRequest 复用 prepare 固化的 executionId")
    void buildRequestReusesPreparedExecutionId() {
        RuntimeContext context = preparer.prepare(command());

        AgentRequest request = preparer.buildRequest("prompt", context, List.of());

        assertEquals(context.executionContext().executionId(), request.getExecutionId());
    }

    @Test
    @DisplayName("执行身份缺失时直接失败：不悄悄另造一个（否则消息与执行会对不上）")
    void buildRequestRejectsMissingExecutionId() {
        ExecutionContext identity = ExecutionContext.root(SESSION_ID, null, null, MODEL_ID,
                AgentAccessMode.IN_WORKSPACE, CommandApprovalPolicy.FULL_ACCESS);
        RuntimeContext context = new RuntimeContext(identity, null, null,
                SessionVO.builder().id(SESSION_ID).build(), List.of(), null, null,
                AgentAccessMode.IN_WORKSPACE, CommandApprovalPolicy.FULL_ACCESS, false, null);

        assertThrows(IllegalStateException.class, () -> preparer.buildRequest("prompt", context, List.of()));
    }

    @Test
    @DisplayName("没有待落库消息时 commitUserMessage 是空操作（不产生半条记录）")
    void commitIsNoopWithoutPendingMessage() {
        RuntimeContext context = preparer.prepare(command());
        RuntimeContext withoutPending = new RuntimeContext(context.executionContext(), context.agentId(),
                context.teamId(), context.session(), context.messageList(), context.workspace(),
                context.modelConfig(), context.accessMode(), context.commandApprovalPolicy(),
                context.requirePlan(), null);

        preparer.commitUserMessage(withoutPending);

        verifyNoInteractions(registrationService);
        verifyNoInteractions(transcriptService);
        verifyNoInteractions(chatTurnService);
    }
}
