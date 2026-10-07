package com.summit.dp.agent.application.service.impl;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.agent.infrastructure.workflow.AgentWorkflowOrchestrator;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.SessionAttributeRestorer;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.session.application.service.ConversationRollbackService;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.shared.utils.RequestPreparer;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 恢复链路的会话属性回归：{@code resume} 不经过 {@code RequestPreparer}，必须自己把会话行上的
 * 团队绑定补回执行请求，否则恢复后的 {@code call_sub_agent} 解析不到团队，子 Agent 起不来。
 *
 * <p>守卫的是「交给 loop 的那一个 Execution 实例」——{@code resume(String)} 会返回副本，
 * 所以断言必须落在 {@code ExecutionControl.resume(Execution)} 的实参上。</p>
 */
class ChatResumeTeamAttributeTest {

    private static final long SESSION_ID = 500L;
    private static final long TEAM_ID = 3L;
    private static final String EXECUTION_ID = "900";

    private final SseEventPublisher sseEventPublisher = mock(SseEventPublisher.class);
    private final RequestPreparer requestPreparer = mock(RequestPreparer.class);
    private final AgentWorkflowOrchestrator orchestrator = mock(AgentWorkflowOrchestrator.class);
    private final ExecutionControl executionControl = mock(ExecutionControl.class);
    private final ExecutionRepository executionRepository = mock(ExecutionRepository.class);
    private final SessionRepository sessionRepository = mock(SessionRepository.class);
    private final SessionExecutionRegistry sessionExecutionRegistry = mock(SessionExecutionRegistry.class);
    private final ModelContextService modelContextService = mock(ModelContextService.class);
    private final ExecutionIdentity executionIdentity = mock(ExecutionIdentity.class);
    private final ToolCallRepository toolCallRepository = mock(ToolCallRepository.class);

    private ChatServiceImpl service() {
        com.summit.dp.turn.application.service.ChatTurnService chatTurnService =
                mock(com.summit.dp.turn.application.service.ChatTurnService.class);
        return new ChatServiceImpl(sseEventPublisher, requestPreparer, executionControl,
                executionRepository, sessionRepository, sessionExecutionRegistry, modelContextService,
                executionIdentity, toolCallRepository,
                new SessionAttributeRestorer(sessionRepository),
                new PreparedChatExecutor(orchestrator, requestPreparer, modelContextService,
                        sessionExecutionRegistry, executionControl),
                chatTurnService,
                mock(com.summit.dp.execution.application.service.ExecutionQueryService.class),
                // 本测试只盯 resume 的属性补齐，重发链路用不到。
                mock(ResendTargetResolver.class), mock(ConversationRollbackService.class));
    }

    @Test
    @DisplayName("恢复时按会话行补齐 TEAM_ID：快照缺少团队属性也能让委派工具解析到团队")
    void resumeRestoresTeamIdFromSession() {
        Map<String, Object> snapshotAttributes = new HashMap<>();
        snapshotAttributes.put(ExecutionAttributes.SESSION_ID, String.valueOf(SESSION_ID));
        snapshotAttributes.put(ExecutionAttributes.AGENT_ID, "7");
        Execution execution = execution(snapshotAttributes);

        stubResume(execution, Session.builder()
                .id(SESSION_ID).rootSessionId(Session.ROOT_SESSION_ID).name("团队会话").teamId(TEAM_ID).build());

        service().resume(SESSION_ID);

        Execution handedToLoop = capturedResumeArgument();
        assertEquals(TEAM_ID, ExecutionAttributes.readLong(
                        handedToLoop.getAgentRequest().runtimeParametersOrDefault().getAttributes(),
                        ExecutionAttributes.TEAM_ID),
                "恢复交给 loop 的执行必须带上会话绑定的 teamId，否则 call_sub_agent 报「未确定当前协作团队」");
    }

    @Test
    @DisplayName("会话有团队时以库中记录为准：快照里的陈旧 teamId 被覆盖")
    void resumeOverwritesStaleSnapshotTeamId() {
        Map<String, Object> snapshotAttributes = new HashMap<>();
        snapshotAttributes.put(ExecutionAttributes.TEAM_ID, "99");
        Execution execution = execution(snapshotAttributes);

        stubResume(execution, Session.builder()
                .id(SESSION_ID).rootSessionId(Session.ROOT_SESSION_ID).name("团队会话").teamId(TEAM_ID).build());

        service().resume(SESSION_ID);

        assertEquals(TEAM_ID, ExecutionAttributes.readLong(
                        capturedResumeArgument().getAgentRequest().runtimeParametersOrDefault().getAttributes(),
                        ExecutionAttributes.TEAM_ID),
                "会话绑定创建后不可变，与 prepare 的「已有会话忽略请求值」同一口径");
    }

    @Test
    @DisplayName("非团队会话：不凭空制造团队身份")
    void resumeDoesNotInventTeamForNonTeamSession() {
        Map<String, Object> snapshotAttributes = new HashMap<>();
        snapshotAttributes.put(ExecutionAttributes.AGENT_ID, "7");
        Execution execution = execution(snapshotAttributes);

        stubResume(execution, Session.builder()
                .id(SESSION_ID).rootSessionId(Session.ROOT_SESSION_ID).name("直聊会话").teamId(null).build());

        service().resume(SESSION_ID);

        assertFalse(capturedResumeArgument().getAgentRequest().runtimeParametersOrDefault()
                        .getAttributes().containsKey(ExecutionAttributes.TEAM_ID),
                "会话没有团队就不写入 TEAM_ID");
    }

    @Test
    @DisplayName("解绑后恢复：快照里的旧团队被清除，不再按已解绑的团队委派")
    void resumeClearsTeamAttributeAfterUnbind() {
        Map<String, Object> snapshotAttributes = new HashMap<>();
        snapshotAttributes.put(ExecutionAttributes.TEAM_ID, "3");
        snapshotAttributes.put(ExecutionAttributes.AGENT_ID, "7");
        Execution execution = execution(snapshotAttributes);

        // 会话已解绑（库中 team_id 为 null），但快照里还留着换绑前的旧团队
        stubResume(execution, Session.builder()
                .id(SESSION_ID).rootSessionId(Session.ROOT_SESSION_ID).name("已解绑会话").teamId(null).build());

        service().resume(SESSION_ID);

        assertFalse(capturedResumeArgument().getAgentRequest().runtimeParametersOrDefault()
                        .getAttributes().containsKey(ExecutionAttributes.TEAM_ID),
                "解绑后恢复必须移除陈旧 TEAM_ID，否则仍会按旧团队委派");
    }

    @Test
    @DisplayName("子会话恢复：自身行不承载团队绑定，沿 root 链回落根会话的 teamId")
    void resumeRestoresTeamIdFromRootForSubSession() {
        long rootSessionId = 600L;
        Map<String, Object> snapshotAttributes = new HashMap<>();
        snapshotAttributes.put(ExecutionAttributes.SESSION_ID, String.valueOf(SESSION_ID));
        snapshotAttributes.put(ExecutionAttributes.AGENT_ID, "7");
        Execution execution = execution(snapshotAttributes);

        // 子会话行由委派落库，不带 teamId；根会话绑定了团队
        Session subSession = Session.builder()
                .id(SESSION_ID).rootSessionId(rootSessionId).name("子代理会话").teamId(null).build();
        Session rootSession = Session.builder()
                .id(rootSessionId).rootSessionId(Session.ROOT_SESSION_ID).name("团队会话").teamId(TEAM_ID).build();
        when(executionIdentity.latestSuspendedExecutionId(SESSION_ID)).thenReturn(EXECUTION_ID);
        when(toolCallRepository.listUnresolvedByExecutionId(Long.valueOf(EXECUTION_ID))).thenReturn(List.of());
        when(executionRepository.findById(EXECUTION_ID)).thenReturn(Optional.of(execution));
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(subSession));
        when(sessionRepository.findById(rootSessionId)).thenReturn(Optional.of(rootSession));
        when(executionControl.resume(any(Execution.class))).thenReturn(execution);

        service().resume(SESSION_ID);

        assertEquals(TEAM_ID, ExecutionAttributes.readLong(
                        capturedResumeArgument().getAgentRequest().runtimeParametersOrDefault().getAttributes(),
                        ExecutionAttributes.TEAM_ID),
                "子会话审批恢复必须保住快照里的 TEAM_ID（回落根会话），否则恢复后二次委派/发邮件失效");
    }

    @Test
    @DisplayName("子会话恢复：根会话也未绑定团队时，快照里的陈旧 TEAM_ID 被清除")
    void resumeClearsTeamAttributeWhenRootChainUnbound() {
        long rootSessionId = 600L;
        Map<String, Object> snapshotAttributes = new HashMap<>();
        snapshotAttributes.put(ExecutionAttributes.TEAM_ID, "3");
        snapshotAttributes.put(ExecutionAttributes.AGENT_ID, "7");
        Execution execution = execution(snapshotAttributes);

        Session subSession = Session.builder()
                .id(SESSION_ID).rootSessionId(rootSessionId).name("子代理会话").teamId(null).build();
        Session rootSession = Session.builder()
                .id(rootSessionId).rootSessionId(Session.ROOT_SESSION_ID).name("直聊会话").teamId(null).build();
        when(executionIdentity.latestSuspendedExecutionId(SESSION_ID)).thenReturn(EXECUTION_ID);
        when(toolCallRepository.listUnresolvedByExecutionId(Long.valueOf(EXECUTION_ID))).thenReturn(List.of());
        when(executionRepository.findById(EXECUTION_ID)).thenReturn(Optional.of(execution));
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(subSession));
        when(sessionRepository.findById(rootSessionId)).thenReturn(Optional.of(rootSession));
        when(executionControl.resume(any(Execution.class))).thenReturn(execution);

        service().resume(SESSION_ID);

        assertFalse(capturedResumeArgument().getAgentRequest().runtimeParametersOrDefault()
                        .getAttributes().containsKey(ExecutionAttributes.TEAM_ID),
                "全链无团队绑定就必须移除 TEAM_ID，不得凭空保留");
    }

    private void stubResume(Execution execution, Session session) {
        when(executionIdentity.latestSuspendedExecutionId(SESSION_ID)).thenReturn(EXECUTION_ID);
        when(toolCallRepository.listUnresolvedByExecutionId(Long.valueOf(EXECUTION_ID))).thenReturn(List.of());
        when(executionRepository.findById(EXECUTION_ID)).thenReturn(Optional.of(execution));
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(session));
        when(executionControl.resume(any(Execution.class))).thenReturn(execution);
    }

    private Execution capturedResumeArgument() {
        ArgumentCaptor<Execution> captor = ArgumentCaptor.forClass(Execution.class);
        verify(executionControl).resume(captor.capture());
        return captor.getValue();
    }

    private static Execution execution(Map<String, Object> attributes) {
        AgentRequest request = AgentRequest.builder().executionId(EXECUTION_ID)
                .messages(List.of(UserMessageEntity.from("hi")))
                .runtimeParameters(AgentRuntimeParameters.builder().attributes(attributes).build())
                .build();
        return Execution.builder().id(EXECUTION_ID).agentId("chatAgent").agentRequest(request)
                .executionState(ExecutionState.SUSPENDED)
                .messages(new ArrayList<>(List.of(UserMessageEntity.from("hi"))))
                .build();
    }
}
